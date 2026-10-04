import test from 'node:test';
import assert from 'node:assert/strict';
import { eventRows, EVENT_BATCH, EVENT_ROW_BYTES } from '../../worker/storage/event-rows.js';

/** What the RoomDO recovery path does with a journal row. */
const expand = (rows) => rows.flatMap((row) => JSON.parse(row.payload));

test('an empty pending range produces no rows', () => {
  assert.deepEqual(eventRows([]), []);
});

test('a small range becomes one row whose payload keeps the old array shape', () => {
  const events = Array.from({ length: EVENT_BATCH }, (_, i) => ({ t: 'e', i }));
  const rows = eventRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, 0);
  assert.deepEqual(JSON.parse(rows[0].payload), events);
});

test('a range over the count cap forks at the right sequence number', () => {
  const events = Array.from({ length: EVENT_BATCH + 1 }, (_, i) => ({ i }));
  const rows = eventRows(events, 100);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.seq), [100, 100 + EVENT_BATCH]);
  assert.deepEqual(expand(rows), events);
});

test('the byte cap splits rows even when the event count is small', () => {
  // 100 KB each: two per row fits inside 256 KB, three never does.
  const events = Array.from({ length: 10 }, (_, i) => ({ i, blob: 'x'.repeat(100 * 1024) }));
  const rows = eventRows(events);
  assert.equal(rows.length, 5);
  for (const row of rows) assert.ok(row.payload.length <= EVENT_ROW_BYTES, 'a row must stay under the cap');
  assert.deepEqual(expand(rows), events);
});

test('a single event larger than the cap gets a row to itself', () => {
  const events = [{ big: 'y'.repeat(EVENT_ROW_BYTES * 2) }, { small: 1 }];
  const rows = eventRows(events);
  assert.equal(rows.length, 2);
  assert.deepEqual(expand(rows), events);
});

test('recovery reads every event exactly once, in order, whatever the sizes', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ i, pad: 'z'.repeat(i * 40) }));
  const rows = eventRows(events, 7);
  assert.deepEqual(expand(rows), events);
  const seqs = rows.map((row) => row.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(seqs[0], 7);
});
