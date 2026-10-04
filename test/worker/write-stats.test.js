import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

// The free plan's analytics API does not expose rowsWritten, so a match's cost is only knowable if the
// room reports it. These figures are the entire feedback loop for persistence changes — if the table
// silently stops filling up, every later "did that help?" question becomes unanswerable again.
const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export default { async fetch(req, env) {
  const url = new URL(req.url), site = env.TEST.get(env.TEST.idFromName('directory'));
  const input = await req.json().catch(() => ({}));
  if (url.pathname === '/record') return Response.json(await site.recordWriteStats(input));
  if (url.pathname === '/list') return Response.json({ items: await site.writeStats(input.limit ?? 50) });
  return new Response('missing', { status: 404 });
}};`;

const stat = (over = {}) => ({ at: Date.now(), roomId: 'ABCD', matchMs: 600000, rows: 1234, flushes: 40, seconds: 600, ...over });

test('rooms report per-match write cost, newest first', { timeout: 60000 }, async (t) => {
  const h = await createAccountHarness(source, { durableObjects: { TEST: { className: 'TestObject', useSQLite: true } } });
  t.after(() => h.dispose());
  const call = (path, body = {}) => h.request('https://test.example' + path, { method: 'POST', body: JSON.stringify(body) });

  assert.deepEqual((await (await call('/list')).json()).items, []);

  const older = stat({ at: Date.now() - 60000, roomId: 'WXYZ', rows: 20000, flushes: 900, matchMs: 1800000, seconds: 1800 });
  const newer = stat({ at: Date.now(), roomId: 'ABCD', rows: 1050, flushes: 30, seconds: 600 });
  await call('/record', older);
  await call('/record', newer);

  const { items } = await (await call('/list')).json();
  assert.equal(items.length, 2);
  assert.equal(items[0].roomId, 'ABCD', 'the most recent match must come first');
  assert.equal(items[0].rows, 1050);
  assert.equal(items[1].rows, 20000);
  // The room id and figures must survive the round trip, or the table is decorative.
  assert.equal(items[1].matchMs, 1800000);
  assert.equal(items[1].flushes, 900);

  // Survives a restart: it is the record of what already happened, not an in-memory counter.
  await h.restart();
  assert.equal((await (await call('/list')).json()).items.length, 2);

  // Bounded reads: an operator page must not be able to ask for an unbounded scan.
  assert.equal((await (await call('/list', { limit: 1 })).json()).items.length, 1);
  assert.equal((await (await call('/list', { limit: 9999 })).json()).items.length, 2);
});
