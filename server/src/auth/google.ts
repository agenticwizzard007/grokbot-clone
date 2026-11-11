import { legacyWritableRows } from '../platform/legacy-database-fence.js';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { createAccount } from '../accounts.js';
import { createSession, recentlyAuthenticated, userFromCookieHeader, sessionHash, userFromSessionHash } from '../lib/auth.js';
import { finishNativeLogin } from '../native-auth.js';
import { sealSecret, unsealSecret } from '../settings.js';
import { exchangeGoogleCode, googleAuthorization, googleAvailable, randomProof, type GoogleIdentity } from './google-provider.js';
import { isTenant } from '../deployment.js';
import { newId } from '../lib/ids.js';
import { deleteGoogleLoginConnection, GoogleLoginError, googleProfile, ownGmailMailboxes, startGoogleLogin } from '../composio.js';
const COOKIE = 'swarm_google_attempt';
const TTL = 10 * 60_000;
const callback = () => `${env.serverUrl.replace(/\/$/, '')}/api/auth/google/callback`;
const fail = (c: Context, code: string) => c.redirect(finishNativeLogin(c, undefined, code) ?? `${env.appUrl}/?login=${code}`);
db.exec(`CREATE TABLE IF NOT EXISTS google_identities(subject TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS google_oidc_attempts(id TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,
 link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,link_session TEXT REFERENCES auth_sessions(token) ON DELETE CASCADE,expires_at INTEGER NOT NULL);`);
interface Attempt { id: string; nonce: string; verifier: string; link_user_id: string | null; link_session: string | null; expires_at: number }
/** Without a Google OAuth client, sign-in uses a Composio-managed Gmail authorization (the verified mailbox). */
const COMPOSIO_NONCE = 'composio-gmail';
const MAILBOX = 'gmail-mailbox:';
const composioGoogle = () => !googleAvailable() && env.composioEnabled && !isTenant;
export const googleSignInAvailable = () => googleAvailable() || composioGoogle();
export const googleLinked = (userId: string) => !!db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(userId);
export function resolveGoogleAccount(identity: GoogleIdentity, linking?: { userId: string; sessionHash: string }, preferId?: string) {
  return db.transaction(() => {
    if (linking && userFromSessionHash(linking.sessionHash)?.id !== linking.userId) throw new Error('google_link_required');
    const existing = db.prepare('SELECT user_id FROM google_identities WHERE subject=?').get(identity.subject) as { user_id: string } | undefined;
    if (existing && linking && existing.user_id !== linking.userId) throw new Error('google_already_linked');
    if (existing) return existing.user_id;
    const userId = linking?.userId ?? createAccount({ email: identity.email, name: identity.name, preferId }).id;
    if (db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(userId)) throw new Error('google_already_linked');
    db.prepare('INSERT INTO google_identities VALUES (?,?)').run(identity.subject, userId);
    return userId;
  })();
}
/**
 * Bind a verified Gmail mailbox, never by matching the editable users.email. An account created by the
 * earlier Google sign-in (before bindings existed) is adopted only when that same account still holds its
 * own ACTIVE Gmail authorization for this mailbox; otherwise an existing email fails closed (link required).
 */
export async function resolveGoogleMailbox(email: string, provisionalId: string, linking?: { userId: string; sessionHash: string }) {
  const identity = { subject: MAILBOX + email, email };
  const bound = db.prepare('SELECT user_id FROM google_identities WHERE subject=?').get(identity.subject);
  if (!bound && !linking) {
    const legacy = db.prepare('SELECT id FROM users WHERE lower(email)=? AND id<>? AND NOT EXISTS (SELECT 1 FROM google_identities g WHERE g.user_id=users.id)').get(email, provisionalId) as { id: string } | undefined;
    if (legacy && (await ownGmailMailboxes(legacy.id)).has(email)) {
      return db.transaction(() => {
        if (db.prepare('SELECT 1 FROM google_identities WHERE subject=? OR user_id=?').get(identity.subject, legacy.id)) throw new Error('google_already_linked');
        db.prepare('INSERT INTO google_identities VALUES (?,?)').run(identity.subject, legacy.id);
        return legacy.id;
      })();
    }
  }
  return resolveGoogleAccount(identity, linking, provisionalId);
}
export const googleAuth = new Hono();
googleAuth.get('/start', async c => {
  const linking = c.req.query('intent') === 'link';
  const user = userFromCookieHeader(c.req.header('cookie'));
  if (linking && (!user || !recentlyAuthenticated(c))) return fail(c, 'google_link_required');
  db.prepare(`DELETE FROM google_oidc_attempts WHERE expires_at<=? AND ${legacyWritableRows(db, 'google_oidc_attempts')}`).run(now());
  if ((db.prepare('SELECT count(*) n FROM google_oidc_attempts').get() as { n: number }).n >= 2000) return fail(c, 'google_busy');
  const id = randomProof(), nonce = randomProof(), verifier = randomProof();
  const secure = new URL(env.serverUrl).protocol === 'https:';
  if (composioGoogle()) {
    try {
      const provisional = newId('usr');
      const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, `${callback()}?state=${id}`);
      db.prepare('INSERT INTO google_oidc_attempts VALUES (?,?,?,?,?,?)').run(id, COMPOSIO_NONCE, sealSecret(JSON.stringify({ provisional, account: connectedAccountId })), linking ? user!.id : null, linking ? sessionHash(getCookie(c, 'swarm_session')!) : null, now() + TTL);
      setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure, path: '/api/auth/google', maxAge: TTL / 1000 });
      return c.redirect(redirectUrl);
    } catch { return fail(c, 'google_unavailable'); }
  }
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
  if (a.nonce === COMPOSIO_NONCE) {
    if (c.req.query('status') === 'failed') return fail(c, 'google_denied');
    let attempt: { provisional?: unknown; account?: unknown } | null = null;
    try { attempt = JSON.parse(unsealSecret(a.verifier) ?? 'null'); } catch { attempt = null; }
    if (typeof attempt?.provisional !== 'string' || typeof attempt.account !== 'string') return fail(c, 'google_invalid');
    const returned = c.req.query('connected_account_id');
    if (returned && returned !== attempt.account) return fail(c, 'google_session');
    try {
      const { email } = await googleProfile(attempt.account, attempt.provisional);
      const userId = await resolveGoogleMailbox(email, attempt.provisional, a.link_user_id ? { userId: a.link_user_id, sessionHash: a.link_session! } : undefined);
      // The sign-in authorization stays only as a new account's own Gmail connection.
      if (userId !== attempt.provisional) await deleteGoogleLoginConnection(attempt.account);
      createSession(c, userId);
      return c.redirect(finishNativeLogin(c, userId) ?? `${env.appUrl}/`);
    } catch (error) {
      await deleteGoogleLoginConnection(attempt.account);
      if (error instanceof GoogleLoginError) return fail(c, error.code);
      const code = error instanceof Error && ['google_link_required', 'google_already_linked', 'email_link_required'].includes(error.message) ? (error.message === 'google_already_linked' ? 'google_already_linked' : 'google_link_required') : 'google_invalid';
      return fail(c, code);
    }
  }
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
