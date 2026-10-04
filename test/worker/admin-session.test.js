import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';

// The console has three states - a login session, the ADMIN_TOKEN, or neither - and the interesting
// properties are all about who is *not* allowed in: a player who is not an operator, an operator whose
// session is too old to change anything, and a session trying to grant itself more access.
const TOKEN = 'admin-session-token-0123456789abcdef';
const ORIGIN = 'https://game.example';
const PASSWORD = 'a-long-enough-secret';
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

async function harness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-admin-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundlePath });
  // The production Worker, with a fixture route that plants a session with a chosen createdAt so the
  // "logged in a long time ago" path is reachable without waiting twelve hours.
  const source = `
    import worker,{SiteDirectory,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive}
      from ${JSON.stringify(bundlePath.replaceAll('\\', '/'))};
    export {SiteDirectory as TestObject,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive};
    export default { async fetch(request, env) {
      const input = await request.json();
      if (input.path === '/_plant') {
        try {
          await env.SITES.get(env.SITES.idFromName('directory')).saveSession(input.body.key, input.body.value);
          return Response.json({ ok: true });
        } catch (e) {
          // A fixture that fails silently is worse than one that says why.
          return Response.json({ error: String(e && e.message || e) }, { status: 500 });
        }
      }
      // Build the Request here: a browser sends Origin and the session cookie, and both are part of what
      // these tests verify.
      const headers = new Headers({ Origin: ${JSON.stringify(ORIGIN)}, ...(input.headers || {}) });
      if (input.cookie) headers.set('cookie', input.cookie);
      return worker.fetch(new Request(${JSON.stringify(ORIGIN)} + input.path, {
        method: input.method || 'GET', headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      }), env);
    } };
  `;
  const h = await createAccountHarness(source, {
    durableObjects: Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'],
      ['ROOMS', 'RoomDurableObject'], ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']]
      .map(([key, className]) => [key, { className, useSQLite: true }])),
    bindings: { ADMIN_TOKEN: TOKEN },
  });
  t.after(() => h.dispose());
  const call = (path, options = {}) => h.fetch({ path, method: options.method || 'GET',
    headers: options.headers, cookie: options.cookie, body: options.body });
  // The cookie has to travel as its own field: a `cookie` entry in a headers object is dropped by the
  // Headers constructor, which is a silent way to test nothing at all.
  const post = (path, body, options = {}) => call(path, { method: 'POST', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, body });
  const admin = (path, options = {}) => call(path, { ...options, headers: { 'X-Admin-Token': TOKEN, ...(options.headers || {}) } });
  return { call, post, admin };
}

test('the console admits an operator session and nobody else', { timeout: 180000 }, async (t) => {
  const { call, post, admin } = await harness(t);

  // 1. Nobody. The console has to be able to ask "who am I" without credentials, and the answer must not
  //    disclose anything beyond "not authenticated".
  const anonymous = await (await call('/api/admin/session')).json();
  assert.equal(anonymous.authenticated, false);
  assert.equal(anonymous.code, 'LOGIN_REQUIRED');
  assert.equal((await call('/api/admin/accounts')).status, 401, 'no credential is 401, not 403');

  // 2. A token that was offered and refused is a different failure from offering nothing.
  assert.equal((await call('/api/admin/accounts', { headers: { 'X-Admin-Token': 'wrong-but-long-enough' } })).status, 403);

  // 3. A real player, approved, logged in - and still not an operator.
  await post('/api/auth/register', { login: '博士', password: PASSWORD });
  await admin('/api/admin/review', { method: 'POST', body: { login: '博士', status: 'approved' } });
  const login = await post('/api/auth/login', { login: '博士', password: PASSWORD });
  assert.equal(login.status, 204);
  const raw = login.headers.get('set-cookie') || '';
  assert.match(raw, /__Host-sp_session=[0-9a-f]{64}/, 'the session must be an HttpOnly cookie, not a token in JS');
  assert.match(raw, /HttpOnly/, 'otherwise a script injected into the page could read the operator session');
  const session = { cookie: raw.split(';')[0] };

  const asPlayer = await (await call('/api/admin/session', { cookie: session.cookie })).json();
  assert.equal(asPlayer.authenticated, false);
  assert.equal(asPlayer.code, 'NOT_OPERATOR', 'logged in is not the same as allowed');
  assert.equal((await call('/api/admin/accounts', { cookie: session.cookie })).status, 403);

  // 4. Granting a seat is token-only: a stolen operator session must not be able to hand out more access.
  assert.equal((await post('/api/admin/operators', { login: '博士', action: 'add' }, { cookie: session.cookie })).status, 403);
  const granted = await admin('/api/admin/operators', { method: 'POST', body: { login: '博士', action: 'add' } });
  assert.equal(granted.status, 200);
  const seat = await granted.json();
  assert.equal(seat.items.length, 1);
  const accountId = seat.accountId;
  assert.equal(seat.status, 'approved');

  // 5. Now the same session is an operator: reads and writes both work, with no token anywhere.
  const state = await (await call('/api/admin/session', { cookie: session.cookie })).json();
  assert.equal(state.authenticated, true);
  assert.equal(state.via, 'session');
  assert.equal(state.fresh, true);
  assert.equal(state.login, '博士');
  assert.ok(Number.isSafeInteger(state.since), 'the session records when it was created');
  assert.equal((await call('/api/admin/accounts', { cookie: session.cookie })).status, 200);
  assert.equal((await post('/api/admin/maintenance', { enabled: true, message: '会话登录测试' }, { cookie: session.cookie })).status, 200);
  assert.equal((await post('/api/admin/maintenance', { enabled: false }, { cookie: session.cookie })).status, 200);

  // 6. The seat is revocable on its own - no need to rotate the token for everyone.
  const removed = await admin('/api/admin/operators', { method: 'POST', body: { login: '博士', action: 'remove' } });
  assert.equal((await removed.json()).items.length, 0);
  assert.equal((await call('/api/admin/accounts', { cookie: session.cookie })).status, 403, 'revoking the seat locks the console again');
  await admin('/api/admin/operators', { method: 'POST', body: { login: '博士', action: 'add' } });

  // 7. A session older than the write window may look, but not touch. A player session lasts 30 days;
  //    letting one of those take the site down months later is not a trade worth making.
  const oldToken = 'b'.repeat(64);
  const planted = await call('/_plant', { method: 'POST', body: { key: sha256(oldToken), value: {
    accountId, user: { login: '博士', name: '博士' }, expiresAt: Date.now() + 3600_000, createdAt: Date.now() - 13 * 3600_000 } } });
  assert.equal(planted.status, 200, await planted.clone().text());  // the fixture reports its own failures
  const stale = { cookie: '__Host-sp_session=' + oldToken };
  const staleState = await (await call('/api/admin/session', { cookie: stale.cookie })).json();
  assert.equal(staleState.authenticated, true);
  assert.equal(staleState.fresh, false, '13 hours is past the 12 hour write window');
  assert.equal((await call('/api/admin/accounts', { cookie: stale.cookie })).status, 200, 'reads stay available');
  const staleWrite = await post('/api/admin/maintenance', { enabled: true }, { cookie: stale.cookie });
  assert.equal(staleWrite.status, 403);
  assert.equal((await staleWrite.json()).error, 'RELOGIN_REQUIRED', 'the page can tell this apart from "not allowed"');
  // The token path is unaffected by any of this: it is the way back in when a password is lost.
  assert.equal((await admin('/api/admin/accounts')).status, 200);
});

test('the operator list rejects malformed input and unknown logins', { timeout: 180000 }, async (t) => {
  const { admin } = await harness(t);
  const send = (body) => admin('/api/admin/operators', { method: 'POST', body });
  assert.equal((await send('{not json')).status, 400);
  assert.equal((await send({ login: '博士' })).status, 400, 'action is required');
  assert.equal((await send({ login: '博士', action: 'promote' })).status, 400, 'action is an allowlist');
  assert.equal((await send({ login: '博士', action: 'add', extra: 1 })).status, 400, 'unknown keys are refused');
  assert.equal((await send({ login: '没有这个人', action: 'add' })).status, 404);
  assert.deepEqual((await (await admin('/api/admin/operators')).json()).items, []);
});
