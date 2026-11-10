import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';
import { env } from '../env.js';
import { withUsage } from '../usage-context.js';

const COOKIE = 'swarm_session';
/** The session cookie's name before the Swarm rename. */
const LEGACY_COOKIE = 'grokbot_session';
const TTL_MS = 30 * 24 * 3600 * 1000;
const cookieOptions = () => ({ httpOnly: true, secure: new URL(env.serverUrl).protocol === 'https:', sameSite: 'Lax' as const, path: '/', maxAge: TTL_MS / 1000 });

export type AuthVars = { Variables: { user: User } };

export function createSession(c: Context, userId: string) {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, now(), now() + TTL_MS);
  setCookie(c, COOKIE, t, cookieOptions());
}

/**
 * The request's session token. A browser signed in before the Swarm rename still sends the old
 * cookie; it is moved to the new name, so the sign-in carries over.
 */
export function sessionToken(c: Context): string | undefined {
  const t = getCookie(c, COOKIE);
  if (t) return t;
  const legacy = getCookie(c, LEGACY_COOKIE);
  if (!legacy) return undefined;
  deleteCookie(c, LEGACY_COOKIE, { path: '/' });
  if (!userFromToken(legacy)) return undefined;
  setCookie(c, COOKIE, legacy, cookieOptions());
  return legacy;
}

export function destroySession(c: Context) {
  const t = sessionToken(c);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  return r ? { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url } : null;
}

export function userFromCookieHeader(cookieHeader: string | undefined): User | null {
  const parts = cookieHeader?.split(/;\s*/) ?? [];
  for (const name of [COOKIE, LEGACY_COOKIE]) {
    const m = parts.find((p) => p.startsWith(`${name}=`));
    if (m) return userFromToken(decodeURIComponent(m.slice(name.length + 1)));
  }
  return null;
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const u = userFromToken(sessionToken(c));
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  await withUsage({ userId: u.id, botId: null }, () => next());
};
