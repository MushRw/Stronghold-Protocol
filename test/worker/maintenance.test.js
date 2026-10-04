import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountHarness } from './helpers/account-harness.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { maintenanceActive } from '../../worker/maintenance.js';

// Filesystem-backed data loaders only resolve under the production build substitutions, so this runs
// the same bundle the edge does — which is also what makes the maintenance gate worth testing at all.
let buildPromise = null;
function source() {
  buildPromise ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-maintenance-'));
    const file = path.join(dir, 'worker.mjs').replaceAll('\\', '/');
    await bundleWorker({ outfile: file });
    process.on('exit', () => { rm(dir, { recursive: true, force: true }).catch(() => {}); });
    return `export { default, RoomDurableObject, AdmissionDurableObject, SiteDirectory, AccountDurableObject, MatchArchive } from ${JSON.stringify(file)};`;
  })();
  return buildPromise;
}

const TOKEN = 'test-admin-token-0123456789abcdef';
const ORIGIN = 'https://test.example';

const harness = async () => createAccountHarness(await source(), {
  bindings: { ADMIN_TOKEN: TOKEN },
  durableObjects: {
    SITES: { className: 'SiteDirectory', useSQLite: true },
    ROOMS: { className: 'RoomDurableObject', useSQLite: true },
    ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true },
    ADMISSION: { className: 'AdmissionDurableObject', useSQLite: true },
    MATCH_ARCHIVES: { className: 'MatchArchive', useSQLite: true },
  },
});

const get = (h, path, headers = {}) => h.request(ORIGIN + path, { headers });

test('maintenance switch gates the site without a deploy, and the operator keeps a way in',
  { timeout: 90000 }, async (t) => {
    const h = await harness();
    t.after(() => h.dispose());

    // Nothing switched on: the gate is transparent (no ASSETS binding here, so a plain 404).
    assert.equal((await get(h, '/')).status, 404);

    const toggle = (payload) => h.request(ORIGIN + '/api/admin/maintenance', {
      method: 'POST',
      headers: { 'X-Admin-Token': TOKEN, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const on = await toggle({ enabled: true, message: '正在升级数据库，预计 30 分钟' });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).maintenance.enabled, true);

    // The state is cached per isolate for a few seconds; a restart is the same fresh isolate an edge
    // PoP gets, and it is how a visitor actually experiences the switch.
    await h.restart();
    const blocked = await get(h, '/');
    assert.equal(blocked.status, 503);
    const page = await blocked.text();
    assert.match(page, /维护中/);
    assert.match(page, /正在升级数据库/);
    assert.equal(blocked.headers.get('retry-after'), '600');

    // Every public surface is gated, including the WebSocket upgrade and the game APIs.
    assert.equal((await get(h, '/ws?room=ABCD')).status, 503);
    assert.equal((await get(h, '/api/rooms')).status, 503);

    // The operator has to be able to reach the switch that turns this off.
    assert.equal((await get(h, '/healthz')).status, 200);
    assert.equal((await h.request(ORIGIN + '/admin')).status, 200);
    assert.equal((await get(h, '/', { 'X-Admin-Token': TOKEN })).status, 404);

    // `?key=` trades the token for a cookie instead of leaving it in the URL bar. Follow it manually:
    // a real browser keeps the Set-Cookie, a bare fetch client would drop it and land back on 503.
    const exchange = await h.request(ORIGIN + '/?key=' + TOKEN, { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get('location'), '/');
    const cookie = (exchange.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^sp_pass=/);
    assert.equal((await get(h, '/', { cookie })).status, 404);
    // A wrong key is not a way in, and neither is a forged cookie.
    assert.equal((await get(h, '/?key=nope')).status, 503);
    assert.equal((await get(h, '/', { cookie: 'sp_pass=nope' })).status, 503);

    // Turning it back off restores the site.
    assert.equal((await toggle({ enabled: false })).status, 200);
    await h.restart();
    assert.equal((await get(h, '/')).status, 404);
  });

/** Comments only ever appear outside strings in this file; a URL's `//` must survive. */
const stripJsonc = (text) => text.split('\n').map((line) => {
  let inString = false, out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inString) { out += c + (line[++i] ?? ''); continue; }
    if (c === '"') inString = !inString;
    if (!inString && c === '/' && line[i + 1] === '/') break;
    out += c;
  }
  return out;
}).join('\n');

// The gate is only as good as the routing in front of it: an asset served without waking the Worker
// never reaches `maintenanceGuard`, so the site would keep handing out the app shell while "down".
test('the entry document is routed to the Worker before assets', async () => {
  const config = JSON.parse(stripJsonc(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')));
  const first = config.assets.run_worker_first;
  assert.ok(Array.isArray(first), 'run_worker_first must stay an explicit list, not `true` or `false`');
  for (const path of ['/', '/index.html', '/api/*', '/ws', '/healthz', '/admin']) {
    assert.ok(first.includes(path), `${path} must be listed in assets.run_worker_first`);
  }
});

test('the maintenance API rejects bad input and unauthenticated callers', { timeout: 60000 }, async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const post = (payload, headers = {}) => h.request(ORIGIN + '/api/admin/maintenance', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  assert.equal((await post({ enabled: true })).status, 403);
  assert.equal((await post({ enabled: true }, { 'X-Admin-Token': 'wrong' })).status, 403);
  assert.equal((await post({ enabled: 'yes' }, { 'X-Admin-Token': TOKEN })).status, 400);
  assert.equal((await post({ enabled: true, extra: 1 }, { 'X-Admin-Token': TOKEN })).status, 400);
  assert.equal((await post('{not json', { 'X-Admin-Token': TOKEN })).status, 400);
  // Reading the state is operator-only too: it must not become a public outage indicator scraper.
  assert.equal((await get(h, '/api/admin/maintenance')).status, 403);
  assert.equal((await get(h, '/api/admin/maintenance', { 'X-Admin-Token': TOKEN })).status, 200);
});

// The page has always printed "预计恢复时间", but nothing honoured it until now: an operator who set an
// end time was really asking for the site to stay down until someone remembered. These pin the rule.
test('an end time ends the maintenance', () => {
  const now = 1_000_000;
  assert.equal(maintenanceActive(null, now), false);
  assert.equal(maintenanceActive({ enabled: false }, now), false);
  assert.equal(maintenanceActive({ enabled: true }, now), true, 'no deadline means it holds until turned off');
  assert.equal(maintenanceActive({ enabled: true, until: now + 1 }, now), true);
  assert.equal(maintenanceActive({ enabled: true, until: now + 1 }, now + 2), false);
  assert.equal(maintenanceActive({ enabled: true, until: now }, now), false, 'at the deadline it is already over');
  assert.equal(maintenanceActive({ enabled: true, until: now - 1 }, now), false);
  assert.equal(maintenanceActive({ enabled: true, until: 'soon' }, now), true, 'a non-integer deadline cannot expire');
});

test('an expired deadline serves the site while the flag still reads enabled', { timeout: 90000 }, async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const toggle = (payload) => h.request(ORIGIN + '/api/admin/maintenance', {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const past = await toggle({ enabled: true, until: Date.now() - 1000 });
  assert.equal(past.status, 200);
  assert.equal((await past.json()).maintenance.enabled, true, 'the stored flag keeps saying enabled');
  assert.ok(Number.isSafeInteger((await (await get(h, '/api/admin/maintenance', { 'X-Admin-Token': TOKEN })).json()).maintenance.until));

  // Enforcement happens on read, so no write happens when a deadline lapses - restarting proves the gate
  // re-evaluates rather than having been patched at write time.
  await h.restart();
  assert.equal((await get(h, '/')).status, 404, 'the site is served once the deadline has passed');
  assert.equal((await get(h, '/api/rooms')).status, 200);
  assert.notEqual((await get(h, '/ws?room=ABCD')).status, 503, 'no longer gated either');

  // The API still reports the raw flag with its (past) deadline, so the page can say "expired" instead of
  // "in maintenance" - the two must not be conflated in either direction.
  const state = (await (await get(h, '/api/admin/maintenance', { 'X-Admin-Token': TOKEN })).json()).maintenance;
  assert.equal(state.enabled, true);
  assert.ok(state.until <= Date.now());

  // A future deadline still blocks, so the feature is a deadline and not a way to disable the gate.
  assert.equal((await toggle({ enabled: true, until: Date.now() + 60_000 })).status, 200);
  await h.restart();
  assert.equal((await get(h, '/')).status, 503);
});
