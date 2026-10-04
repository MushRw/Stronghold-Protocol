import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedVerdict, rememberVerdict, SESSION_CACHE_MS, SESSION_CACHE_MAX } from '../../worker/storage/session-cache.js';
import { RoomDurableObject } from '../../worker/index.js';

const session = (accountId, expiresAt) => ({ accountId, expiresAt });

// `WebSocketRequestResponsePair` is a runtime global (it exists in workerd, not in Node). The class below
// is only there so the Durable Object's constructor can run; nothing in these tests uses auto responses.
globalThis.WebSocketRequestResponsePair ??= class { constructor(request, response) { this.request = request; this.response = response; } };

test('a valid verdict is reused until the TTL lapses', () => {
  const cache = new Map();
  const now = 1_000_000;
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now), null, 'nothing is known before the first check');
  assert.equal(rememberVerdict(cache, 'sid', 'acct', session('acct', now + 3_600_000), now), true);

  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + 1), true);
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + SESSION_CACHE_MS - 1), true);
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + SESSION_CACHE_MS), null, 'the TTL is exclusive');
});

test('the cache never outlives the session itself', () => {
  const cache = new Map();
  const now = 2_000_000;
  // A session expiring sooner than the TTL must be rechecked when it expires, not when the TTL does.
  rememberVerdict(cache, 'sid', 'acct', session('acct', now + 5_000), now);
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + 4_999), true);
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + 5_000), null);
  assert.equal(cachedVerdict(cache, 'sid', 'acct', now + SESSION_CACHE_MS), null);
});

test('a verdict belongs to one account, and invalidity is never cached', () => {
  const cache = new Map();
  const now = 3_000_000;
  rememberVerdict(cache, 'sid', 'acct', session('acct', now + 60_000), now);
  assert.equal(cachedVerdict(cache, 'sid', 'other', now + 1), null, 'a different account cannot reuse it');

  assert.equal(rememberVerdict(cache, 'sid', 'acct', null, now), false, 'unknown session');
  assert.equal(cache.has('sid'), false, 'a failed check drops the entry rather than keeping it');
  assert.equal(rememberVerdict(cache, 'sid', 'acct', session('other', now + 60_000), now), false, 'account mismatch');
  assert.equal(rememberVerdict(cache, 'sid', 'acct', session('acct', now), now), false, 'expired session');
  assert.equal(rememberVerdict(cache, 'sid', 'acct', session('acct', now - 1), now), false, 'expiry is exclusive');
});

test('the map stays bounded', () => {
  const cache = new Map();
  const now = 4_000_000;
  const live = session('acct', now + 3_600_000);
  for (let i = 0; i < SESSION_CACHE_MAX; i++) rememberVerdict(cache, `sid-${i}`, 'acct', live, now);
  assert.equal(cache.size, SESSION_CACHE_MAX);

  // Re-setting an entry that is already present must not evict anything.
  rememberVerdict(cache, 'sid-0', 'acct', live, now);
  assert.equal(cache.size, SESSION_CACHE_MAX);
  assert.equal(cache.has('sid-0'), true);

  rememberVerdict(cache, 'sid-new', 'acct', live, now);
  assert.equal(cache.size, SESSION_CACHE_MAX, 'the cap holds');
  assert.equal(cache.has('sid-new'), true);
  assert.equal(cache.has('sid-0'), false, 'the longest-present entry is the one dropped');
});

// The point of the cache is the round trip it removes, so assert that directly: repeated checks for one
// session must reach the directory once, not once per message. The Durable Object is constructed with a
// minimal fake context - sessionValid() is the message path and does not need the snapshot or the runtime,
// so the ready block is left to settle on its own.
test('repeated checks for one session reach the directory once', async () => {
  let asked = 0;
  const ctx = {
    storage: { get: async () => undefined },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn) => { void Promise.resolve().then(fn).catch(() => {}); return Promise.resolve(); },
    waitUntil: () => {},
  };
  const env = {
    SITES: {
      idFromName: (name) => name,
      get: () => ({ getSession: async () => { asked++; return session('acct', Date.now() + 3_600_000); } }),
    },
  };
  const room = new RoomDurableObject(ctx, env);

  assert.equal(await room.sessionValid('sid', 'acct'), true);
  assert.equal(await room.sessionValid('sid', 'acct'), true);
  assert.equal(await room.sessionValid('sid', 'acct'), true);
  assert.equal(asked, 1, 'three messages, one directory round trip');
  assert.deepEqual(room.sessionChecks, { calls: 1, cached: 2 });

  // A different session still has to be checked: the cache is per session, not per room.
  assert.equal(await room.sessionValid('other', 'acct'), true);
  assert.equal(asked, 2);
  assert.deepEqual(room.sessionChecks, { calls: 2, cached: 2 });
});

test('the directory is not consulted for a session it would reject twice', async () => {
  let asked = 0;
  const ctx = {
    storage: { get: async () => undefined },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn) => { void Promise.resolve().then(fn).catch(() => {}); return Promise.resolve(); },
    waitUntil: () => {},
  };
  const env = {
    SITES: {
      idFromName: (name) => name,
      get: () => ({ getSession: async () => { asked++; return session('acct', Date.now() - 1); } }),
    },
  };
  const room = new RoomDurableObject(ctx, env);
  assert.equal(await room.sessionValid('sid', 'acct'), false, 'an expired session is refused');
  assert.equal(await room.sessionValid('sid', 'acct'), false);
  assert.equal(asked, 2, 'a refusal is not cached: the socket is closed and the next attempt re-asks');
  assert.equal(room.sessionChecks.cached, 0);
});
