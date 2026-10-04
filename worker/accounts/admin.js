// Operator-only account review for self-hosted ("local") accounts. The whole surface disappears until
// ADMIN_TOKEN is set, and every call must present it: this is the only way to let a stranger play.
import { AccountError, requireLogin, requireReview } from '../../shared/account-protocol.js';
import { authenticate, directoryOf, hash, json, requireOrigin } from './auth.js';

const TOKEN_MIN = 32;
/** Workers Free: Durable Object rows written per day. Going over fails writes instead of throttling them. */
const FREE_ROWS_PER_DAY = 100_000;
/**
 * How long ago an operator may have logged in and still be allowed to *change* something.
 *
 * A session lasts 30 days because that is a good life for a player's login. Management writes expire far
 * sooner: without this, a laptop that logged in months ago could still take the whole site down. Reads are
 * not restricted - being able to look at the console is not dangerous, and forcing a re-login to read would
 * only encourage people to stay logged in on a shared machine.
 */
const OPERATOR_WRITE_WINDOW_MS = 12 * 3600_000;

/** SHA-256 both sides first so the comparison length no longer depends on the secret. */
export async function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false;
  const [a, b] = await Promise.all([hash(presented), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function adminConfigured(env) {
  return typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= TOKEN_MIN;
}

/**
 * Who is asking, and what they are allowed to do.
 *
 * Two ways in, deliberately. `ADMIN_TOKEN` is the break-glass path: scripts (`tools/deploy-safe.mjs`) use
 * it, an operator locked out by a forgotten password uses it, and it is the only thing that can grant the
 * first operator seat - someone has to be able to hand out the first one.
 *
 * A login session is how a human is meant to operate: it carries an identity (so an action can be traced to
 * an account rather than to "whoever held the secret"), it can be revoked on its own, and the cookie it
 * rides in is HttpOnly. The token used to be pasted into the console and kept in `sessionStorage`, where a
 * script injected into the page could read it.
 *
 * Errors are distinguishable on purpose: 401 means "log in", 403 NOT_OPERATOR means "logged in, not an
 * operator", 403 RELOGIN_REQUIRED means "operator, but this session is too old to change anything".
 */
async function adminIdentity(request, env) {
  const presented = request.headers.get('X-Admin-Token') || new URL(request.url).searchParams.get('token') || '';
  if (presented) {
    // A token that was offered and does not match is a wrong credential, not a missing one.
    if (!await tokenMatches(presented, env.ADMIN_TOKEN)) return { error: { code: 'FORBIDDEN', status: 403 } };
    return { via: 'token', canWrite: true };
  }
  const session = await authenticate(request, env);
  if (!session) return { error: { code: 'LOGIN_REQUIRED', status: 401 } };
  if (!(await directoryOf(env).operators()).includes(session.accountId)) {
    return { error: { code: 'NOT_OPERATOR', status: 403 } };
  }
  const age = Number.isSafeInteger(session.createdAt) ? Date.now() - session.createdAt : Number.POSITIVE_INFINITY;
  return { via: 'session', accountId: session.accountId, createdAt: session.createdAt ?? null,
    login: session.user?.name || session.user?.login || null, canWrite: age <= OPERATOR_WRITE_WINDOW_MS };
}

/** Strict allowlist for the one route that hands out operator seats. */
async function operatorBody(request) {
  const raw = await request.text();
  if (raw.length > 512) throw new AccountError('BODY_TOO_LARGE', 413);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AccountError('INVALID_BODY'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AccountError('INVALID_BODY');
  if (Object.keys(parsed).some((k) => !['login', 'action'].includes(k))) throw new AccountError('INVALID_BODY');
  if (parsed.action !== 'add' && parsed.action !== 'remove') throw new AccountError('INVALID_BODY');
  return { login: requireLogin(parsed.login), action: parsed.action };
}
async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('INVALID_BODY');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new AccountError('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountError('INVALID_BODY'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((k) => !['login', 'status'].includes(k))) throw new AccountError('INVALID_BODY');
  return parsed;
}
/**
 * The maintenance flag is the one switch an operator needs during an incident, so it is a first-class
 * admin route rather than something edited in `wrangler.jsonc`: changing config would mean a deploy,
 * and a deploy evicts every room and drops live matches.
 */
async function flagBody(request) {
  const raw = await request.text();
  if (raw.length > 1024) throw new AccountError('BODY_TOO_LARGE', 413);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AccountError('INVALID_BODY'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AccountError('INVALID_BODY');
  if (Object.keys(parsed).some((k) => !['enabled', 'message', 'until'].includes(k))) throw new AccountError('INVALID_BODY');
  if (typeof parsed.enabled !== 'boolean') throw new AccountError('INVALID_BODY');
  if (parsed.message != null && (typeof parsed.message !== 'string' || parsed.message.length > 500)) throw new AccountError('INVALID_BODY');
  if (parsed.until != null && !Number.isSafeInteger(parsed.until)) throw new AccountError('INVALID_BODY');
  return { enabled: parsed.enabled, message: parsed.message || null, until: parsed.until || null };
}
export async function handleAdminRoutes(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin/')) return null;
  if (!env.SITES || !adminConfigured(env)) return json({ error: 'NOT_FOUND' }, 404);
  try {
    // The console asks this to decide what to render, so it must answer without credentials and must not
    // leak anything: an anonymous caller learns only that it is not authenticated.
    if (path === '/api/admin/session' && request.method === 'GET') {
      const identity = await adminIdentity(request, env);
      return json({ authenticated: !identity.error, code: identity.error?.code || null, via: identity.via || null,
        login: identity.login || null, since: identity.createdAt ?? null, fresh: !!identity.canWrite,
        windowHours: OPERATOR_WRITE_WINDOW_MS / 3600_000 });
    }
    const identity = await adminIdentity(request, env);
    if (identity.error) return json({ error: identity.error.code }, identity.error.status);
    // Reads only require being an operator; writes additionally require a recent login.
    if (request.method !== 'GET' && !identity.canWrite) return json({ error: 'RELOGIN_REQUIRED' }, 403);
    const directory = directoryOf(env);
    if (path === '/api/admin/operators') {
      if (request.method === 'GET') return json({ items: await directory.operators() });
      // Granting or removing a seat is token-only on purpose: a stolen operator session must not be able to
      // hand out more access (or to entrench itself), and the bootstrap has to work before one exists.
      if (identity.via !== 'token') return json({ error: 'FORBIDDEN' }, 403);
      requireOrigin(request);
      const { login, action } = await operatorBody(request);
      const user = await directory.accountForLogin(login);
      if (!user) return json({ error: 'UNKNOWN_LOGIN' }, 404);
      const current = await directory.operators();
      const next = action === 'add'
        ? Array.from(new Set([...current, user.accountId]))
        : current.filter((id) => id !== user.accountId);
      await directory.setOperators(next);
      return json({ items: next, accountId: user.accountId, status: user.status });
    }
    if (path === '/api/admin/accounts' && request.method === 'GET') {
      const status = new URL(request.url).searchParams.get('status') || '';
      return json({ items: await directory.listLocalUsers({ status }) });
    }
    if (path === '/api/admin/diag' && request.method === 'GET') {
      // Operator diagnostics. A Durable Object isolate that is reset on wake fails every call, so the
      // first question is always *which* object: probe each one with the cheapest possible read.
      //
      // Results are structured, not pre-rendered strings. They used to be `"SITES: ok"`, and the console
      // compared that to `'ok'`: every object was then reported as broken, and the label was printed twice.
      // Deciding whether a probe passed belongs on this side, where the probe's intent is known.
      const attempt = async (fn) => {
        try { await fn(); return { ok: true, detail: 'ok' }; }
        catch (e) { return { ok: false, detail: String(e?.code || e?.message || e) }; }
      };
      const probes = {};
      for (const [name, id] of [['SITES', env.SITES.idFromName('directory')], ['ACCOUNTS', env.ACCOUNTS.idFromName('diag-probe')]]) {
        const stub = env[name].get(id);
        probes[name] = name === 'SITES'
          ? await attempt(() => stub.getSession('0'.repeat(64)))
          : await attempt(() => stub.getProfile());
      }
      // The probe id deliberately has no archive: ARCHIVE_NOT_READY is the *expected* answer and means the
      // object answered at all, which is the only thing this probe asks. Reporting it as a failure would
      // cry wolf on a healthy deployment - and would keep doing so, since the probe id never gains data.
      const archive = await attempt(() => env.MATCH_ARCHIVES.get(env.MATCH_ARCHIVES.idFromName('diag-probe')).read('diag-probe'));
      probes.MATCH_ARCHIVES = archive.detail.includes('ARCHIVE_NOT_READY')
        ? { ok: true, detail: 'ok（探针房间本就没有存档，能这样回答即说明对象活着）' }
        : archive;
      let sizes = null;
      try { sizes = await directory.diagnostics(); }
      catch (e) { sizes = 'unavailable: ' + (e?.message || e); }
      return json({ probes, sizes });
    }
    if (path === '/api/admin/maintenance') {
      const directory = directoryOf(env);
      if (request.method === 'GET') return json({ maintenance: (await directory.maintenance()) || { enabled: false } });
      if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
      requireOrigin(request);
      const input = await flagBody(request);
      const state = await directory.setMaintenance({ enabled: input.enabled, message: input.message,
        until: input.until, updatedAt: Date.now() });
      return json({ maintenance: state });
    }
    if (path === '/api/admin/write-stats' && request.method === 'GET') {
      // What each recent match cost in rows written. The free plan's analytics API cannot report this,
      // so these figures are the only way to tell whether a persistence change actually helped.
      const directory = directoryOf(env);
      const items = await directory.writeStats(50);
      const totalRows = items.reduce((sum, item) => sum + item.rows, 0);
      // The quota is per UTC day and going over fails every write, so how much of today is already spent
      // matters more than any single match. Scope: only room flushes are counted - the directory's own
      // writes (accounts, sessions, the room list) never pass through a room, and a match is reported only
      // once it ends. So this is a floor rather than the whole picture, and the page labels it that way.
      const daily = await directory.writeStatsDaily(7);
      const today = Math.floor(Date.now() / 86400000);
      const used = daily.find((bucket) => bucket.day === today) || { matches: 0, rows: 0, flushes: 0 };
      return json({ items, totalRows, averageRows: items.length ? Math.round(totalRows / items.length) : 0,
        daily, quota: { limit: FREE_ROWS_PER_DAY, day: today, rows: used.rows, matches: used.matches,
          percent: Math.round((used.rows / FREE_ROWS_PER_DAY) * 1000) / 10 } });
    }
    if (path === '/api/admin/review' && request.method === 'POST') {
      requireOrigin(request);
      const payload = await body(request);
      return json(await directory.reviewLocalUser({
        login: requireLogin(payload.login), status: requireReview(payload.status) }));
    }
    return json({ error: 'NOT_FOUND' }, 404);
  } catch (e) {
    // This surface is already behind ADMIN_TOKEN, so the operator gets the real reason: a swallowed
    // internal error here would otherwise be indistinguishable from a misconfigured deployment.
    console.error('[admin]', path, e?.stack || e?.message || e);
    return json({ error: e?.code || 'ADMIN_UNAVAILABLE', detail: String(e?.message || e) }, e?.status || 503);
  }
}
