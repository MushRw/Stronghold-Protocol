import { ACCOUNT_LIMITS, AccountError, requireLogin, requirePassword } from '../../shared/account-protocol.js';
const SESSION_COOKIE = '__Host-sp_session', OAUTH_COOKIE = '__Host-sp_oauth';
export const directoryOf = env => env.SITES.get(env.SITES.idFromName('directory'));
export const accountOf = (env, id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
export const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
export function cookieValue(request, key) {
  return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1) || null;
}
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
const cookie = (key, value, seconds) => key + '=' + value + '; Path=/; Max-Age=' + seconds + '; Secure; HttpOnly; SameSite=Lax';
export function requireOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new AccountError('ORIGIN_MISMATCH', 403);
}
export function configured(env) { return !!(env.SITES && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.AUTH_ORIGIN); }
/** Self-hosted accounts need no third-party app: a login, a password and an operator's approval. */
export function localConfigured(env) { return !!(env.SITES && env.ACCOUNTS && env.LOCAL_AUTH !== '0'); }
export async function authenticate(request, env, {now = Date.now} = {}) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!env.SITES || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessionId = await hash(token);
  const session = await directoryOf(env).getSession(sessionId);
  return session && session.expiresAt > now() ? {...session, sessionId} : null;
}
/**
 * The gate for everything that counts as playing: a valid session *and* a reviewed account. A pending
 * or rejected self-hosted account may still log in, so the UI can explain the wait, but it gets no room
 * ticket and therefore no WebSocket. Accounts from an external provider carry no review state.
 */
export async function approvedSession(request, env) {
  const session = await authenticate(request, env);
  if (!session || !env.ACCOUNTS) return { error: { code: 'LOGIN_REQUIRED', status: 401 } };
  if (localConfigured(env)) {
    const status = await directoryOf(env).localStatusByAccount(session.accountId);
    if (status && status !== 'approved') return { error: { code: 'NOT_APPROVED', status: 403 } };
  }
  return { session };
}
/** Bounded JSON body reader: a login form must not be able to stream an unbounded payload. */
async function readJson(request, maxBytes = 1024) {
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('INVALID_BODY');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AccountError('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountError('INVALID_BODY'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((k) => !['login', 'password'].includes(k))) throw new AccountError('INVALID_BODY');
  return body;
}
// Accounts created before display names were stored can keep their existing session.
// Only legacy profiles need this lookup; an upstream outage must not break /api/me.
async function refreshLegacyProfile(user, env, providerFetch) {
  if (!user || user.githubLogin || !env.ACCOUNTS || !/^\d{1,20}$/.test(user.githubId)) return user;
  try {
    const response = await providerFetch('https://api.github.com/user/' + user.githubId, {headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol'}, signal: AbortSignal.timeout(5000)});
    if (!response.ok) return user;
    const profile = await response.json();
    if (!Number.isSafeInteger(profile.id) || String(profile.id) !== user.githubId || typeof profile.login !== 'string') return user;
    const avatarUrl = typeof profile.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url) ? profile.avatar_url : null;
    const updated = await directoryOf(env).resolveGithubUser({id: user.githubId, login: profile.login.slice(0, 80), name: profile.name, avatarUrl});
    if (updated.accountId !== user.accountId) return user;
    await accountOf(env, user.accountId).setProfile(updated);
    return updated;
  } catch { return user; }
}
export async function handleAuth(request, env, {now = Date.now, fetch: providerFetch = globalThis.fetch} = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/me') return null;
  try {
    if (url.pathname === '/api/me') {
      if (request.method !== 'GET') return json({error: 'METHOD'}, 405);
      const session = await authenticate(request, env, {now});
      const storedUser = session ? (env.ACCOUNTS ? await accountOf(env, session.accountId).getProfile() : session.user) : null;
      const user = await refreshLegacyProfile(storedUser, env, providerFetch);
      return json({user, capabilities: {accounts: configured(env),accountSystem:!!env.ACCOUNTS, localAuth:localConfigured(env)},
        application:session && env.ACCOUNTS ? await accountOf(env,session.accountId).getApplication() : null,
        activeSeat: session && env.ACCOUNTS ? await accountOf(env,session.accountId).getActiveSeat() : null});
    }
    const directory = directoryOf(env);
    // Provider-independent endpoints come first: a self-hosted deployment never configures GitHub at all.
    if (url.pathname === '/api/auth/logout') {
      if (request.method !== 'POST') return json({error: 'METHOD'}, 405);
      requireOrigin(request);
      const session = await authenticate(request, env, {now});
      if (session) await directory.revokeSession(session.sessionId);
      return new Response(null, {status: 204, headers: {'Set-Cookie': cookie(SESSION_COOKIE, '', 0), 'Cache-Control': 'no-store'}});
    }
    if (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') {
      if (!localConfigured(env)) return json({error: 'AUTH_UNAVAILABLE'}, 503);
      if (request.method !== 'POST') return json({error: 'METHOD'}, 405);
      // AUTH_ORIGIN pins the exact public origin when set; otherwise the same-origin check already applies.
      if (env.AUTH_ORIGIN && url.origin !== env.AUTH_ORIGIN) return json({error: 'INVALID_ORIGIN'}, 400);
      requireOrigin(request);
      const body = await readJson(request);
      const login = requireLogin(body.login), password = requirePassword(body.password);
      if (url.pathname === '/api/auth/register') {
        const user = await directory.createLocalUser({ login, password, now: now() });
        if (env.ACCOUNTS) await accountOf(env, user.accountId).setProfile(user);
        return json({ ok: true, status: 'pending', login: user.name }, 201);
      }
      const user = await directory.verifyLocalUser({ login, password });
      if (!user) return json({ error: 'BAD_CREDENTIALS' }, 401);
      if (user.status !== 'approved') return json({ error: 'NOT_APPROVED', status: user.status }, 403);
      if (env.ACCOUNTS) await accountOf(env, user.accountId).setProfile(user);
      const { status, createdAt, reviewedAt, ...profile } = user;
      const sessionToken = randomToken();
      await directory.saveSession(await hash(sessionToken), { accountId: profile.accountId, user: profile, expiresAt: now() + ACCOUNT_LIMITS.sessionMs });
      const headers = new Headers({ 'Cache-Control': 'no-store' });
      headers.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, ACCOUNT_LIMITS.sessionMs / 1000));
      return new Response(null, { status: 204, headers });
    }
    if (!configured(env)) return json({error: 'AUTH_UNAVAILABLE'}, 503);
    if (url.origin !== env.AUTH_ORIGIN) return json({error: 'INVALID_ORIGIN'}, 400);
    if (request.method !== 'GET') return json({error: 'METHOD'}, 405);
    const callback = env.AUTH_ORIGIN + '/api/auth/github/callback';
    if (url.pathname === '/api/auth/github/start') {
      const state = randomToken(), verifier = randomToken();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      await directory.saveOAuth(await hash(state), {verifier, expiresAt: now() + ACCOUNT_LIMITS.oauthMs});
      const dest = new URL('https://github.com/login/oauth/authorize');
      dest.search = new URLSearchParams({client_id: env.GITHUB_CLIENT_ID, redirect_uri: callback, state,
        code_challenge: challenge, code_challenge_method: 'S256'}).toString();
      return new Response(null, {status: 302, headers: {Location: dest.href, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(OAUTH_COOKIE, state, 600)}});
    }
    if (url.pathname !== '/api/auth/github/callback') return json({error: 'NOT_FOUND'}, 404);
    const state = url.searchParams.get('state');
    if (!state || !/^[a-f0-9]{64}$/.test(state) || state !== cookieValue(request, OAUTH_COOKIE)) throw new AccountError('OAUTH_STATE');
    const transaction = await directory.consumeOAuth(await hash(state));
    if (!transaction || transaction.expiresAt <= now() || url.searchParams.has('error')) throw new AccountError('OAUTH_EXPIRED_OR_DENIED');
    const code = url.searchParams.get('code');
    if (!code || code.length > 1024) throw new AccountError('OAUTH_CODE');
    const tokens = await providerFetch('https://github.com/login/oauth/access_token', {method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code, code_verifier: transaction.verifier, redirect_uri: callback}).toString(), signal: AbortSignal.timeout(10000)});
    if (!tokens.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const token = await tokens.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const response = await providerFetch('https://api.github.com/user', {headers: {
      Authorization: 'Bearer ' + token.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol'},
      signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const profile = await response.json();
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.login !== 'string') throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const avatarUrl = typeof profile.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url) ? profile.avatar_url : null;
    const user = await directory.resolveGithubUser({id: String(profile.id), login: profile.login.slice(0, 80), name: profile.name, avatarUrl});
    if (env.ACCOUNTS) await accountOf(env, user.accountId).setProfile(user);
    const sessionToken = randomToken();
    await directory.saveSession(await hash(sessionToken), {accountId: user.accountId, user, expiresAt: now() + ACCOUNT_LIMITS.sessionMs});
    const headers = new Headers({Location: '/', 'Cache-Control': 'no-store'});
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, ACCOUNT_LIMITS.sessionMs / 1000));
    headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
    return new Response(null, {status: 303, headers});
  } catch (e) {
    if(url.pathname==='/api/auth/github/callback' && request.headers.get('Accept')?.includes('text/html'))
      return new Response(null,{status:303,headers:{Location:'/?authError=1','Cache-Control':'no-store','Set-Cookie':cookie(OAUTH_COOKIE,'',0)}});
    // Duck-typed on purpose: an AccountError raised inside a Durable Object comes back over RPC
    // without its prototype, so instanceof would report every cross-DO failure as a 502.
    const code = typeof e?.code === 'string' ? e.code : 'AUTH_FAILED';
    const status = Number.isInteger(e?.status) ? e.status : 502;
    return json({error: code}, status);
  }
}
