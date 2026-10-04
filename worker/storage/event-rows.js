// Event-journal batching.
//
// The journal is append-only and every pending event must be on disk before the snapshot that
// describes it, so its cost is literally a row count. One row per event cost ~900 rows per match,
// which dominated once the snapshot itself became a single row; batching drops it to one row per flush.
//
// Two caps, not one. A count cap alone bounds nothing: a single event can be large (an event can carry
// a whole battle result), so 64 of them can grow without limit. `EVENT_ROW_BYTES` keeps a row well
// inside the 2 MB per key+value limit that SQLite-backed Durable Objects enforce, whatever the payload
// turns out to be.

/** Events per journal row, when their combined size is small. */
export const EVENT_BATCH = 64;
/** Byte ceiling for one journal row. Far above a normal batch (~1-3 KB), so it only bites on outliers. */
export const EVENT_ROW_BYTES = 256 * 1024;

/**
 * Group the pending events into journal rows.
 * @param {unknown[]} events events still missing from the journal, in order
 * @param {number} offset index of `events[0]` within the whole journal
 * @returns {{seq: number, payload: string}[]} `seq` is the index of the row's first event; `payload` is a
 *   JSON array — the exact shape the previous slice-based batching wrote, so rows already stored and the
 *   recovery path that reads them are unaffected.
 */
export function eventRows(events, offset = 0) {
  const rows = [];
  let batch = [];
  let bytes = 0;
  let start = 0;
  const flush = () => {
    if (!batch.length) return;
    rows.push({ seq: offset + start, payload: `[${batch.join(',')}]` });
    batch = [];
    bytes = 0;
  };
  for (let i = 0; i < events.length; i++) {
    const text = JSON.stringify(events[i]);
    // Flush before adding, so a row never exceeds either cap; a single oversized event still gets a row.
    if (batch.length && (batch.length >= EVENT_BATCH || bytes + text.length > EVENT_ROW_BYTES)) {
      flush();
      start = i;
    }
    batch.push(text);
    bytes += text.length + 1;
  }
  flush();
  return rows;
}
