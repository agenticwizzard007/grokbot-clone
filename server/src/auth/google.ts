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
import { deleteProvisionalAuthorizations, GoogleLoginError, googleIdentityFor, googleLoginStatus, ownGoogleSubjects, startGoogleLogin } from '../composio.js';
const COOKIE = 'swarm_google_attempt';
const TTL = 10 * 60_000;
// Composio-managed consent is slower (Google consent plus the Composio hop), so it gets a longer window.
const COMPOSIO_TTL = 30 * 60_000;
// An authorization whose Google consent is still open is only cleaned up once it is older than this.
const CONSENT_GRACE = 60 * 60_000;
// A browser may hold a few attempts at once (for example a second tab), so a new start never breaks an earlier one.
const ATTEMPTS_PER_BROWSER = 3;
const attemptIds = (c: Context) => (getCookie(c, COOKIE) ?? '').split('.').filter(v => /^[A-Za-z0-9_-]{43}$/.test(v)).slice(-ATTEMPTS_PER_BROWSER);
const writeAttempts = (c: Context, ids: string[]) => {
  if (!ids.length) { deleteCookie(c, COOKIE, { path: '/api/auth/google' }); return; }
  setCookie(c, COOKIE, ids.slice(-ATTEMPTS_PER_BROWSER).join('.'), { httpOnly: true, sameSite: 'Lax', secure: new URL(env.serverUrl).protocol === 'https:', path: '/api/auth/google', maxAge: COMPOSIO_TTL / 1000 });
};
const signedIn = () => `${env.appUrl}/?signed_in=1`;
const callback = () => `${env.serverUrl.replace(/\/$/, '')}/api/auth/google/callback`;
const fail = (c: Context, code: string) => c.redirect(finishNativeLogin(c, undefined, code) ?? `${env.appUrl}/?login=${code}`);
db.exec(`CREATE TABLE IF NOT EXISTS google_identities(subject TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS google_oidc_attempts(id TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,
 link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,link_session TEXT REFERENCES auth_sessions(token) ON DELETE CASCADE,expires_at INTEGER NOT NULL);`);
interface Attempt { id: string; nonce: string; verifier: string; link_user_id: string | null; link_session: string | null; expires_at: number }
/**
 * Without a Google OAuth client, sign-in uses a Composio-managed Gmail authorization. Its token yields Google's
 * immutable subject, bound exactly like OIDC (google_identities.subject). Each attempt also leaves a durable,
 * browser-unusable cleanup record naming its throwaway Composio user, so abandoned, failed, expired or
 * session-revoked attempts never strand a Gmail authorization.
 */
const COMPOSIO_NONCE = 'composio-gmail';
const CLEANUP_NONCE = 'composio-cleanup';
// A durable, irreversible claim: no callback may promote an id once cleanup starts.
const CLEANING_NONCE = 'composio-cleaning';
const cleanupId = (attemptId: string) => `cleanup:${attemptId}`;
type Provisional = { provisional: string; account?: string; pending?: boolean; created?: number };
const sealedProvisional = (verifier: string) => { try { const v = JSON.parse(unsealSecret(verifier) ?? 'null'); return typeof v?.provisional === 'string' ? v as Provisional : null; } catch { return null; } };
/** Claim before any provider await. Promotion checks this same record in its write transaction. */
async function releaseProvisional(rowId: string, provisional: string) {
  const claimed = db.transaction(() => {
    const row = db.prepare('SELECT nonce,verifier FROM google_oidc_attempts WHERE id=?').get(rowId) as { nonce: string; verifier: string } | undefined;
    if (!row || ![CLEANUP_NONCE, CLEANING_NONCE].includes(row.nonce) || sealedProvisional(row.verifier)?.provisional !== provisional) return false;
    if (db.prepare('SELECT 1 FROM users WHERE id=?').get(provisional)) {
      db.prepare('DELETE FROM google_oidc_attempts WHERE id=?').run(rowId);
      return false;
    }
    db.prepare('UPDATE google_oidc_attempts SET nonce=?,expires_at=? WHERE id=?').run(CLEANING_NONCE, now() + TTL, rowId);
    return true;
  }).immediate();
  if (!claimed) return;
  if (await deleteProvisionalAuthorizations(provisional)) {
    db.transaction(() => {
      const row = db.prepare('SELECT verifier FROM google_oidc_attempts WHERE id=? AND nonce=?').get(rowId, CLEANING_NONCE) as { verifier: string } | undefined;
      // A remote authorize call can still create its connection after an empty list. Keep retrying until it settles.
      if (row && !sealedProvisional(row.verifier)?.pending) db.prepare('DELETE FROM google_oidc_attempts WHERE id=? AND nonce=?').run(rowId, CLEANING_NONCE);
    }).immediate();
  }
  // A failed delete leaves the durable cleaning claim for a later process/sweep. Never reopen promotion.
}
/** Resolve and remove/claim the cleanup record atomically, with no external await inside the transaction. */
function finishComposioResolution(attemptId: string, provisional: string, resolve: () => string) {
  return db.transaction(() => {
    const row = db.prepare('SELECT nonce,verifier FROM google_oidc_attempts WHERE id=?').get(cleanupId(attemptId)) as { nonce: string; verifier: string } | undefined;
    if (row?.nonce !== CLEANUP_NONCE || sealedProvisional(row.verifier)?.provisional !== provisional) throw new Error('google_session');
    const userId = resolve();
    if (userId === provisional) db.prepare('DELETE FROM google_oidc_attempts WHERE id=?').run(cleanupId(attemptId));
    else db.prepare('UPDATE google_oidc_attempts SET nonce=?,expires_at=? WHERE id=?').run(CLEANING_NONCE, now() + TTL, cleanupId(attemptId));
    return userId;
  }).immediate();
}
/**
 * True when an expired, unclaimed attempt must be kept for now: it belongs to the browser that triggered this sweep
 * and is still inside its window, or its Google consent may still be open (Composio reports INITIATED/INITIALIZING,
 * or the status lookup failed). Never past CONSENT_GRACE. Records without a creation time predate this rule.
 */
async function keepForConsent(rowId: string, sealed: Provisional, keep: ReadonlySet<string>) {
  const age = now() - (sealed.created ?? -Infinity);
  if (age >= CONSENT_GRACE) return false;
  if (keep.has(rowId) && age < COMPOSIO_TTL) return true;
  // No consent link was ever handed out without a recorded account, so nothing can be waiting on Google.
  if (!sealed.account) return false;
  if (!db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=? AND nonce=?').get(rowId, CLEANUP_NONCE)) return false;
  let consenting: boolean;
  try { consenting = ['INITIATED', 'INITIALIZING'].includes((await googleLoginStatus(sealed.account)) ?? ''); }
  catch { consenting = true; }
  if (consenting) {
    // Recheck later, without letting kept rows crowd out the sweep's batch.
    db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=? AND nonce=?').run(Math.min(now() + 5 * 60_000, sealed.created! + CONSENT_GRACE), rowId, CLEANUP_NONCE);
  }
  return consenting;
}
let sweeping = false;
export async function sweepGoogleLoginAuthorizations(options: { keep?: readonly string[] } = {}) {
  if (isTenant || !env.composioEnabled || sweeping) return;
  sweeping = true;
  try {
    const keep = new Set((options.keep ?? []).map(cleanupId));
    const rows = db.prepare('SELECT id,nonce,verifier FROM google_oidc_attempts WHERE nonce IN (?,?) AND expires_at<=? ORDER BY expires_at LIMIT 50').all(CLEANUP_NONCE, CLEANING_NONCE, now()) as { id: string; nonce: string; verifier: string }[];
    for (const row of rows) {
      const sealed = sealedProvisional(row.verifier);
      if (!sealed) db.prepare('DELETE FROM google_oidc_attempts WHERE id=?').run(row.id);
      else if (row.nonce === CLEANUP_NONCE && await keepForConsent(row.id, sealed, keep)) continue;
      else await releaseProvisional(row.id, sealed.provisional);
    }
  } finally { sweeping = false; }
}
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
 * Resolve a Composio-attested Google identity exactly like OIDC (by immutable subject). An account created by the
 * earlier Google sign-in (before bindings existed) is adopted only when that same account still holds its own ACTIVE
 * Gmail authorization for this same Google subject; any other existing email fails closed (link required).
 */
export async function resolveComposioGoogle(identity: GoogleIdentity, provisionalId: string, attemptId: string, linking?: { userId: string; sessionHash: string }) {
  const bound = db.prepare('SELECT 1 FROM google_identities WHERE subject=?').get(identity.subject);
  if (!bound && !linking) {
    const legacy = db.prepare('SELECT id FROM users WHERE lower(email)=? AND id<>? AND NOT EXISTS (SELECT 1 FROM google_identities g WHERE g.user_id=users.id)').get(identity.email, provisionalId) as { id: string } | undefined;
    if (legacy && (await ownGoogleSubjects(legacy.id)).has(identity.subject)) {
      return finishComposioResolution(attemptId, provisionalId, () => {
        if (db.prepare('SELECT 1 FROM google_identities WHERE subject=? OR user_id=?').get(identity.subject, legacy.id)) throw new Error('google_already_linked');
        db.prepare('INSERT INTO google_identities VALUES (?,?)').run(identity.subject, legacy.id);
        return legacy.id;
      });
    }
  }
  return finishComposioResolution(attemptId, provisionalId, () => resolveGoogleAccount(identity, linking, provisionalId));
}
// Outstanding fallback authorizations still need cleanup after OIDC is enabled, including on restart.
// Install regardless of current credentials so later Settings changes can also enable cleanup.
if (!isTenant) {
  void sweepGoogleLoginAuthorizations().catch(() => {});
  setInterval(() => { void sweepGoogleLoginAuthorizations().catch(() => {}); }, 5 * 60_000).unref();
}
export const googleAuth = new Hono();
googleAuth.get('/start', async c => {
  const linking = c.req.query('intent') === 'link';
  const user = userFromCookieHeader(c.req.header('cookie'));
  if (linking && (!user || !recentlyAuthenticated(c))) return fail(c, 'google_link_required');
  db.prepare(`DELETE FROM google_oidc_attempts WHERE expires_at<=? AND nonce NOT IN ('${CLEANUP_NONCE}','${CLEANING_NONCE}') AND ${legacyWritableRows(db, 'google_oidc_attempts')}`).run(now());
  const held = attemptIds(c);
  // A new start never sweeps this browser's own attempts inside their window.
  void sweepGoogleLoginAuthorizations({ keep: held }).catch(() => {});
  const earlier = held.filter(v => db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=? AND expires_at>?').get(v, now()));
  if ((db.prepare('SELECT count(*) n FROM google_oidc_attempts').get() as { n: number }).n >= 2000) return fail(c, 'google_busy');
  const id = randomProof(), nonce = randomProof(), verifier = randomProof();
  if (composioGoogle()) {
    const provisional = newId('usr'), created = now();
    // Recorded before any authorization exists, so a crash or failure after creation is still cleaned up.
    db.prepare('INSERT INTO google_oidc_attempts VALUES (?,?,?,?,?,?)').run(cleanupId(id), CLEANUP_NONCE, sealSecret(JSON.stringify({ provisional, pending: true, created })), null, null, now() + COMPOSIO_TTL + 60_000);
    try {
      const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, `${callback()}?state=${id}`);
      db.prepare('UPDATE google_oidc_attempts SET verifier=? WHERE id=? AND nonce IN (?,?)').run(sealSecret(JSON.stringify({ provisional, account: connectedAccountId, created })), cleanupId(id), CLEANUP_NONCE, CLEANING_NONCE);
      db.transaction(() => {
        // A slow authorize response must not reopen an attempt already claimed by cleanup.
        if (!db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=? AND nonce=?').get(cleanupId(id), CLEANUP_NONCE)) throw new Error('google_session');
        db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now() + COMPOSIO_TTL + 60_000, cleanupId(id));
        db.prepare('INSERT INTO google_oidc_attempts VALUES (?,?,?,?,?,?)').run(id, COMPOSIO_NONCE, sealSecret(JSON.stringify({ provisional, account: connectedAccountId })), linking ? user!.id : null, linking ? sessionHash(getCookie(c, 'swarm_session')!) : null, now() + COMPOSIO_TTL);
      }).immediate();
      writeAttempts(c, [...earlier, id]);
      return c.redirect(redirectUrl);
    } catch {
      db.prepare('UPDATE google_oidc_attempts SET verifier=? WHERE id=? AND nonce IN (?,?)').run(sealSecret(JSON.stringify({ provisional, created })), cleanupId(id), CLEANUP_NONCE, CLEANING_NONCE);
      await releaseProvisional(cleanupId(id), provisional).catch(() => {});
      return fail(c, 'google_unavailable');
    }
  }
  try {
    const url = googleAuthorization(callback(), id, nonce, verifier);
    db.prepare('INSERT INTO google_oidc_attempts VALUES (?,?,?,?,?,?)').run(id, nonce, sealSecret(verifier), linking ? user!.id : null, linking ? sessionHash(getCookie(c, 'swarm_session')!) : null, now() + TTL);
    writeAttempts(c, [...earlier, id]);
    return c.redirect(url);
  } catch { return fail(c, 'google_unavailable'); }
});
googleAuth.get('/callback', async c => {
  const id = c.req.query('state');
  const held = attemptIds(c);
  if (!id || !held.includes(id)) return fail(c, 'google_session');
  // Consume only this attempt; any other attempt from this browser stays usable.
  writeAttempts(c, held.filter(v => v !== id));
  const a = db.prepare('DELETE FROM google_oidc_attempts WHERE id=? AND nonce NOT IN (?,?) AND expires_at>? RETURNING *').get(id, CLEANUP_NONCE, CLEANING_NONCE, now()) as Attempt | undefined;
  if (!a) return fail(c, 'google_session');
  if (a.nonce === COMPOSIO_NONCE) {
    // Only the sealed server-side record selects what is kept or removed; callback parameters never do.
    const sealed = sealedProvisional(a.verifier);
    if (!sealed || typeof sealed.account !== 'string') return fail(c, 'google_invalid');
    const finishWith = async (code: string) => { await releaseProvisional(cleanupId(a.id), sealed.provisional).catch(() => {}); return fail(c, code); };
    if (c.req.query('error') || c.req.query('status') === 'failed') return finishWith('google_denied');
    if (a.link_user_id && sessionHash(getCookie(c, 'swarm_session') ?? '') !== a.link_session) return finishWith('google_link_required');
    const returned = c.req.query('connected_account_id');
    if (returned && returned !== sealed.account) return finishWith('google_session');
    let userId: string;
    try {
      const identity = await googleIdentityFor(sealed.account, sealed.provisional);
      userId = await resolveComposioGoogle(identity, sealed.provisional, a.id, a.link_user_id ? { userId: a.link_user_id, sessionHash: a.link_session! } : undefined);
      createSession(c, userId);
    } catch (error) {
      if (error instanceof GoogleLoginError) return finishWith(error.code);
      if (error instanceof Error && error.message === 'google_session') return finishWith('google_session');
      const code = error instanceof Error && ['google_link_required', 'google_already_linked', 'email_link_required'].includes(error.message) ? (error.message === 'google_already_linked' ? 'google_already_linked' : 'google_link_required') : 'google_invalid';
      return finishWith(code);
    }
    // A new account keeps the sign-in authorization as its own Gmail connection; repeat, adopted and linked sign-ins remove it.
    await releaseProvisional(cleanupId(a.id), sealed.provisional).catch(() => {});
    return c.redirect(finishNativeLogin(c, userId) ?? signedIn());
  }
  if (c.req.query('error')) return fail(c, 'google_denied');
  if (a.link_user_id && sessionHash(getCookie(c, 'swarm_session') ?? '') !== a.link_session) return fail(c, 'google_link_required');
  try {
    const verifier = unsealSecret(a.verifier);
    if (!verifier) throw new Error('google_invalid');
    const identity = await exchangeGoogleCode(c.req.query('code') ?? '', verifier, a.nonce, callback());
    const userId = resolveGoogleAccount(identity, a.link_user_id ? { userId: a.link_user_id, sessionHash: a.link_session! } : undefined);
    createSession(c, userId);
    return c.redirect(finishNativeLogin(c, userId) ?? signedIn());
  } catch (error) {
    const code = error instanceof Error && ['google_link_required', 'google_already_linked', 'email_link_required'].includes(error.message) ? 'google_link_required' : 'google_invalid';
    return fail(c, code);
  }
});
