import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { createAccount } from '../accounts.js';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { createSession, sessionToken, userFromCookieHeader } from '../lib/auth.js';
import { appleAvailability, appleConfiguration, AppleError, exchangeAppleCode, saveAppleRefreshToken, type AppleClient } from './apple-provider.js';

const COOKIE = 'swarm_apple_attempt';
const TTL = 10 * 60_000;
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
db.exec(`CREATE TABLE IF NOT EXISTS apple_login_attempts (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  challenge TEXT,
  link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  link_session TEXT REFERENCES auth_sessions(token) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS apple_login_expiry ON apple_login_attempts(expires_at);`);
type Attempt = { id: string; client: AppleClient; client_id: string; nonce: string; challenge: string | null; link_user_id: string | null; link_session: string | null; expires_at: number };

function start(c: Context, client: AppleClient, challenge: string | null, linking: boolean) {
  if (!appleAvailability()[client]) throw new AppleError('apple_unavailable');
  const user = userFromCookieHeader(c.req.header('cookie'));
  if (linking && !user) throw new AppleError('apple_link_signin');
  db.prepare('DELETE FROM apple_login_attempts WHERE expires_at<=?').run(now());
  const count = db.prepare('SELECT count(*) AS n FROM apple_login_attempts').get() as { n: number };
  if (count.n >= 2000) throw new AppleError('apple_busy');
  const attempt: Attempt = { id: random(), client, client_id: appleConfiguration().clients[client], nonce: random(), challenge, link_user_id: linking ? user!.id : null, link_session: linking ? sessionToken(c)! : null, expires_at: now() + TTL };
  db.prepare('INSERT INTO apple_login_attempts(id,client,client_id,nonce,challenge,link_user_id,link_session,expires_at) VALUES (@id,@client,@client_id,@nonce,@challenge,@link_user_id,@link_session,@expires_at)').run(attempt);
  return attempt;
}

/** Never merge accounts just because their email strings match. Linking requires an existing session. */
export function resolveAppleAccount(identity: { subject: string; email: string | null; refreshToken: string }, attempt: Attempt, name?: string) {
  return db.transaction(() => {
    if (attempt.link_user_id) {
      const session = db.prepare('SELECT 1 FROM auth_sessions WHERE token=? AND user_id=? AND expires_at>?').get(attempt.link_session, attempt.link_user_id, now());
      if (!session) throw new AppleError('apple_link_signin');
    }
    const existing = db.prepare('SELECT user_id FROM apple_identities WHERE subject=?').get(identity.subject) as { user_id: string } | undefined;
    if (existing && attempt.link_user_id && existing.user_id !== attempt.link_user_id) throw new AppleError('apple_already_linked');
    let id = existing?.user_id ?? attempt.link_user_id;
    if (!id) {
      if (!identity.email) throw new AppleError('apple_email_required');
      if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(identity.email)) throw new AppleError('apple_link_required');
      id = createAccount({ email: identity.email, name: name?.trim().slice(0, 80) || 'Swarm member', source: 'web' }).id;
    }
    if (!existing) {
      if (db.prepare('SELECT 1 FROM apple_identities WHERE user_id=?').get(id)) throw new AppleError('apple_already_linked');
      db.prepare('INSERT INTO apple_identities(subject,user_id,created_at) VALUES (?,?,?)').run(identity.subject, id, now());
    }
    saveAppleRefreshToken(id, attempt.client_id, identity.refreshToken);
    return id;
  })();
}

const errorCode = (error: unknown) => error instanceof AppleError ? error.code : 'apple_invalid';
const failure = (c: Context, code: string) => c.redirect(`${env.appUrl}/?login=${encodeURIComponent(code)}`, 303);
const consume = (id: string) => db.prepare('DELETE FROM apple_login_attempts WHERE id=? AND expires_at>? RETURNING *').get(id, now()) as Attempt | undefined;

export const appleAuth = new Hono();
appleAuth.use('*', bodyLimit({ maxSize: 16 * 1024 }));
appleAuth.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });

appleAuth.get('/start', (c) => {
  try {
    const attempt = start(c, 'web', null, c.req.query('intent') === 'link');
    // Apple returns a cross-site POST; Lax cookies would not bind that callback to its browser.
    setCookie(c, COOKIE, attempt.id, { httpOnly: true, secure: true, sameSite: 'None', path: '/api/auth/apple', maxAge: TTL / 1000 });
    const url = new URL('https://appleid.apple.com/auth/authorize');
    url.search = new URLSearchParams({ client_id: attempt.client_id, redirect_uri: appleConfiguration().redirectURI, response_type: 'code', response_mode: 'form_post', scope: 'name email', state: attempt.id, nonce: attempt.nonce }).toString();
    return c.redirect(url.href);
  } catch (error) { return failure(c, errorCode(error)); }
});

appleAuth.post('/callback', async (c) => {
  const form = await c.req.parseBody();
  const state = form.state;
  if (!validToken(state) || getCookie(c, COOKIE) !== state) return failure(c, 'apple_session');
  deleteCookie(c, COOKIE, { path: '/api/auth/apple', secure: true, sameSite: 'None' });
  const attempt = consume(state);
  if (!attempt || attempt.client !== 'web') return failure(c, 'apple_session');
  if (form.error) return failure(c, 'apple_denied');
  if (typeof form.code !== 'string' || !form.code || form.code.length > 4096) return failure(c, 'apple_invalid');
  try {
    const identity = await exchangeAppleCode(form.code, attempt.client_id, attempt.nonce, true);
    let name: string | undefined;
    // Apple sends the user's name only on first authorization. It is display text, never identity evidence.
    try {
      const user = typeof form.user === 'string' ? JSON.parse(form.user) : null;
      name = [user?.name?.firstName, user?.name?.lastName].filter(v => typeof v === 'string').join(' ').slice(0, 80);
    } catch { /* An absent display name does not prevent authentication. */ }
    const id = resolveAppleAccount(identity, attempt, name);
    createSession(c, id);
    return c.redirect(`${env.appUrl}/${attempt.link_user_id ? '#settings/account' : ''}`, 303);
  } catch (error) { return failure(c, errorCode(error)); }
});

appleAuth.post('/native/start', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !['ios', 'macos'].includes(body.client) || !validToken(body.challenge)) return c.json({ error: 'apple_invalid' }, 400);
  try {
    const attempt = start(c, body.client, body.challenge, body.intent === 'link');
    return c.json({ attempt: attempt.id, nonce: attempt.nonce });
  } catch (error) { return c.json({ error: errorCode(error) }, 400); }
});

appleAuth.post('/native/complete', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !validToken(body.attempt) || !validToken(body.verifier) || typeof body.code !== 'string' || !body.code || body.code.length > 4096 || (body.name !== undefined && typeof body.name !== 'string')) return c.json({ error: 'apple_invalid' }, 400);
  const pending = db.prepare('SELECT * FROM apple_login_attempts WHERE id=? AND expires_at>?').get(body.attempt, now()) as Attempt | undefined;
  if (!pending?.challenge || pending.client === 'web' || !crypto.timingSafeEqual(Buffer.from(pending.challenge), Buffer.from(hash(body.verifier)))) return c.json({ error: 'apple_session' }, 401);
  const attempt = consume(pending.id);
  if (!attempt) return c.json({ error: 'apple_session' }, 401);
  try {
    const identity = await exchangeAppleCode(body.code, attempt.client_id, attempt.nonce, false);
    const id = resolveAppleAccount(identity, attempt, body.name);
    createSession(c, id);
    return c.json({ ok: true, linked: !!attempt.link_user_id });
  } catch (error) { return c.json({ error: errorCode(error) }, 401); }
});
