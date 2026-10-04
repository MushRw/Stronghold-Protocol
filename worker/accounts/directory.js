import { DurableObject } from 'cloudflare:workers';
import { AccountError, pageLimit, requireLogin, requirePassword, requireReview, LOCAL_AUTH } from '../../shared/account-protocol.js';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value) => new Uint8Array((value || '').match(/../g)?.map((h) => parseInt(h, 16)) || []);
const ACCOUNT_PAGE = 100;
/** PBKDF2-HMAC-SHA256 in WebCrypto: native, so a 210k-round verifier costs the free plan no JS CPU. */
async function deriveVerifier(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: LOCAL_AUTH.iterations }, key, 256));
}
/** Length-independent comparison; a wrong guess must not leak how much of the verifier matched. */
function equalBytes(a, b) {
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Small site-wide identity/session index; no game events or battle frames. */
export class SiteDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (github_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS auth_expiry ON auth_records(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, value TEXT NOT NULL, visible INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS archives (match_id TEXT PRIMARY KEY)');
    // Self-hosted accounts. The login is the primary key (case-insensitive), and the profile also
    // lands in `users` under a synthetic id so backup/restore keeps working without knowing the provider.
    this.sql.exec("CREATE TABLE IF NOT EXISTS local_auth (login TEXT PRIMARY KEY COLLATE NOCASE, account_id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, verifier TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_at INTEGER)");
    this.sql.exec('CREATE INDEX IF NOT EXISTS local_auth_status ON local_auth(status,created_at)');
    // Site-wide operational flags. They live in the directory rather than in `wrangler.jsonc` on
    // purpose: taking the site down for maintenance must not require a deploy (a deploy evicts every
    // room and drops live matches), so the switch has to be readable and writable at runtime.
    this.sql.exec('CREATE TABLE IF NOT EXISTS site_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  }
  getFlag(key) {
    const row = this.sql.exec('SELECT value FROM site_flags WHERE key=?', key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  setFlag(key, value) {
    this.sql.exec('INSERT INTO site_flags VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      key, JSON.stringify(value), Date.now());
    return value;
  }
  maintenance() { return this.getFlag('maintenance'); }
  setMaintenance(state) { return this.setFlag('maintenance', state); }
  resolveGithubUser({id, login, name, avatarUrl}) {
    if (!/^\d{1,20}$/.test(id) || typeof login !== 'string' || login.length > 80) throw new AccountError('INVALID_PROFILE');
    const displayName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    return this.ctx.storage.transactionSync(() => {
      const old = this.sql.exec('SELECT account_id FROM users WHERE github_id=?', id).toArray()[0];
      const profile = {accountId: old?.account_id || crypto.randomUUID(), githubId: id, githubLogin: login, name: displayName || login, avatarUrl};
      this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile',
        id, profile.accountId, JSON.stringify(profile));
      return profile;
    });
  }
  /** Register a self-hosted account. It stays `pending` until an operator approves it. */
  async createLocalUser({ login, password, now = Date.now() }) {
    requireLogin(login); requirePassword(password);
    // Derived before the sync transaction: WebCrypto is async and this object is single-threaded.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const verifier = await deriveVerifier(password, salt);
    return this.ctx.storage.transactionSync(() => {
      if (this.sql.exec('SELECT account_id FROM local_auth WHERE login=?', login).toArray()[0]) {
        throw new AccountError('LOGIN_TAKEN', 409);
      }
      const accountId = crypto.randomUUID();
      const profile = { accountId, githubId: 'local:' + accountId, githubLogin: '', name: login, avatarUrl: null, local: true };
      this.sql.exec('INSERT INTO users VALUES (?,?,?)', profile.githubId, accountId, JSON.stringify(profile));
      this.sql.exec('INSERT INTO local_auth VALUES (?,?,?,?,?,?,?)', login, accountId, hex(salt), hex(verifier), 'pending', now, null);
      return { ...profile, status: 'pending', createdAt: now };
    });
  }
  /** Verify a login/password. An unknown login still pays the PBKDF2 cost, so timing leaks nothing. */
  async verifyLocalUser({ login, password }) {
    const row = this.sql.exec('SELECT account_id,salt,verifier,status FROM local_auth WHERE login=?', login).toArray()[0];
    if (!row) { await deriveVerifier(String(password || ''), new Uint8Array(16)); return null; }
    const candidate = await deriveVerifier(String(password || ''), unhex(row.salt));
    if (!equalBytes(candidate, unhex(row.verifier))) return null;
    const stored = this.sql.exec('SELECT profile FROM users WHERE account_id=?', row.account_id).toArray()[0];
    if (!stored) return null;
    return { ...JSON.parse(stored.profile), status: row.status };
  }
  /** null for accounts that did not come from the self-hosted provider (they need no review). */
  localStatusByAccount(accountId) {
    return this.sql.exec('SELECT status FROM local_auth WHERE account_id=?', accountId).toArray()[0]?.status || null;
  }
  reviewLocalUser({ login, status, now = Date.now() }) {
    requireReview(status);
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT account_id FROM local_auth WHERE login=?', login).toArray()[0];
      if (!row) throw new AccountError('UNKNOWN_LOGIN', 404);
      this.sql.exec('UPDATE local_auth SET status=?, reviewed_at=? WHERE login=?', status, now, login);
      // A rejected account must not keep playing on the session it already holds.
      if (status !== 'approved') {
        this.sql.exec("DELETE FROM auth_records WHERE kind='session' AND json_extract(value,'$.accountId')=?", row.account_id);
      }
      return { login, status, accountId: row.account_id, reviewedAt: now };
    });
  }
  listLocalUsers({ status = '', limit = ACCOUNT_PAGE } = {}) {
    if (status) requireReview(status);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACCOUNT_PAGE) throw new AccountError('INVALID_PAGE');
    return this.sql.exec('SELECT login,status,created_at,reviewed_at FROM local_auth WHERE (?=\'\' OR status=?) ORDER BY created_at LIMIT ?',
      status, status, limit).toArray().map((r) => ({ login: r.login, status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at }));
  }
  async saveOAuth(key, value) { return this.saveRecord('oauth', key, value); }
  async saveSession(key, value) { return this.saveRecord('session', key, value); }
  async saveRecord(kind, key, value) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(value.expiresAt)) throw new AccountError('INVALID_AUTH_RECORD');
    this.sql.exec('INSERT INTO auth_records VALUES (?,?,?,?)', kind + ':' + key, kind, JSON.stringify(value), value.expiresAt);
    // A single periodic cleanup alarm, never scheduled past an already pending one.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null) await this.ctx.storage.setAlarm(Date.now() + 600000);
  }
  consumeOAuth(key) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('DELETE FROM auth_records WHERE key=? RETURNING value, expires_at', 'oauth:' + key).toArray()[0];
      return row && row.expires_at > Date.now() ? JSON.parse(row.value) : null;
    });
  }
  getSession(key) {
    const row = this.sql.exec('SELECT value, expires_at FROM auth_records WHERE key=?', 'session:' + key).toArray()[0];
    return row && row.expires_at > Date.now() ? JSON.parse(row.value) : null;
  }
  revokeSession(key) { this.sql.exec('DELETE FROM auth_records WHERE key=?', 'session:' + key); }
  /** Read-only size report for the operator console. Returns plain numbers: a callback crossing the
   *  RPC boundary would drag this object's SqlStorage along with it. */
  async diagnostics() {
    const count = (table) => this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return {
      users: count('users'), local_auth: count('local_auth'), auth_records: count('auth_records'),
      rooms: count('rooms'), archives: count('archives'), kvKeys: (await this.ctx.storage.list()).size,
    };
  }
  registerArchive(matchId) {this.sql.exec('INSERT OR IGNORE INTO archives VALUES (?)',matchId);}
  backupCatalog({cursor='',kind='profiles',limit=100}={}) {
    if(typeof cursor!=='string' || cursor.length>128 || !Number.isInteger(limit) || limit<1 || limit>100)throw new AccountError('INVALID_PAGE');
    const profiles=kind==='profiles';
    const rows=profiles?this.sql.exec('SELECT account_id AS id,profile FROM users WHERE account_id>? ORDER BY account_id LIMIT ?',cursor,limit+1).toArray()
      :this.sql.exec('SELECT match_id AS id FROM archives WHERE match_id>? ORDER BY match_id LIMIT ?',cursor,limit+1).toArray();
    return {items:rows.slice(0,limit).map(r=>profiles?JSON.parse(r.profile):r.id),nextCursor:rows.length>limit?rows[limit-1].id:null};
  }
  restoreProfile(profile,dryRun=true) {
    const existing=this.sql.exec('SELECT account_id,github_id FROM users WHERE account_id=? OR github_id=?',profile.accountId,profile.githubId).toArray();
    if(existing.some(r=>r.account_id!==profile.accountId || r.github_id!==profile.githubId))throw new AccountError('IDENTITY_CONFLICT',409);
    if(!dryRun) this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile',profile.githubId,profile.accountId,JSON.stringify(profile));
    return {ok:true};
  }
  revokeAllSessions() {this.sql.exec('DELETE FROM auth_records');}
  publishRoom(room) {
    if(!/^[A-Z]{4}$/.test(room.roomId) || !Number.isSafeInteger(room.expiresAt)) throw new AccountError('INVALID_ROOM');
    const visible=!!room.public && (room.connectedHumans>0 || !!room.inMatch);
    this.sql.exec('INSERT INTO rooms VALUES (?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value,visible=excluded.visible,updated_at=excluded.updated_at,expires_at=excluded.expires_at WHERE excluded.updated_at>=rooms.updated_at',
      room.roomId,JSON.stringify(room),visible?1:0,room.updatedAt,room.expiresAt);
    this.sql.exec('DELETE FROM rooms WHERE expires_at<?',Date.now()-600000);
  }
  listRooms({cursor='',limit=20}={}) {
    pageLimit(limit);
    if(typeof cursor!=='string' || (cursor && !/^[A-Z]{4}$/.test(cursor))) throw new AccountError('INVALID_CURSOR');
    const rows=this.sql.exec('SELECT room_id,value FROM rooms WHERE visible=1 AND expires_at>? AND room_id>? ORDER BY room_id LIMIT ?',Date.now(),cursor,limit+1).toArray();
    return {items:rows.slice(0,limit).map(r=>JSON.parse(r.value)),nextCursor:rows.length>limit?rows[limit-1].room_id:null};
  }
  async alarm() {
    this.sql.exec('DELETE FROM auth_records WHERE expires_at<=?', Date.now());
    const remaining = this.sql.exec('SELECT MIN(expires_at) AS at FROM auth_records').one().at;
    if (remaining != null) await this.ctx.storage.setAlarm(Math.min(remaining, Date.now() + 600000));
  }
}
