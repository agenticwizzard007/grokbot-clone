import { legacyWritableRows } from '../platform/legacy-database-fence.js';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { createAccount } from '../accounts.js';
import { createSession, recentlyAuthenticated, userFromCookieHeader, sessionHash, userFromSessionHash } from '../lib/auth.js';
import { finishNativeLogin } from '../native-auth.js';
import { sealSecret, unsealSecret } from '../settings.js';
import { exchangeGoogleCode, googleAuthorization, randomProof, type GoogleIdentity } from './google-provider.js';
const COOKIE = 'swarm_google_attempt';
const TTL = 10 * 60_000;
const callback = () => `${env.serverUrl.replace(/\/$/, '')}/api/auth/google/callback`;
const fail = (c: Context, code: string) => c.redirect(finishNativeLogin(c, undefined, code) ?? `${env.appUrl}/?login=${code}`);
db.exec(`CREATE TABLE IF NOT EXISTS google_identities(subject TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS google_oidc_attempts(id TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,
 link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,link_session TEXT REFERENCES auth_sessions(token) ON DELETE CASCADE,expires_at INTEGER NOT NULL);`);
interface Attempt { id: string; nonce: string; verifier: string; link_user_id: string | null; link_session: string | null; expires_at: number }
export function resolveGoogleAccount(identity: GoogleIdentity, linking?: { userId: string; sessionHash: string }) {
  return db.transaction(() => {
    if (linking && userFromSessionHash(linking.sessionHash)?.id !== linking.userId) throw new Error('google_link_required');
    const existing = db.prepare('SELECT user_id FROM google_identities WHERE subject=?').get(identity.subject) as { user_id: string } | undefined;
    if (existing && linking && existing.user_id !== linking.userId) throw new Error('google_already_linked');
    if (existing) return existing.user_id;
    const userId = linking?.userId ?? createAccount({ email: identity.email, name: identity.name }).id;
    if (db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(userId)) throw new Error('google_already_linked');
    db.prepare('INSERT INTO google_identities VALUES (?,?)').run(identity.subject, userId);
    return userId;
  })();
}
export const googleAuth = new Hono();
googleAuth.get('/start', c => {
  const linking = c.req.query('intent') === 'link';
  const user = userFromCookieHeader(c.req.header('cookie'));
  if (linking && (!user || !recentlyAuthenticated(c))) return fail(c, 'google_link_required');
  db.prepare(`DELETE FROM google_oidc_attempts WHERE expires_at<=? AND ${legacyWritableRows(db, 'google_oidc_attempts')}`).run(now());
  if ((db.prepare('SELECT count(*) n FROM google_oidc_attempts').get() as { n: number }).n >= 2000) return fail(c, 'google_busy');
  const id = randomProof(), nonce = randomProof(), verifier = randomProof();
  try {
    const url = googleAuthorization(callback(), id, nonce, verifier);
    db.prepare('INSERT INTO google_oidc_attempts VALUES (?,?,?,?,?,?)').run(id, nonce, sealSecret(verifier), linking ? user!.id : null, linking ? sessionHash(getCookie(c, 'swarm_session')!) : null, now() + TTL);
    setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure: new URL(env.serverUrl).protocol === 'https:', path: '/api/auth/google', maxAge: TTL / 1000 });
    return c.redirect(url);
  } catch { return fail(c, 'google_unavailable'); }
});
googleAuth.get('/callback', async c => {
  const id = c.req.query('state');
  if (!id || getCookie(c, COOKIE) !== id) return fail(c, 'google_session');
  deleteCookie(c, COOKIE, { path: '/api/auth/google' });
  const a = db.prepare('DELETE FROM google_oidc_attempts WHERE id=? AND expires_at>? RETURNING *').get(id, now()) as Attempt | undefined;
  if (!a) return fail(c, 'google_session');
  if (c.req.query('error')) return fail(c, 'google_denied');
  if (a.link_user_id && sessionHash(getCookie(c, 'swarm_session') ?? '') !== a.link_session) return fail(c, 'google_link_required');
  try {
    const verifier = unsealSecret(a.verifier);
    if (!verifier) throw new Error('google_invalid');
    const identity = await exchangeGoogleCode(c.req.query('code') ?? '', verifier, a.nonce, callback());
    const userId = resolveGoogleAccount(identity, a.link_user_id ? { userId: a.link_user_id, sessionHash: a.link_session! } : undefined);
    createSession(c, userId);
    return c.redirect(finishNativeLogin(c, userId) ?? `${env.appUrl}/`);
  } catch (error) {
    const code = error instanceof Error && ['google_link_required', 'google_already_linked', 'email_link_required'].includes(error.message) ? 'google_link_required' : 'google_invalid';
    return fail(c, code);
  }
});
