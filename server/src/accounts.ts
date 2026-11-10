import crypto from 'node:crypto';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { createBot } from './bots.js';
import { interrupt } from './agent/loop.js';
import { unscheduleRoutine } from './routines.js';
import { removeSetupFiles } from './bot-setup.js';
import { computers } from './computers/index.js';

/**
 * Accounts. A person can sign up in the web app (Google or dev email) or by text message (phone number only), and
 * either way gets the same account: a primary Bot (Quinn) and everything else. Text-first accounts have a placeholder
 * email until they add a real one.
 */

function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('users', 'phone', 'TEXT');
addColumn('users', 'signup_source', "TEXT NOT NULL DEFAULT 'web'");
addColumn('users', 'invited_by', 'TEXT');
addColumn('users', 'timezone', 'TEXT');
addColumn('users', 'onboarded_at', 'INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL');

export const PLACEHOLDER_DOMAIN = 'phone.invalid';
export const placeholderEmail = (phone: string) => `tel+${phone.replace(/\D/g, '')}@${PLACEHOLDER_DOMAIN}`;
export const isPlaceholderEmail = (email: string) => email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);

export interface Account {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  timezone: string | null;
  signupSource: 'web' | 'text';
  invitedBy: string | null;
  onboardedAt: number | null;
  createdAt: number;
}

const toAccount = (r: any): Account => ({
  id: r.id, email: r.email, name: r.name, phone: r.phone ?? null, timezone: r.timezone ?? null, signupSource: r.signup_source === 'text' ? 'text' : 'web',
  invitedBy: r.invited_by ?? null, onboardedAt: r.onboarded_at ?? null, createdAt: r.created_at,
});

export function getAccount(userId: string): Account | null {
  const r = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  return r ? toAccount(r) : null;
}

export function accountByPhone(phone: string): Account | null {
  const r = db.prepare('SELECT * FROM users WHERE phone=?').get(phone.replace(/\D/g, ''));
  return r ? toAccount(r) : null;
}

/** The server has an owner (its first account). Sign-up by text waits for one, so a stranger never becomes the owner. */
export const hasOwner = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();

/**
 * May this number create an account? Once the server has an owner, yes (subject to the sign-up mode). On a fresh
 * server only an owner number (ADMIN_PHONES) may, so a stranger never becomes the owner.
 */
export const mayCreateAccount = (phone: string) =>
  hasOwner() || (process.env.ADMIN_PHONES ?? '').split(',').map((p) => p.replace(/\D/g, '')).includes(phone.replace(/\D/g, ''));

export interface CreateAccountInput {
  email?: string;
  phone?: string;
  name?: string;
  preferId?: string;
  source?: 'web' | 'text';
  invitedBy?: string | null;
}

/** Find an account by email (or phone), or create it with its primary Bot. */
export function createAccount(input: CreateAccountInput): { id: string; isNew: boolean } {
  const phone = input.phone ? input.phone.replace(/\D/g, '') : null;
  const byEmail = input.email ? (db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(input.email) as any) : null;
  if (byEmail) return { id: byEmail.id, isNew: false };
  const byPhone = phone ? accountByPhone(phone) : null;
  if (byPhone) return { id: byPhone.id, isNew: false };
  if (!input.email && !phone) throw new Error('An account needs an email or a phone number.');
  const id = input.preferId ?? newId('usr');
  const email = input.email ?? placeholderEmail(phone!);
  const name = (input.name?.trim() || (input.email ? input.email.split('@')[0] : 'there')).slice(0, 80);
  db.prepare('INSERT INTO users(id,email,name,created_at,phone,signup_source,invited_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, email, name, now(), phone, input.source ?? 'web', input.invitedBy ?? null);
  createBot(id, { name: 'Quinn', label: 'Chief of Staff', description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

export function updateProfile(userId: string, p: { name?: string; timezone?: string; onboarded?: boolean }) {
  if (p.name?.trim()) db.prepare('UPDATE users SET name=? WHERE id=?').run(p.name.trim().slice(0, 80), userId);
  if (p.timezone) db.prepare('UPDATE users SET timezone=? WHERE id=?').run(p.timezone, userId);
  if (p.onboarded) db.prepare('UPDATE users SET onboarded_at=COALESCE(onboarded_at, ?) WHERE id=?').run(now(), userId);
}

/** Replace a placeholder (or old) email. Refused when another account already uses it: accounts are never merged. */
export function setEmail(userId: string, email: string): { ok: true } | { ok: false; error: string } {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || isPlaceholderEmail(e)) return { ok: false, error: 'Enter a valid email address.' };
  const other = db.prepare('SELECT id FROM users WHERE lower(email)=? AND id<>?').get(e, userId);
  if (other) return { ok: false, error: 'That email has its own Grokbot account. Sign in there and link your phone with a link code instead.' };
  db.prepare('UPDATE users SET email=? WHERE id=?').run(e, userId);
  return { ok: true };
}

/** Delete an account and everything in it. Bots, rows, links and sessions go with the user (foreign keys cascade). */
export async function deleteAccount(userId: string) {
  const bots = db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[];
  for (const b of bots) {
    interrupt(b.id);
    for (const r of db.prepare('SELECT id FROM routines WHERE bot_id=?').all(b.id) as { id: string }[]) unscheduleRoutine(r.id);
    await computers.resetScreen(userId, b.id).catch(() => {});
    removeSetupFiles(b.id);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM screens WHERE user_id=?').run(userId);
    for (const t of ['proactivity', 'messaging_claims']) {
      try { db.prepare(`DELETE FROM ${t} WHERE ${t === 'messaging_claims' ? 'phone=(SELECT phone FROM users WHERE id=?)' : 'user_id=?'}`).run(userId); } catch { /* table absent */ }
    }
    db.prepare('UPDATE messaging_waitlist SET user_id=NULL, status=\'deleted\' WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
  })();
}

// ---------- one-time sign-in links (sent by text) ----------

const LOGIN_TTL = 10 * 60_000;
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** A link that signs this user into the web app once, within 10 minutes. */
export function createLoginLink(userId: string): string {
  db.prepare('DELETE FROM login_tokens WHERE expires_at<?').run(now() - 24 * 3600_000);
  const t = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO login_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hash(t), userId, now() + LOGIN_TTL);
  return `${env.serverUrl.replace(/\/$/, '')}/api/auth/text?t=${encodeURIComponent(t)}`;
}

/** Use a sign-in link. Returns the user, or null if it's unknown, expired or already used. */
export function consumeLoginToken(t: string): string | null {
  if (!t) return null;
  const r = db.prepare('SELECT * FROM login_tokens WHERE token_hash=?').get(hash(t)) as any;
  if (!r || r.used_at || r.expires_at < now()) return null;
  const used = db.prepare('UPDATE login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now(), r.token_hash);
  return used.changes ? r.user_id : null;
}
