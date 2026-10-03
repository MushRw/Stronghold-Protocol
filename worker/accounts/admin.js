// Operator-only account review for self-hosted ("local") accounts. The whole surface disappears until
// ADMIN_TOKEN is set, and every call must present it: this is the only way to let a stranger play.
import { AccountError, requireLogin, requireReview } from '../../shared/account-protocol.js';
import { directoryOf, hash, json, requireOrigin } from './auth.js';

const TOKEN_MIN = 32;
/** SHA-256 both sides first so the comparison length no longer depends on the secret. */
async function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false;
  const [a, b] = await Promise.all([hash(presented), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function adminConfigured(env) {
  return typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= TOKEN_MIN;
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
export async function handleAdminRoutes(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin/')) return null;
  if (!env.SITES || !adminConfigured(env)) return json({ error: 'NOT_FOUND' }, 404);
  try {
    const presented = request.headers.get('X-Admin-Token') || new URL(request.url).searchParams.get('token') || '';
    if (!await tokenMatches(presented, env.ADMIN_TOKEN)) return json({ error: 'FORBIDDEN' }, 403);
    const directory = directoryOf(env);
    if (path === '/api/admin/accounts' && request.method === 'GET') {
      const status = new URL(request.url).searchParams.get('status') || '';
      return json({ items: await directory.listLocalUsers({ status }) });
    }
    if (path === '/api/admin/review' && request.method === 'POST') {
      requireOrigin(request);
      const payload = await body(request);
      return json(await directory.reviewLocalUser({
        login: requireLogin(payload.login), status: requireReview(payload.status) }));
    }
    return json({ error: 'NOT_FOUND' }, 404);
  } catch (e) {
    return json({ error: e.code || 'ADMIN_UNAVAILABLE' }, e.status || 503);
  }
}
