export const ACCOUNT_LIMITS = Object.freeze({
  sessionMs: 30 * 86400000, oauthMs: 600000, applicationMs: 120000,
  reservationMs: 30000, leaseMs: 60000, heartbeatMs: 20000, pageSize: 50,
});
/**
 * Self-hosted ("local") accounts: a login plus a password an operator reviews by hand. The password
 * never leaves the browser in a recoverable form — the site directory only stores a PBKDF2 verifier.
 */
export const LOCAL_AUTH = Object.freeze({
  // workerd's WebCrypto rejects a PBKDF2 iteration count above 100000 ("Pbkdf2 failed: iteration counts
  // above 100000 are not supported"), so this is the platform ceiling, not a free choice.
  iterations: 100000, minPassword: 8, maxPassword: 128, maxLogin: 24,
  statuses: ['pending', 'approved', 'rejected'],
});
export class AccountError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function requireId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new AccountError('INVALID_ID');
  return value;
}
export function pageLimit(value = 20) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACCOUNT_LIMITS.pageSize) throw new AccountError('INVALID_PAGE');
  return value;
}
/** A callsign a human can read out loud: letters, digits, spaces and a few separators. */
export function requireLogin(value) {
  const login = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,23}$/u.test(login)) throw new AccountError('INVALID_LOGIN');
  return login;
}
export function requirePassword(value) {
  if (typeof value !== 'string' || value.length < LOCAL_AUTH.minPassword || value.length > LOCAL_AUTH.maxPassword) {
    throw new AccountError('INVALID_PASSWORD');
  }
  return value;
}
export function requireReview(value) {
  if (!LOCAL_AUTH.statuses.includes(value)) throw new AccountError('INVALID_REVIEW');
  return value;
}
