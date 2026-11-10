import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { createAccount } from '../accounts.js';
import { createSession, sessionToken, userFromCookieHeader, userFromToken } from '../lib/auth.js';
import { sealSecret, unsealSecret } from '../settings.js';
import { finishNativeLogin, nativeLink } from '../native-auth.js';
import { exchangeOpenRouterCode, OpenRouterError, saveOpenRouterKey } from '../providers/openrouter.js';

const COOKIE = 'swarm_openrouter_attempt';
const PATH = '/api/auth/openrouter';
const TTL = 10 * 60_000;
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');
db.exec(`CREATE TABLE IF NOT EXISTS openrouter_login_attempts (
  id TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  link_session TEXT REFERENCES auth_sessions(token) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
); CREATE INDEX IF NOT EXISTS openrouter_login_expiry ON openrouter_login_attempts(expires_at);`);
type Attempt = { id: string; verifier: string; link_user_id: string | null; link_session: string | null; expires_at: number };

const failure = (c: Context, code: string, linking = false) => c.redirect(finishNativeLogin(c, undefined, code) ?? `${env.appUrl.replace(/\/$/, '')}/?${linking ? 'openrouter' : 'login'}=${code}${linking ? '#settings/keys' : ''}`, 303);

export const openrouterAuth = new Hono();
openrouterAuth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next();
});

openrouterAuth.get('/start', (c) => {
  const native = nativeLink(c);
  const user = native ? userFromToken(native.session) : userFromCookieHeader(c.req.header('cookie'));
  if (native && user?.id !== native.userId) return failure(c, 'openrouter_link_signin');
  const linking = c.req.query('intent') === 'link';
  if (linking && !user) return failure(c, 'openrouter_link_signin');
  // A signed-in browser always links, preventing accidental duplicate accounts.
  const linkUser = user;
  db.prepare('DELETE FROM openrouter_login_attempts WHERE expires_at<=?').run(now());
  const count = db.prepare('SELECT count(*) AS n FROM openrouter_login_attempts').get() as { n: number };
  if (count.n >= 2000) return failure(c, 'openrouter_busy', !!linkUser);
  const id = random(), verifier = random();
  const prior = getCookie(c, COOKIE);
  if (prior) db.prepare('DELETE FROM openrouter_login_attempts WHERE id=?').run(prior);
  db.prepare('INSERT INTO openrouter_login_attempts(id,verifier,link_user_id,link_session,expires_at) VALUES (?,?,?,?,?)')
    .run(id, sealSecret(verifier), linkUser?.id ?? null, linkUser ? native?.session ?? sessionToken(c)! : null, now() + TTL);
  setCookie(c, COOKIE, id, { httpOnly: true, secure: new URL(env.serverUrl).protocol === 'https:', sameSite: 'Lax', path: PATH, maxAge: TTL / 1000 });
  const url = new URL('https://openrouter.ai/auth');
  url.search = new URLSearchParams({ callback_url: `${env.serverUrl.replace(/\/$/, '')}${PATH}/callback`, state: id, code_challenge: hash(verifier), code_challenge_method: 'S256', key_label: 'Swarm' }).toString();
  return c.redirect(url.href);
});

openrouterAuth.get('/callback', async (c) => {
  const cookie = getCookie(c, COOKIE);
  const state = c.req.query('state');
  // OpenRouter omits state on denial. The browser cookie may only cancel its own attempt.
  const denied = !!c.req.query('error');
  if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie) || (state !== cookie && !(denied && !state))) return failure(c, 'openrouter_session');
  deleteCookie(c, COOKIE, { path: PATH });
  const attempt = db.prepare('DELETE FROM openrouter_login_attempts WHERE id=? AND expires_at>? RETURNING *').get(cookie, now()) as Attempt | undefined;
  if (!attempt) return failure(c, 'openrouter_session');
  const linking = !!attempt.link_user_id;
  if (denied) return failure(c, 'openrouter_denied', linking);
  const validSession = () => !linking || ((nativeLink(c)?.session ?? sessionToken(c)) === attempt.link_session && userFromToken(attempt.link_session!)?.id === attempt.link_user_id);
  if (!validSession()) return failure(c, 'openrouter_link_signin', linking);
  const code = c.req.query('code');
  const verifier = unsealSecret(attempt.verifier);
  if (!code || code.length > 4096 || !verifier) return failure(c, 'openrouter_invalid', linking);
  try {
    const identity = await exchangeOpenRouterCode(code, verifier);
    const userId = db.transaction(() => {
      if (!validSession()) throw new OpenRouterError('openrouter_link_signin');
      const existing = db.prepare('SELECT user_id FROM openrouter_identities WHERE subject=?').get(identity.subject) as { user_id: string } | undefined;
      if (existing && linking && existing.user_id !== attempt.link_user_id) throw new OpenRouterError('openrouter_already_linked');
      let id = existing?.user_id ?? attempt.link_user_id;
      if (!id) {
        // OpenRouter provides no verified email/name. Never join users by a guessed email.
        id = createAccount({ email: `or+${crypto.randomBytes(24).toString('hex')}@openrouter.invalid`, name: 'Swarm member' }).id;
      }
      if (!existing) {
        if (db.prepare('SELECT 1 FROM openrouter_identities WHERE user_id=?').get(id)) throw new OpenRouterError('openrouter_already_linked');
        db.prepare('INSERT INTO openrouter_identities(subject,user_id,created_at) VALUES (?,?,?)').run(identity.subject, id, now());
      }
      saveOpenRouterKey(id, identity.key, 'oauth');
      return id;
    })();
    createSession(c, userId);
    return c.redirect(finishNativeLogin(c, userId) ?? `${env.appUrl.replace(/\/$/, '')}/?openrouter=connected#settings/keys`, 303);
  } catch (error) {
    return failure(c, error instanceof OpenRouterError ? error.code : 'openrouter_invalid', linking);
  }
});
