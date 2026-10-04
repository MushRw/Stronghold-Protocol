import { randomInt } from 'node:crypto';
import { APP_VERSION } from '../shared/constants.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { normalizeIp, limitKeyOf, TokenBucket } from '../server/net.js';
import { RoomRuntime, validCode } from './room-runtime.js';
import { prepareMatchVersion } from './match-versions.js';
import { PACK_PATH, servePack } from './pack.js';
import { handleAuth, approvedSession, accountOf, directoryOf } from './accounts/auth.js';
import { handleAdminRoutes, adminConfigured } from './accounts/admin.js';
import { ADMIN_PAGE, adminPageHeaders } from './accounts/admin-page.js';
import { handleAccountRoutes } from './accounts/routes.js';
import { handleLobbyRoutes, roomApplications } from './rooms/routes.js';
import { handleHistoryRoutes } from './archive/routes.js';
import { publishArchive,prepareArchive } from './archive/outbox.js';
import { handleBackupRoutes } from './storage/backup.js';
import { eventRows } from './storage/event-rows.js';
import { cachedVerdict, rememberVerdict } from './storage/session-cache.js';
import { maintenanceGuard } from './maintenance.js';

// the deployed commit (tools/build-worker.mjs buildId; esbuild defines it, unbundled tests see 'local')
const BUILD = typeof __SP_BUILD__ === 'string' ? __SP_BUILD__ : 'local';
const json = (body, status = 200, headers = {}) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (status, code, detail) => json({ error: code, ...(detail ? { detail } : {}) }, status);
const edgeIp = (request) => normalizeIp(request.headers.get('CF-Connecting-IP')) || '0.0.0.0';
// Free-tier budget guards. A Durable Object is only billed for duration while it is awake, and an
// active JS timer would keep it awake (billable wall-clock) for the whole match, so a match in
// progress is pumped by alarms and its checkpoint is only flushed every MATCH_PERSIST_MS.
const MATCH_PERSIST_MS = 10_000;
// Persistence is billed in rows written, so the shape of a flush matters as much as its frequency.
// A SQLite-backed Durable Object allows 2 MB per key+value, and a full match checkpoint is ~40 KB,
// so chunking at a quarter of that keeps a whole snapshot in one row (plus `snapshot-meta`) instead of
// three. The old 16,000-character chunk predates the 2 MB limit and tripled every write for no reason.
const SNAPSHOT_CHUNK_CHARS = 250_000;
// Event-journal batching, and the byte cap that keeps one huge event from growing a row without bound,
// live in ./storage/event-rows.js so they can be unit-tested without a Worker runtime.
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code), { locationHint: 'apac' });
const sameOrigin = (request) => !request.headers.has('Origin') || request.headers.get('Origin') === new URL(request.url).origin;
async function admit(env, ip, kind) {
  const stub = env.ADMISSION.get(env.ADMISSION.idFromName(limitKeyOf(ip)), { locationHint: 'apac' });
  const result = await stub.fetch(new Request(`https://admission.internal/${kind}`, { method: 'POST' }));
  return result.ok ? null : result;
}

/**
 * A seat claim only means something while the room still lists that account. A client that reserved a
 * room and never finished connecting (closed tab, refused upgrade, lost network) leaves a claim behind,
 * and because claims carry a lease that is never renewed, that dead claim would lock the account out of
 * every room from then on. So confirm with the room before refusing, and drop the claim when it is dead.
 */
async function liveSeat(env, session) {
  const account = accountOf(env, session.accountId);
  const seat = await account.getActiveSeat();
  if (!seat) return null;
  let live = false;
  try {
    const response = await roomStub(env, seat.roomId).fetch(new Request('https://room.internal/_account', {
      headers: { 'X-Account-ID': session.accountId, 'X-Room-Generation': seat.roomGeneration } }));
    live = response.ok;
  } catch { live = false; }
  if (!live) { await account.releaseSeat({ claimId: seat.claimId }); return null; }
  return seat;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const backup=await handleBackupRoutes(request,env);if(backup)return backup;
    // The maintenance gate runs before anything that costs a Durable Object call, so a taken-down site
    // stops spending the free tier's budget instead of merely hiding the UI.
    const maintenance = await maintenanceGuard(request, env);
    if (maintenance) return maintenance;
    if (path === '/admin') return adminConfigured(env) ? new Response(ADMIN_PAGE, { headers: adminPageHeaders() }) : error(404, 'NOT_FOUND');
    // /api/admin/login is the ordinary login under a prefix the maintenance guard lets through, so it has
    // to be metered like one - otherwise the console's front door doubles as an unmetered password guesser.
    if(env.ADMISSION && (path.startsWith('/api/auth/') || path==='/api/admin/login' || path==='/api/rooms' && request.method==='GET' || /\/applications$/.test(path))) {
      const kind=path.startsWith('/api/auth/local')||path==='/api/auth/register'||path==='/api/auth/login'||path==='/api/admin/login'?'localauth'
        :path.startsWith('/api/auth/')?'auth':request.method==='GET'?'status':'application';
      const limited=await admit(env,edgeIp(request),kind);
      if(limited)return limited;
    }
    // The console is served during maintenance, so the way into it has to be too. These are the ordinary
    // login and logout, reachable under /api/admin/ - a prefix the guard always lets through. Players stay
    // locked out: only somebody who deliberately opened the console uses them, and logging in still buys
    // nothing but the console while the site is down.
    if (path === '/api/admin/login' || path === '/api/admin/logout') {
      const tail = path.slice('/api/admin/'.length);
      return await handleAuth(new Request(new URL('/api/auth/' + tail, url).toString(), request), env);
    }
    const admin = await handleAdminRoutes(request, env);
    if (admin) return admin;
    const auth = await handleAuth(request, env);
    if (auth) return auth;
    const accountResponse = await handleAccountRoutes(request, env);
    if (accountResponse) return accountResponse;
    const lobbyResponse = await handleLobbyRoutes(request, env);
    if (lobbyResponse) return lobbyResponse;
    const historyResponse=await handleHistoryRoutes(request,env);
    if(historyResponse) return historyResponse;
    if (path === '/healthz') return request.method === 'GET'
      ? json({ ok: true, runtime: 'cloudflare', version: APP_VERSION, build: BUILD }) : error(405, 'BAD_MSG');
    // Internal endpoints are only invoked on a DO stub; the public entry point never forwards them.
    if (path.startsWith('/_')) return error(404, 'ROOM_NOT_FOUND');
    if (path === '/api/rooms') {
      if (request.method !== 'POST') return error(405, 'BAD_MSG');
      if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
      // Playing starts here: a reviewed account is required, not merely a valid session.
      const gate = env.ACCOUNTS ? await approvedSession(request, env) : { session: null };
      if (gate.error) return error(gate.error.status, gate.error.code);
      const session = gate.session;
      if (session && request.headers.get('Origin') !== url.origin) return error(403, 'BAD_MSG');
      if (session && await liveSeat(env, session)) return error(409, 'ALREADY_SEATED');
      const limited = await admit(env, edgeIp(request), 'reserve');
      if (limited) return limited;
      for (let i = 0; i < 12; i++) {
        const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        const response = await roomStub(env, code).fetch(new Request(`https://room.internal/_reserve?room=${code}`, {
          method: 'POST', headers: session ? {'X-Account-ID':session.accountId} : {} }));
        if (response.status !== 409) {
          if (response.ok && session) {
            const route=await response.clone().json(), claimId=crypto.randomUUID();
            const claim=await accountOf(env,session.accountId).claimSeat({claimId,expiresAt:Date.now()+120000,
              seat:{roomId:route.code,roomGeneration:route.generation,matchId:null,seatId:null}});
            if (!claim.ok) return error(409,'ALREADY_SEATED');
          }
          return response;
        }
      }
      return error(503, 'INTERNAL', 'room capacity unavailable');
    }
    const statusMatch = /^\/api\/rooms\/([A-Za-z]{4})$/.exec(path);
    if (statusMatch) {
      if (request.method !== 'GET') return error(405, 'BAD_MSG');
      const code = statusMatch[1].toUpperCase();
      if (!validCode(code)) return error(404, 'ROOM_NOT_FOUND');
      const limited = await admit(env, edgeIp(request), 'status');
      if (limited) return limited;
      return roomStub(env, code).fetch(new Request('https://room.internal/_status'));
    }
    if (path === '/ws') {
      if (request.method !== 'GET') return error(405, 'BAD_MSG');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG', 'WebSocket required');
      const code = (url.searchParams.get('room') || '').toUpperCase();
      if (!validCode(code)) return error(400, 'BAD_MSG', 'invalid room code');
      if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
      const ip = edgeIp(request);
      // A room ticket alone must not let an unreviewed account connect.
      const gate = env.ACCOUNTS ? await approvedSession(request, env) : { session: null };
      if (gate.error) return error(gate.error.status, gate.error.code);
      const session = gate.session;
      const limited = await admit(env, ip, 'connect');
      if (limited) return limited;
      const dest = new URL('https://room.internal/_ws');
      dest.searchParams.set('room', code);
      const ticket = url.searchParams.get('ticket');
      if (ticket && /^[0-9a-f]{32}$/.test(ticket)) dest.searchParams.set('ticket', ticket);
      return roomStub(env, code).fetch(new Request(dest, { headers: { Upgrade: 'websocket', 'X-Room-IP': ip,
        ...(session ? {'X-Account-ID':session.accountId,'X-Session-ID':session.sessionId} : {}) } }));
    }
    if (path === PACK_PATH) return servePack(request, env);
    if (path.startsWith('/api/')) return error(404, 'ROOM_NOT_FOUND');
    return env.ASSETS ? env.ASSETS.fetch(request) : error(404, 'ROOM_NOT_FOUND');
  },
};

// One tiny, automatically-expiring limiter per edge-provided IP (/64 for IPv6), shared across rooms.
export class AdmissionDurableObject {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const kind = new URL(request.url).pathname.slice(1);
      const settings = { reserve: [8 / 60, 8], connect: [40 / 60, 20], status: [120 / 60, 30],auth:[10/60,5],localauth:[20/60,10],application:[30/60,10] }[kind];
      if (request.method !== 'POST' || !settings) return error(404, 'BAD_MSG');
      const now = Date.now();
      const stored = await this.ctx.storage.get(kind);
      const bucket = new TokenBucket(...settings, now);
      if (stored) Object.assign(bucket, stored);
      const allowed = bucket.take(now);
      await this.ctx.storage.put(kind, { ...bucket });
      await this.ctx.storage.setAlarm(now + 120_000);
      return allowed ? new Response(null, { status: 204 })
        : json({ error: 'RATE', detail: 'too many requests from your network' }, 429, { 'Retry-After': '8' });
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// Adapt the Workers WebSocket surface to the existing Network's small EventEmitter-like contract.
class SocketAdapter {
  constructor(socket, buffered=false) { this.socket = socket; this.handlers = new Map(); this.closed = false; this.buffered=buffered; this.pending=[]; }
  get readyState() { return this.closed ? 3 : this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount || 0; }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...args) { for (const fn of this.handlers.get(type) || []) fn(...args); }
  send(data, callback) { if(this.buffered) this.pending.push(data); else this.socket.send(data); callback?.(); }
  flush() {if(!this.closed) for(const data of this.pending) this.socket.send(data); this.pending=[];}
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(code, reason); } finally { this.emit('close'); }
  }
  terminate() { this.close(1008, 'connection terminated'); }
}

export class RoomDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();
    this.lastPersistAt = 0;
    this.persistedLogId=null;this.persistedEventCount=0;this.persistedLogRows=0;
    // `alarmAt` is what this isolate believes is armed; storage is the fallback after an eviction.
    this.alarmAt = null;
    this.lastInMatch = false;      // edge-detects a match ending, so its cost can be reported once
    this.writes = { rows: 0, flushes: 0, since: Date.now() };
    // Session verdicts, so the per-message check does not hit the site directory every time (see
    // ./storage/session-cache.js). In-memory on purpose: persisting it would cost a row written per
    // refresh and still need a round trip, which is the thing being avoided.
    this.sessionCache = new Map();
    this.sessionChecks = { calls: 0, cached: 0 };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping","c":0}', '{"t":"pong","c":0}'));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get('snapshot-meta');
      let snapshot;
      if (meta?.parts) {
        const keys = Array.from({ length: meta.parts }, (_, i) => `snapshot-${i}`);
        const parts=[];
        for(let offset=0;offset<keys.length;offset+=128) {
          const batch=keys.slice(offset,offset+128),chunks=await ctx.storage.get(batch);
          for(const key of batch) {
            if(typeof chunks.get(key)!=='string')throw new Error('INCOMPLETE_ROOM_SNAPSHOT');
            parts.push(chunks.get(key));
          }
        }
        snapshot = JSON.parse(parts.join(''));
      }
      if(snapshot?.matchCheckpoint?.eventLogId) {
        const c=snapshot.matchCheckpoint;
        const count=ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM match_events WHERE match_id=?',c.eventLogId).one().count;
        // Rows are batches of EVENT_BATCH events; `logRows` is the count a complete journal must have.
        // Journals written before batching kept one row per event, hence the eventCount fallback.
        if(count!==(c.logRows ?? c.eventCount)) throw new Error('INCOMPLETE_MATCH_LOG');
        // Retained engines require an Array, but only iterate it during restoration.
        // Stream rows instead of keeping SQL payloads and parsed events together.
        c.events=new Array(c.eventCount);
        c.events[Symbol.iterator]=function*(){
          for(const row of ctx.storage.sql.exec('SELECT payload FROM match_events WHERE match_id=? ORDER BY seq',c.eventLogId)){
            const value=JSON.parse(row.payload);
            if(Array.isArray(value))yield* value; else yield value;
          }
        };
        this.persistedLogId=c.eventLogId;this.persistedEventCount=c.events.length;this.persistedLogRows=count;
      }

      this.parts = meta?.parts || 0;
      await prepareMatchVersion(snapshot?.matchCheckpoint?.rulesVersion);
      this.runtime = new RoomRuntime({ snapshot, accounts: !!env.ACCOUNTS, onChange: () => this.queuePersist() });
      for (const ws of ctx.getWebSockets()) {
        // Closing sockets may still be enumerated; never rebind one over its replacement.
        if (ws.readyState !== 1) continue;
        if (snapshot?.running && !snapshot.matchCheckpoint) { try { ws.close(1012, 'active match interrupted by server restart'); } catch {} continue; }
        const attachment = ws.deserializeAttachment();
        if (!attachment) { try { ws.close(1011, 'missing session'); } catch {} continue; }
        if(env.ACCOUNTS) {
          const session=attachment.sessionId && await directoryOf(env).getSession(attachment.sessionId);
          if(!session || session.accountId!==attachment.accountId) {try{ws.close(4003,'login required');}catch{}continue;}
        }
        const adapter = new SocketAdapter(ws,!!env.ACCOUNTS);
        this.sockets.set(ws, adapter);
        this.runtime.connect(adapter, { ip: attachment.ip, attachment });
      }
      this.refreshAutoResponses();
      this.runtime.reconcileSockets();
      this.runtime.sweep();
      await this.persist();
    });
  }
  refreshAutoResponses() {
    for (const [ws, adapter] of this.sockets) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const session = this.runtime.network.conns.get(adapter)?.session;
      if (session && Number.isFinite(at)) session.lastSeen = Math.max(session.lastSeen, at);
    }
  }
  queuePersist() {
    // Match completion can be initiated by one of its existing timers, outside a WebSocket event.
    // Forced so the "match over" transition is durable on the next tick, never up to 10s later.
    this.ctx.waitUntil(this.ctx.blockConcurrencyWhile(() => this.persistNow()));
  }
  /**
   * Write durable state now, skipping the MATCH_PERSIST_MS throttle. The flag lives on the instance
   * rather than in an argument so that every write still goes through persist() — a subclass (or a
   * test) overriding persist() must never be able to swallow the request by dropping a parameter.
   */
  async persistNow() {
    this.persistForced = true;
    try { return await this.persist(); } finally { this.persistForced = false; }
  }
  async persist() {
    const rt = this.runtime;
    const active = !!rt.status()?.inMatch;
    const force = this.persistForced === true;
    const now = Date.now();
    for (const [ws, adapter] of this.sockets) {
      const attachment = rt.attachment(adapter);
      if (attachment) ws.serializeAttachment(attachment);
      else this.sockets.delete(ws);
    }
    if (rt.isEmpty()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.alarmAt = null;
      this.parts = 0;
      this.persistedLogId=null;this.persistedEventCount=0;this.persistedLogRows=0;
      for(const adapter of this.sockets.values())adapter.flush();
      return;
    }
    // A throttled flush must still drain buffered socket writes, or clients would stall for 10s.
    if (active && !force && now - this.lastPersistAt < MATCH_PERSIST_MS) {
      for (const adapter of this.sockets.values()) adapter.flush();
      await this.scheduleAlarm();
      return;
    }
    this.lastPersistAt = now;
    // SQLite-backed values may be 2 MB per key+value. Chunk by UTF-16 characters so even non-ASCII
    // names stay below it, and chunk coarsely enough that a normal snapshot is a single row.
    const snapshot=rt.snapshot(), checkpoint=snapshot.matchCheckpoint;
    let newRows=[], logId=null;
    if(checkpoint) {
      logId=rt.generation + ':' + checkpoint.options.matchNo;
      const fresh=this.persistedLogId!==logId;
      const offset=fresh ? 0 : this.persistedEventCount || 0;
      const pending=checkpoint.events.slice(offset);
      // Every pending event is journalled in this flush, so the snapshot's `view` can never describe
      // events that are still only in memory — recovery would otherwise fail CHECKPOINT_STATE_DIVERGED.
      newRows=eventRows(pending, offset);
      checkpoint.eventCount=checkpoint.events.length;checkpoint.eventLogId=logId;
      checkpoint.logRows=(fresh ? 0 : this.persistedLogRows || 0)+newRows.length;
      delete checkpoint.events;
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS match_events (match_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(match_id,seq))');
    }
    const source = JSON.stringify(snapshot);
    const count = Math.ceil(source.length / SNAPSHOT_CHUNK_CHARS);
    const entries = { 'snapshot-meta': { parts: count } };
    for (let i = 0; i < count; i++) entries[`snapshot-${i}`] = source.slice(i * SNAPSHOT_CHUNK_CHARS, (i + 1) * SNAPSHOT_CHUNK_CHARS);
    await this.ctx.storage.transaction(async (txn) => {
      // REPLACE so a replayed batch (a restored object whose offset moved back) cannot collide.
      for(const row of newRows) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO match_events VALUES (?,?,?)',logId,row.seq,row.payload);
      const items=Object.entries(entries);
      for(let offset=0;offset<items.length;offset+=128)await txn.put(Object.fromEntries(items.slice(offset,offset+128)));
      if(count<this.parts) {
        const oldKeys=Array.from({length:this.parts-count},(_,i)=>`snapshot-${i+count}`);
        for(let offset=0;offset<oldKeys.length;offset+=128)await txn.delete(oldKeys.slice(offset,offset+128));
      }
    });

    this.parts = count;
    // Rows written by this flush: the snapshot chunks and their meta, plus one row per journalled batch.
    // Deletions bill too, but a stable snapshot size means they are rare. Counting here is what makes
    // "did that change help?" answerable at all — the analytics API cannot tell us on the free plan.
    this.writes.rows += count + 1 + newRows.length;
    this.writes.flushes += 1;
    if (this.lastInMatch && !active) this.ctx.waitUntil(this.reportWrites());
    this.lastInMatch = active;
    if(checkpoint) {this.persistedLogId=logId;this.persistedEventCount=checkpoint.eventCount;this.persistedLogRows=checkpoint.logRows;}
    for(const adapter of this.sockets.values()) adapter.flush();
    if(this.env.ACCOUNTS && !this.releasingClaims) {
      const terminal=rt.applications.list().filter(item=>['expired','cancelled','rejected'].includes(item.status) && !item.released);
      if(terminal.length) {
        this.releasingClaims=true;
        this.ctx.waitUntil(Promise.all(terminal.map(async item=>{
          const account=accountOf(this.env,item.accountId);
          await account.releaseSeat({claimId:item.id});await account.clearApplication(rt.code,item.id);
        })).then(()=>this.ctx.blockConcurrencyWhile(async()=>{
          for(const item of terminal){const current=rt.applications.items.find(x=>x.id===item.id);if(current)current.released=true;}
          this.releasingClaims=false;await this.persist();
        })).catch(()=>{this.releasingClaims=false;}));
      }
    }
    if(this.env.MATCH_ARCHIVES && rt.archiveOutbox.length && !this.archiving) {
      this.archiving=true;
      const entry=rt.archiveOutbox[0];
      const publish=async()=>{
        if(!entry.encodedReplay) {
          const encoded=await prepareArchive(entry);
          // Freeze exact compressed bytes durably before the first immutable remote write.
          await this.ctx.blockConcurrencyWhile(async()=>{entry.encodedReplay=encoded;delete entry.replay;await this.persist();});
        }
        await publishArchive(this.env,entry);
      };
      this.ctx.waitUntil(publish().then(()=>this.ctx.blockConcurrencyWhile(async()=>{
        rt.archiveOutbox=rt.archiveOutbox.filter(x=>x.facts.matchId!==entry.facts.matchId);
        this.archiving=false;await this.persist();
      })).catch(()=>{this.archiving=false;}));
    }
    if(this.env.SITES) {
      const room=rt.lobby.getRoom(rt.code), now=Date.now();
      if(room) {
        const listing={roomId:rt.code,generation:rt.generation,public:rt.publicRoom && room.mode==='coop',
          connectedHumans:room.activeHumans().filter(s=>s.connected).length,occupied:room.seats.filter(Boolean).length,
          capacity:4,inMatch:!!room.match,spectatorCount:rt.spectators.count,hostName:room.seatOf(room.hostId)?.name || '博士',difficulty:room.difficulty};
        const fingerprint=JSON.stringify(listing);
        if(fingerprint!==this.lastListing || now-(this.lastPublished || 0)>=20000) {
          this.lastListing=fingerprint;this.lastPublished=now;
          this.ctx.waitUntil(directoryOf(this.env).publishRoom({...listing,updatedAt:now,expiresAt:now+60000})
            .catch(()=>{this.lastPublished=0;}));
        }
      }
    }
    await this.scheduleAlarm();
  }
  /**
   * Hand a finished match's write cost to the site directory, then start counting the next one.
   * `rows written` is the budget a free-tier deployment runs out of, and that plan's analytics API does
   * not expose it, so each match leaves one row describing what it cost. Without this the only feedback
   * is the limit email — which arrives after writes have already started failing.
   */
  async reportWrites() {
    const now = Date.now();
    const stat = { at: now, roomId: this.runtime.code || '', matchMs: Math.max(0, now - this.writes.since),
      rows: this.writes.rows, flushes: this.writes.flushes,
      seconds: Math.round(Math.max(0, now - this.writes.since) / 1000) };
    this.writes = { rows: 0, flushes: 0, since: now };
    if (!this.env.SITES || !stat.rows) return;
    try { await directoryOf(this.env).recordWriteStats(stat); }
    catch (e) { console.error('[writes]', e?.stack || e?.message || e); }
  }
  async scheduleAlarm() {
    // Always re-arm from the next alarm(): a throttled persist() must not leave the object unscheduled.
    const at = this.runtime.nextAlarm();
    if (!at) {
      if (this.alarmAt !== null) { this.alarmAt = null; await this.ctx.storage.deleteAlarm(); }
      return;
    }
    // setAlarm() bills a row written, and an in-match persist() runs on every client message, so
    // re-arming unconditionally would cost one row per message to move an alarm that already exists.
    // Only arm when the deadline genuinely moves earlier; after an eviction fall back to storage.
    if (this.alarmAt !== null && this.alarmAt <= at) return;
    const armed = await this.ctx.storage.getAlarm();
    if (armed !== null && armed <= at) { this.alarmAt = armed; return; }
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }
  async fetch(request) {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      const rt = this.runtime;
      this.refreshAutoResponses();
      rt.sweep();
      if(this.env.ACCOUNTS && ['/_applications','/_visibility'].includes(url.pathname)) {
        const response=await roomApplications(rt,request,this.env);await this.persistNow();return response;
      }
      if (url.pathname === '/_reserve' && request.method === 'POST') {
        const code = url.searchParams.get('room');
        if (!validCode(code)) return error(400, 'BAD_MSG');
        const ticket = rt.reserve(code, request.headers.get('X-Account-ID'));
        await this.persistNow();
        return ticket ? json({ code, ticket, ...(rt.accounts ? {generation:rt.generation} : {}) }, 201) : error(409, 'ROOM_FULL');
      }
      if (url.pathname === '/_account') {
        const accountId=request.headers.get('X-Account-ID');
        if (request.headers.get('X-Room-Generation')!==rt.generation || !rt.hasAccount(accountId)) return error(404,'ROOM_NOT_FOUND');
        if (request.method==='POST') {
          const ticket=rt.resumeAccount(accountId); await this.persistNow();
          return ticket ? json({code:rt.code,ticket,join:rt.applications.list(accountId).some(x=>x.status==='approved'),reserved:rt.reservation?.accountId===accountId}) : error(404,'ROOM_NOT_FOUND');
        }
        return json({activeSeat:{roomId:rt.code,roomGeneration:rt.generation},status:rt.status()});
      }
      if (url.pathname === '/_status' && request.method === 'GET') {
        const status = rt.status();
        await this.persist();
        return status ? json(status) : error(404, 'ROOM_NOT_FOUND');
      }
      // Internal only. `/api/rooms/:code` proxies to /_status, so the live flush counter must not live
      // there: the public response is the fixed {code,mode,inMatch,full} contract that clients assert on.
      if (url.pathname === '/_diag' && request.method === 'GET') {
        const status = rt.status();
        if (!status) return error(404, 'ROOM_NOT_FOUND');
        return json({ ...status, writes: this.writes, parts: this.parts, sessionChecks: this.sessionChecks });
      }
      if (url.pathname !== '/_ws' || request.method !== 'GET') return error(404, 'BAD_MSG');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG');
      if (!rt.canConnect() || url.searchParams.get('room') !== rt.code) return error(404, 'ROOM_NOT_FOUND');
      const ip = request.headers.get('X-Room-IP') || '0.0.0.0';
      if (rt.admission(ip,request.headers.get('X-Account-ID'))) return error(429, 'RATE', 'connection limit');
      const profile = this.env.ACCOUNTS && request.headers.get('X-Account-ID')
        ? await accountOf(this.env,request.headers.get('X-Account-ID')).getProfile() : null;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const adapter = new SocketAdapter(server,!!this.env.ACCOUNTS);
      this.sockets.set(server, adapter);
      rt.connect(adapter, { ip, ticket: url.searchParams.get('ticket'), accountId: request.headers.get('X-Account-ID'),
        sessionId:request.headers.get('X-Session-ID'), avatarUrl:profile?.avatarUrl ?? null });
      await this.persistNow();
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  /**
   * Whether this session may keep sending, reused for a few seconds at a time.
   *
   * This is the room's only per-message cross-object round trip, and it is billed as a Durable Object
   * request on the same free-tier budget as the messages themselves, so a 1 Hz client report used to cost
   * two requests a second instead of one. The verdict only changes when someone logs out or is rejected
   * by the review gate, so remembering it briefly is nearly free - but only a valid verdict is cached, and
   * never past the session's own expiry (see ./storage/session-cache.js).
   */
  async sessionValid(sessionId, accountId) {
    const now = Date.now();
    if (cachedVerdict(this.sessionCache, sessionId, accountId, now)) { this.sessionChecks.cached++; return true; }
    this.sessionChecks.calls++;
    const session = await directoryOf(this.env).getSession(sessionId);
    return rememberVerdict(this.sessionCache, sessionId, accountId, session, now);
  }
  async webSocketMessage(ws, message) {
    await this.ready;
    if (this.env.ACCOUNTS) {
      const adapter=this.sockets.get(ws), meta=adapter && this.runtime.socketMeta.get(adapter);
      if (!meta?.sessionId || !await this.sessionValid(meta.sessionId, meta.accountId)) { adapter?.close(4003,'login required'); return; }
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const adapter = this.sockets.get(ws);
      const roomOf=()=>this.runtime.lobby.getRoom(this.runtime.code);
      const hadMatch=!!roomOf()?.match;
      if (adapter) this.runtime.message(adapter, message);
      // A message must not force a flush. Client-side combat reports b.progress about once a second
      // (4 Hz on boss fields) per authoritative player, so a forced write per message rewrites the whole
      // snapshot several times per second — that, not snapshot size, is what exhausts the free tier's
      // 100k rows/day. Durability still holds: the alarm grid (≤5 s) plus MATCH_PERSIST_MS bounds the
      // window at ~10 s, and the transitions that must be durable now (match over, room applications,
      // socket setup/teardown) still call persistNow().
      // Entering or leaving a match is one of those transitions: it is a single message that changes
      // what recovery has to restore, so it is flushed immediately and everything else is throttled.
      await (hadMatch!==!!roomOf()?.match ? this.persistNow() : this.persist());
    });
  }
  async webSocketClose(ws, code, reason) {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      const adapter = this.sockets.get(ws);
      if (adapter) { this.runtime.disconnect(adapter); this.sockets.delete(ws); }
      try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
      await this.persistNow();
    });
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011, 'socket error'); }
  async alarm() {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      // The alarm that fired has been consumed, so what this isolate remembered is no longer armed.
      this.alarmAt = null;
      try {
        this.refreshAutoResponses();
        this.runtime.pump();
        this.runtime.sweep();
        await this.persist();
      } catch (e) {
        // A failed flush must not take the alarm chain down with it: without the re-arm below nothing
        // would ever pump this object again and the match would freeze for good — client messages hit
        // the same failing write, so the players could not recover it either. Degrade, do not die.
        console.error('[alarm/persist]', e?.stack || e?.message || e);
      }
      // Re-arm unconditionally: the match clock lives in alarms, not in an in-memory timer.
      try { await this.scheduleAlarm(); }
      catch (e) { console.error('[alarm/arm]', e?.stack || e?.message || e); }
    });
  }
}
