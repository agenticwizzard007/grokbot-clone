import crypto from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';
import { env } from '../env.js';
import { withUsage } from '../usage-context.js';
import { assertTenant, deploymentRole } from '../deployment.js';
import { requestBoundary } from '../security/request.js';
import { sessionRevoked } from '../security/session-lifecycle.js';
import { withSessionContext } from '../security/request-context.js';
import { legacyAccountHeld } from '../platform/legacy-database-fence.js';
const COOKIE = 'swarm_session';
const LEGACY_COOKIE = 'grokbot_session';
const TTL = 7 * 24 * 3600_000;
const IDLE = 24 * 3600_000;
export type AuthVars = { Variables: { user: User } };
export const sessionHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const cookieOptions = (maxAge = TTL / 1000) => ({ httpOnly: true, secure: new URL(env.serverUrl).protocol === 'https:', sameSite: 'Lax' as const, path: '/', maxAge });
/** Cookie-name migration is limited to standalone installs and never extends a session. */
export function sessionToken(c: Context): string | undefined {
  const current = getCookie(c, COOKIE);
  if (current !== undefined || deploymentRole !== 'standalone') return current;
  const legacy = getCookie(c, LEGACY_COOKIE);
  if (!legacy) return undefined;
  deleteCookie(c, LEGACY_COOKIE, { path: '/' });
  if (!userFromToken(legacy)) return undefined;
  const row = db.prepare('SELECT expires_at,created_at FROM auth_sessions WHERE token=?').get(sessionHash(legacy)) as { expires_at: number; created_at: number };
  const remaining = Math.floor((Math.min(row.expires_at, row.created_at + TTL) - now()) / 1000);
  if (remaining <= 0) return undefined;
  setCookie(c, COOKIE, legacy, cookieOptions(remaining));
  return legacy;
}
export function createSession(c: Context, userId: string) {
  assertTenant(userId);
  if (legacyAccountHeld(db, userId)) throw new Error('This account is being migrated.');
  const previous = sessionToken(c);
  if (previous) revokeSession(sessionHash(previous));
  const raw = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (?,?,?,?,?,?)').run(sessionHash(raw), userId, now(), now() + TTL, now(), now());
  setCookie(c, COOKIE, raw, cookieOptions());
  if (deploymentRole === 'standalone') deleteCookie(c, LEGACY_COOKIE, { path: '/' });
}
export function destroySession(c: Context) {
  const raw = sessionFromCookie(c.req.header('cookie'));
  if (raw) revokeSession(sessionHash(raw));
  deleteCookie(c, COOKIE, { path: '/' });
  if (deploymentRole === 'standalone') deleteCookie(c, LEGACY_COOKIE, { path: '/' });
}
export function revokeSession(hash: string) {
  db.prepare('DELETE FROM auth_sessions WHERE token=?').run(hash);
  sessionRevoked(hash);
}
export function revokeUserSessions(userId: string) {
  const sessions = db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').all(userId) as { token: string }[];
  db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
  for (const s of sessions) sessionRevoked(s.token);
}
export function userFromSessionHash(hash: string | undefined): User | null {
  if (!hash) return null;
  const row = db.prepare(`SELECT u.*,s.last_seen_at FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>? AND s.created_at>? AND (CASE WHEN s.last_seen_at=0 THEN s.created_at ELSE s.last_seen_at END)>?`).get(hash, now(), now() - TTL, now() - IDLE) as any;
  if (!row) return null;
  if (legacyAccountHeld(db, row.id)) return null;
  try { assertTenant(row.id); } catch { return null; }
  if (now() - row.last_seen_at > 60_000) db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token=?').run(now(), hash);
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
}
export function userFromToken(raw: string | undefined): User | null {
  return raw && raw.length <= 256 ? userFromSessionHash(sessionHash(raw)) : null;
}
export function sessionFromCookie(cookie: string | undefined): string | undefined {
  try {
    const parts = cookie?.split(/;\s*/) ?? [];
    for (const name of deploymentRole === 'standalone' ? [COOKIE, LEGACY_COOKIE] : [COOKIE]) {
      const part = parts.find(p => p.startsWith(`${name}=`));
      if (part !== undefined) return decodeURIComponent(part.slice(name.length + 1));
    }
  } catch { /* Malformed cookies are unauthenticated. */ }
  return undefined;
}
export function userFromCookieHeader(cookie: string | undefined) { return userFromToken(sessionFromCookie(cookie)); }
export function recentlyAuthenticated(c: Context): boolean {
  const raw = sessionToken(c);
  if (!raw || !userFromToken(raw)) return false;
  return !!db.prepare('SELECT 1 FROM auth_sessions WHERE token=? AND authenticated_at>?').get(sessionHash(raw), now() - 10 * 60_000);
}
export const requireRecentAuth: MiddlewareHandler = async (c, next) => {
  if (!recentlyAuthenticated(c)) return c.json({ error: 'Sign in again to continue.', code: 'reauth_required' }, 401);
  await next();
};
export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const raw = sessionToken(c), user = userFromToken(raw);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', user);
  return withSessionContext(sessionHash(raw!), () => requestBoundary(c, () => withUsage({ userId: user.id, botId: null }, () => next())));
};
