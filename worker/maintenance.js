// Site-wide maintenance gate.
//
// Two requirements shape this file. First, taking the site down must not require a deploy: a deploy
// evicts every Durable Object and drops live matches, which is exactly what an operator either cannot
// afford or is trying to avoid. So the switch lives in the site directory and is read at runtime.
// Second, the gate sits on the hot path of every request, and the directory is a single SQLite object,
// so the state is cached per isolate for a few seconds instead of costing one round trip per request.
import { adminConfigured, tokenMatches } from './accounts/admin.js';
import { cookieValue, directoryOf, hash } from './accounts/auth.js';

const PASS_COOKIE = 'sp_pass';
const PASS_SECONDS = 12 * 3600;
// A maintenance switch is not a real-time control: 10 s is far below the time it takes anyone to
// notice, and it keeps the directory from being pinged once per request per isolate.
const STATE_CACHE_MS = 10_000;
// If the directory cannot answer, serve the site (fail open) and retry soon. Being unable to read the
// flag must not become an outage of its own, and `SITES` is already how every page is gated anyway.
const FAIL_CACHE_MS = 3_000;

let cache = { at: 0, ttl: 0, value: null };

export async function maintenanceState(env) {
  if (!env.SITES) return null;
  const now = Date.now();
  if (now - cache.at < cache.ttl) return cache.value;
  try {
    const value = (await directoryOf(env).maintenance()) || null;
    cache = { at: now, ttl: STATE_CACHE_MS, value };
    return value;
  } catch (e) {
    console.error('[maintenance]', e?.stack || e?.message || e);
    cache = { at: now, ttl: FAIL_CACHE_MS, value: null };
    return null;
  }
}

/** Only the operator gets past the gate: the admin token itself, or the cookie it hands out. */
async function operatorPass(request, env) {
  if (!adminConfigured(env)) return false;
  const header = request.headers.get('X-Admin-Token');
  if (header && await tokenMatches(header, env.ADMIN_TOKEN)) return true;
  const cookieToken = cookieValue(request, PASS_COOKIE);
  if (cookieToken && await tokenMatches(cookieToken, await hash(env.ADMIN_TOKEN))) return true;
  return false;
}

const passCookie = (value) =>
  `${PASS_COOKIE}=${value}; Path=/; Max-Age=${PASS_SECONDS}; Secure; HttpOnly; SameSite=Lax`;

/**
 * Returns a Response to short-circuit the request, or null to let it through.
 * `/admin`, its API and `/healthz` are never gated: the operator has to be able to turn this off.
 */
export async function maintenanceGuard(request, env) {
  if (!env.SITES) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/admin' || path === '/healthz' || path.startsWith('/api/admin/')) return null;
  // `?key=<ADMIN_TOKEN>` trades the token for a cookie and redirects, so the secret stops travelling
  // in URLs (and in the Referer header of everything the page loads).
  const key = url.searchParams.get('key');
  if (key && request.method === 'GET' && adminConfigured(env) && await tokenMatches(key, env.ADMIN_TOKEN)) {
    const clean = new URL(url);
    clean.searchParams.delete('key');
    return new Response(null, { status: 303, headers: {
      Location: clean.pathname + clean.search,
      'Set-Cookie': passCookie(await hash(env.ADMIN_TOKEN)),
      'Cache-Control': 'no-store',
    } });
  }
  if (await operatorPass(request, env)) return null;
  const state = await maintenanceState(env);
  if (!state?.enabled) return null;
  return new Response(maintenancePage(state), {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '600',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function maintenancePage(state) {
  const message = typeof state.message === 'string' && state.message.trim()
    ? state.message.trim().slice(0, 500) : '服务器正在维护，请稍后再来。';
  const until = Number.isSafeInteger(state.until) && state.until > Date.now()
    ? new Date(state.until).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : null;
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>维护中 · 卫戍协议</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --panel:#1c1f26; --line:#2b303b; --text:#e8eaee;
          --muted:#98a0ae; --accent:#6aa8ff; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--text);
         font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding:24px; }
  .card { width:100%; max-width:520px; background:var(--panel); border:1px solid var(--line);
          border-radius:14px; padding:32px 28px; }
  h1 { font-size:20px; margin:0 0 6px; }
  .tag { display:inline-block; font-size:12px; color:var(--accent); border:1px solid currentColor;
         border-radius:99px; padding:1px 10px; margin-bottom:18px; }
  p { margin:0 0 12px; color:var(--text); }
  .muted { color:var(--muted); font-size:13px; }
  .until { margin-top:18px; padding-top:16px; border-top:1px solid var(--line); font-size:13px; color:var(--muted); }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--accent);
         margin-right:7px; animation:pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
</style></head>
<body><main class="card">
  <span class="tag"><span class="dot"></span>维护中</span>
  <h1>卫戍协议 · 正在维护</h1>
  <p>${escapeHtml(message)}</p>
  <p class="muted">此页面每 60 秒自动重试，恢复后无需手动刷新。</p>
  ${until ? `<p class="until">预计恢复时间：${escapeHtml(until)}（北京时间）</p>` : ''}
</main>
<script>setTimeout(() => location.reload(), 60000);</script>
</body></html>`;
}
