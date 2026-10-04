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
  if (url.pathname === '/daily') return Response.json({ items: await site.writeStatsDaily(input.days) });
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

// The daily view is what turns "wait for the limit email" into something visible, and the limit resets at
// 00:00 UTC - so the buckets have to be UTC days, or two different quotas land in one row.
test('per-day totals bucket by UTC day and match the per-match records', { timeout: 60000 }, async (t) => {
  const h = await createAccountHarness(source, { durableObjects: { TEST: { className: 'TestObject', useSQLite: true } } });
  t.after(() => h.dispose());
  const call = (path, body = {}) => h.request('https://test.example' + path, { method: 'POST', body: JSON.stringify(body) });
  const day = 86400000;
  const today = Math.floor(Date.now() / day);

  assert.deepEqual((await (await call('/daily')).json()).items, []);

  await call('/record', stat({ at: Date.now(), roomId: 'AAAA', rows: 1000, flushes: 10 }));
  await call('/record', stat({ at: Date.now() - 3600_000, roomId: 'BBBB', rows: 2000, flushes: 20 }));
  // Three days back, so a one-day window excludes it while the default seven-day window includes it.
  await call('/record', stat({ at: (today - 3) * day + 3600_000, roomId: 'CCCC', rows: 500, flushes: 5 }));

  const { items } = await (await call('/daily')).json();
  assert.equal(items.length, 2, 'two UTC days');
  assert.equal(items[0].day, today, 'newest day first');
  assert.equal(items[0].matches, 2, 'both of today\'s matches are in one bucket');
  assert.equal(items[0].rows, 3000, 'the bucket sums rows, not counts');
  assert.equal(items[0].flushes, 30);
  assert.equal(items[1].day, today - 3);
  assert.equal(items[1].rows, 500);

  // The span is clamped like every other admin read: a caller cannot ask for an unbounded scan.
  assert.equal((await (await call('/daily', { days: 0 })).json()).items.length, 2);
  assert.equal((await (await call('/daily', { days: 9999 })).json()).items.length, 2);
  // A window that does not reach back far enough drops the older bucket instead of returning it anyway.
  assert.equal((await (await call('/daily', { days: 1 })).json()).items.length, 1);

  await h.restart();
  assert.equal((await (await call('/daily')).json()).items.length, 2, 'survives a restart like the per-match rows do');
});
