// Self-hosted accounts end to end against a real workerd: register → not approved → cannot get a room
// ticket → the operator approves → login works and the same account can create and enter a room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { LOCAL_AUTH } from '../../shared/account-protocol.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ADMIN_TOKEN = 'local-auth-admin-token-0123456789abcdef';
const ORIGIN = 'https://game.example';

async function harness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-local-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundlePath });
  // The production Worker, with the site directory and accounts exposed so the fixture can register.
  const source = `
    import worker,{SiteDirectory,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive}
      from ${JSON.stringify(bundlePath.replaceAll('\\', '/'))};
    export {SiteDirectory as TestObject,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive};
    // Build the Request here: a browser sends Origin and the session cookie, and the origin check is
    // part of what these tests are verifying.
    export default { async fetch(request, env) {
      const input = await request.json();
      const headers = new Headers({ Origin: 'https://game.example', ...(input.headers || {}) });
      if (input.cookie) headers.set('cookie', input.cookie);
      const forwarded = new Request('https://game.example' + input.path, {
        method: input.method || 'GET', headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
      return worker.fetch(forwarded, env);
    } };
  `;
  const h = await createAccountHarness(source, {
    durableObjects: Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'], ['ROOMS', 'RoomDurableObject'],
      ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']].map(([key, className]) => [key, { className, useSQLite: true }])),
    bindings: { ADMIN_TOKEN },
  });
  t.after(() => h.dispose());
  const call = (path, options = {}) => h.fetch({ path, method: options.method || 'GET',
    headers: options.headers, cookie: options.cookie, body: options.body });
  const post = (path, body, headers) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const admin = (path, options = {}) => call(path, { ...options, headers: { 'X-Admin-Token': ADMIN_TOKEN, ...(options.headers || {}) } });
  return { h, call, post, admin };
}

test('the PBKDF2 iteration count stays inside the platform ceiling', () => {
  // workerd refuses more than 100000 rounds at runtime; Miniflare does not enforce it, so a local test
  // passes while production registration fails with a 502. Keep the ceiling asserted here.
  assert.ok(LOCAL_AUTH.iterations <= 100000, `iterations=${LOCAL_AUTH.iterations} exceeds what workerd accepts`);
  assert.ok(LOCAL_AUTH.iterations >= 10000, 'too few rounds to cost an offline attacker anything');
});

const cookieOf = (response) => (response.headers.get('set-cookie') || '').split(';')[0];
const login = { login: '博士', password: 'correct-horse-battery' };

test('a self-hosted account must be reviewed by the operator before it can play', { timeout: 120000 }, async (t) => {
  const { call, post, admin } = await harness(t);

  // No session at all: the room ticket is refused.
  assert.equal((await call('/api/rooms', { method: 'POST' })).status, 401);

  // Registering answers immediately and hands out no session cookie.
  const registered = await post('/api/auth/register', login);
  assert.equal(registered.status, 201, 'register said: ' + await registered.clone().text());
  assert.deepEqual(await registered.json(), { ok: true, status: 'pending', login: '博士' });
  assert.equal(registered.headers.get('set-cookie'), null, 'a pending account must not receive a session');

  // Logging in before approval is refused with a code the UI can explain.
  const early = await post('/api/auth/login', login);
  assert.equal(early.status, 403);
  assert.deepEqual(await early.json(), { error: 'NOT_APPROVED', status: 'pending' });

  // A wrong password is not an oracle: same 401, and the account stays pending.
  assert.equal((await post('/api/auth/login', { ...login, password: 'wrong-password' })).status, 401);
  assert.equal((await post('/api/auth/login', { ...login, password: 'wrong-password' })).status, 401);

  // A duplicate callsign is refused instead of silently taking over the account.
  assert.equal((await post('/api/auth/register', login)).status, 409);

  // The review list is behind the operator token.
  assert.equal((await call('/api/admin/accounts')).status, 403);
  const pending = await admin('/api/admin/accounts?status=pending');
  assert.equal(pending.status, 200);
  assert.deepEqual((await pending.json()).items.map((x) => [x.login, x.status]), [['博士', 'pending']]);

  // Only the operator can approve, and the player still cannot play before that.
  assert.equal((await post('/api/admin/review', { login: '博士', status: 'approved' }, { 'X-Admin-Token': 'wrong' })).status, 403);
  const approved = await admin('/api/admin/review', { method: 'POST', body: { login: '博士', status: 'approved' } });
  assert.equal(approved.status, 200);

  const session = await post('/api/auth/login', login);
  assert.equal(session.status, 204, 'an approved account receives a session');
  const cookie = cookieOf(session);
  assert.match(cookie, /^__Host-sp_session=[a-f0-9]{64}$/);

  // Now the same account can reserve a room, and /api/me reports it.
  const reserve = await call('/api/rooms', { method: 'POST', cookie });
  assert.equal(reserve.status, 201, await reserve.text());
  const me = await call('/api/me', { cookie });
  const body = await me.json();
  assert.equal(body.user.name, '博士');
  assert.equal(body.capabilities.localAuth, true, 'the UI must offer the local form');
});

test('the review gate holds for the WebSocket too, and revocation kills the live session', { timeout: 120000 }, async (t) => {
  const { call, post, admin } = await harness(t);
  await post('/api/auth/register', { login: '阿米娅', password: 'another-long-secret' });
  await admin('/api/admin/review', { method: 'POST', body: { login: '阿米娅', status: 'approved' } });
  const cookie = cookieOf(await post('/api/auth/login', { login: '阿米娅', password: 'another-long-secret' }));

  const connect = () => call('/ws?room=ABCD&ticket=nope', { headers: { Upgrade: 'websocket' }, cookie });
  const before = await connect();
  assert.notEqual(before.status, 403, 'an approved account is not blocked by the review gate');

  // Rejecting the account must invalidate the session it already holds.
  const rejected = await admin('/api/admin/review', { method: 'POST', body: { login: '阿米娅', status: 'rejected' } });
  assert.equal(rejected.status, 200);
  assert.equal((await connect()).status, 401, 'a rejected account loses its session');
  assert.equal((await call('/api/rooms', { method: 'POST', cookie })).status, 401);
  const refused = await post('/api/auth/login', { login: '阿米娅', password: 'another-long-secret' });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'NOT_APPROVED', status: 'rejected' });
});

test('the admin surface stays hidden until a long enough token is configured', { timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-local-auth-off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundlePath });
  const source = `
    import worker,{SiteDirectory,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive}
      from ${JSON.stringify(bundlePath.replaceAll('\\', '/'))};
    export {SiteDirectory as TestObject,AccountDurableObject,RoomDurableObject,AdmissionDurableObject,MatchArchive};
    export default { fetch: (request, env) => worker.fetch(request, env) };
  `;
  const durableObjects = Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'], ['ROOMS', 'RoomDurableObject'],
    ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']].map(([key, className]) => [key, { className, useSQLite: true }]));
  // A short token must not unlock anything, and the page must not render.
  const weak = await createAccountHarness(source, { durableObjects, bindings: { ADMIN_TOKEN: 'short' } });
  t.after(() => weak.dispose());
  assert.equal((await weak.request(ORIGIN + '/admin')).status, 404);
  assert.equal((await weak.request(ORIGIN + '/api/admin/accounts', { headers: { 'X-Admin-Token': 'short' } })).status, 404);

  const off = await createAccountHarness(source, { durableObjects });
  t.after(() => off.dispose());
  assert.equal((await off.request(ORIGIN + '/admin')).status, 404);
  // Local sign-in can be switched off explicitly; GitHub-only deployments then keep the old behaviour.
  const local = await off.request(ORIGIN + '/api/auth/register', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'x', password: 'yyyyyyyy' }),
  });
  assert.equal(local.status, 201, 'self-hosted accounts are on by default when the account DO is bound');
});

// The room holds a reservation for ROOM_LIMITS.reservationMs (120s), so the dead-claim case can only
// be observed after that lease lapses. Slow by nature: this is the guard for a permanent account lockout.
test('a reservation the client never connected to does not lock the account out', { timeout: 300000 }, async (t) => {
  const { call, post, admin } = await harness(t);
  await post('/api/auth/register', { login: 'stranded', password: 'another-long-secret' });
  await admin('/api/admin/review', { method: 'POST', body: { login: 'stranded', status: 'approved' } });
  const cookie = cookieOf(await post('/api/auth/login', { login: 'stranded', password: 'another-long-secret' }));

  // Reserving claims a seat, but this client never opens the WebSocket, so it never enters the room.
  const first = await call('/api/rooms', { method: 'POST', cookie });
  assert.equal(first.status, 201, await first.clone().text());
  const firstCode = (await first.json()).code;
  // While the room still holds the 30s reservation lease the claim is legitimate.
  assert.equal((await call('/api/rooms', { method: 'POST', cookie })).status, 409, 'a live reservation is still a seat');

  // After the lease lapses the room forgets the account; the claim must not stay forever.
  await new Promise((r) => setTimeout(r, 125000));
  const second = await call('/api/rooms', { method: 'POST', cookie });
  assert.equal(second.status, 201, 'a dead reservation must be released, not honoured: ' + await second.clone().text());
  assert.notEqual((await second.json()).code, firstCode);
});
