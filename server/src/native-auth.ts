import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from './db.js';
import { env } from './env.js';
import { createSession } from './lib/auth.js';

// The system browser and WKWebView have separate cookie jars. Only a short-lived,
// single-use code crosses that boundary, bound to a secret held by the native app.
const COOKIE = 'swarm_native_attempt';
const TTL = 10 * 60_000;
const CALLBACK = 'so.swarms.app://auth';
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const validToken = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);

db.exec(`CREATE TABLE IF NOT EXISTS native_login_attempts (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
); CREATE INDEX IF NOT EXISTS native_login_expiry ON native_login_attempts(expires_at);`);

type Attempt = { id: string; challenge: string; state: string; user_id: string | null; expires_at: number };

function browserAttempt(c: Context): Attempt | undefined {
  const id = getCookie(c, COOKIE);
  if (!id) return;
  return db.prepare('SELECT * FROM native_login_attempts WHERE id=? AND expires_at>? AND code_hash IS NULL').get(id, now()) as Attempt | undefined;
}

/** Called only after the existing Google callback verifies its own browser-bound attempt. */
export function finishNativeLogin(c: Context, userId?: string, error?: string): string | null {
  const attempt = browserAttempt(c);
  deleteCookie(c, COOKIE, { path: '/api/auth' });
  if (!attempt) return null;
  const callback = new URL(CALLBACK);
  callback.searchParams.set('state', attempt.state);
  if (userId) {
    const code = random();
    db.prepare('UPDATE native_login_attempts SET user_id=?, code_hash=?, expires_at=? WHERE id=?').run(userId, hash(code), now() + 60_000, attempt.id);
    callback.searchParams.set('code', code);
  } else {
    db.prepare('DELETE FROM native_login_attempts WHERE id=?').run(attempt.id);
    callback.searchParams.set('error', error ?? 'failed');
  }
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return callback.href;
}

export const nativeAuth = new Hono();
nativeAuth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
});

nativeAuth.get('/start', (c) => {
  const challenge = c.req.query('challenge') ?? '';
  const state = c.req.query('state') ?? '';
  if (!validToken(challenge) || !validToken(state)) return c.json({ error: 'Invalid sign-in request.' }, 400);
  db.prepare('DELETE FROM native_login_attempts WHERE expires_at<=?').run(now());
  const active = db.prepare('SELECT count(*) AS n FROM native_login_attempts').get() as { n: number };
  if (active.n >= 2000) return c.json({ error: 'Please try again shortly.' }, 429);
  const id = random();
  db.prepare('INSERT INTO native_login_attempts(id,challenge,state,expires_at) VALUES (?,?,?,?)').run(id, challenge, state, now() + TTL);
  setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure: new URL(env.serverUrl).protocol === 'https:', path: '/api/auth', maxAge: TTL / 1000 });
  // Always authenticate the account explicitly; do not silently reuse a browser session.
  return c.redirect('/api/auth/google/start');
});

nativeAuth.post('/exchange', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.code !== 'string' || !validToken(body.code) || typeof body.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier)) {
    return c.json({ error: 'Invalid sign-in request.' }, 400);
  }
  const attempt = db.prepare('SELECT * FROM native_login_attempts WHERE code_hash=? AND expires_at>? AND user_id IS NOT NULL').get(hash(body.code), now()) as Attempt | undefined;
  if (!attempt || !crypto.timingSafeEqual(Buffer.from(attempt.challenge), Buffer.from(hash(body.verifier)))) return c.json({ error: 'Sign-in expired or could not be verified. Please start again.' }, 401);
  db.transaction(() => {
    db.prepare('DELETE FROM native_login_attempts WHERE id=?').run(attempt.id);
    createSession(c, attempt.user_id!);
  })();
  return c.json({ ok: true });
});
