// Short-lived cache for the per-message session check a room performs.
//
// `directoryOf()` is a single SQLite Durable Object, and every WebSocket message in account mode asks it
// whether the sender's session is still good. That RPC is billed as a Durable Object request, on the same
// 100k/day free-tier budget as the WebSocket messages themselves, and client combat reports arrive about
// once a second per player - so the check roughly doubles a match's request count while its answer changes
// only when someone logs out or is rejected by the review gate.
//
// Caching the verdict trades a bounded delay in noticing that change for that whole round trip. Two rules
// keep the trade safe:
//   - The TTL never outlives the session's own `expiresAt`, so the cache cannot keep an expired session
//     usable. Expiry is still honoured to the second once the cached copy lapses.
//   - Only a *valid* verdict is cached. An invalid one closes the socket immediately and drops the entry,
//     so nothing is ever "remembered" as good that was not.
//
// The map is unbounded in principle (one entry per session that has ever sent a message to this room), so
// it is capped. LIVENESS: this state lives in the isolate. Eviction of the Durable Object simply loses it
// and the next message asks the directory again, which fails closed.

/** How long a valid verdict is reused. Bounds how long a revoked session can keep sending. */
export const SESSION_CACHE_MS = 15_000;
/** Cap on remembered sessions: a room streaming to many spectators must not grow this without limit. */
export const SESSION_CACHE_MAX = 128;

/**
 * The cached verdict for this session, or `null` when the directory has to be asked.
 * @param {Map<string, {accountId: string, until: number}>} cache
 */
export function cachedVerdict(cache, sessionId, accountId, now) {
  const hit = cache.get(sessionId);
  if (!hit) return null;
  // A session id is unique to one account; a mismatch means a stale entry (or a forged one), so re-ask.
  if (hit.accountId !== accountId) return null;
  if (now >= hit.until) return null;
  return true;
}

/**
 * Record what the directory said. Returns whether the session is valid, so callers can use this as the
 * decision instead of re-deriving it.
 * @param {Map<string, {accountId: string, until: number}>} cache
 * @param {{accountId?: string, expiresAt?: number}|null} session
 */
export function rememberVerdict(cache, sessionId, accountId, session, now) {
  if (!session || session.accountId !== accountId || !(session.expiresAt > now)) {
    cache.delete(sessionId);
    return false;
  }
  // Only a *new* key grows the map, and re-setting an existing one keeps its place in iteration order, so
  // evicting on every store would drop a live entry for nothing. Bound is on distinct sessions.
  if (!cache.has(sessionId) && cache.size >= SESSION_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(sessionId, { accountId, until: Math.min(now + SESSION_CACHE_MS, session.expiresAt) });
  return true;
}
