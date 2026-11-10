import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { accountByPhone, getAccount, mayCreateAccount } from '../accounts.js';
import { adminPhones } from '../settings.js';
import { deliver, hasTextLink } from './bridge.js';
import { signupConfig, startAccount, takeInvite } from './signup.js';
import { digits, upsertLink, type Channel, type Transport } from './store.js';
import { inkboxConfigured, isConnectedToLine, textNewlyConnected } from './inkbox/adapter.js';

/**
 * "Continue with your phone number" in the browser, and "Connect your phone" for signed-in users.
 *
 * The line can only text people who have texted it first (Inkbox), so a code reaches the phone one of two ways:
 * - the number is already connected: Swarm texts the code right away;
 * - it isn't: the person texts the line (the page opens Messages for them) and the line replies with the code.
 * Typing the code back in the same browser proves the person holds the phone. It signs them in (creating the account
 * if needed, under the server's sign-up rules) or attaches the number to the signed-in account, and connects it.
 */

db.exec(`CREATE TABLE IF NOT EXISTS phone_logins (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attach_user_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  channel TEXT,
  transport TEXT,
  chat_ref TEXT,
  name TEXT,
  code_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
)`);

if (!(db.prepare('PRAGMA table_info(phone_logins)').all() as { name: string }[]).some((c) => c.name === 'code_sent')) {
  db.exec('ALTER TABLE phone_logins ADD COLUMN code_sent INTEGER NOT NULL DEFAULT 0');
}

const TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const hash = (id: string, code: string) => crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
const hits = new Map<string, number[]>();

function limited(key: string, max: number, windowMs: number) {
  const t = now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  if (list.length >= max) return true;
  hits.set(key, [...list, t]);
  return false;
}

/** The pending login for this phone, if any (newest first). */
const pendingFor = (phone: string) =>
  db.prepare('SELECT * FROM phone_logins WHERE phone=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(phone, now()) as any;

/**
 * Start: make a code for this number. If the number already reaches Swarm, text it now.
 * Answers the same either way, so nobody learns whether a number has an account.
 */
export async function startPhoneLogin(phone: string, opts: { ip: string; attachTo?: string }): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const p = digits(phone);
  if (p.length < 8 || p.length > 15) return { ok: false, status: 400, error: 'Enter your full number with country code, like +1 415 555 0100.' };
  if (limited(`ip:${opts.ip}`, 10, 10 * 60_000) || limited(`phone:${p}`, 5, 10 * 60_000)) return { ok: false, status: 429, error: 'Too many tries. Wait a few minutes and try again.' };
  const id = crypto.randomBytes(16).toString('base64url');
  // A plain 6-digit code (people type it from a text).
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('UPDATE phone_logins SET used_at=? WHERE phone=? AND used_at IS NULL').run(now(), p); // one live code per number
  db.prepare('INSERT INTO phone_logins(id,phone,code_hash,attach_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(id, p, hash(id, code), opts.attachTo ?? null, now(), now() + TTL);
  pendingCodes.set(id, code);
  const acct = accountByPhone(p);
  if (acct && hasTextLink(acct.id)) await deliver(acct.id, { text: codeText(code, !!opts.attachTo) }, { kind: 'system' });
  else watchForConnect(id, p, code, !!opts.attachTo);
  return { ok: true, id };
}

/**
 * A number that isn't connected yet: the page opens Messages with "connect @handle". Inkbox sends no event for that,
 * so poll its list of connected numbers and text the code as soon as this one shows up. If Inkbox won't allow a first
 * text, the code still goes out when they send anything (replyWithCode).
 */
function watchForConnect(id: string, phone: string, code: string, attach: boolean) {
  if (!inkboxConfigured()) return;
  const started = now();
  const tick = async () => {
    const row = db.prepare('SELECT used_at, expires_at, chat_ref, code_sent FROM phone_logins WHERE id=?').get(id) as any;
    if (!row || row.used_at || row.expires_at < now() || row.chat_ref || row.code_sent) return;
    try {
      if (await isConnectedToLine(phone)) {
        if (await textNewlyConnected(phone, codeText(code, attach))) db.prepare('UPDATE phone_logins SET code_sent=1 WHERE id=?').run(id);
        return; // sent, or Inkbox wants them to write first: either way stop polling
      }
    } catch (e) { console.warn('[phone-auth] connect check failed:', (e as Error).message); }
    if (now() - started < TTL) setTimeout(() => void tick(), 4000).unref();
  };
  setTimeout(() => void tick(), 3000).unref();
}

/** Codes are kept in memory only until texted (the database has just the hash). */
const pendingCodes = new Map<string, string>();

const codeText = (code: string, attach: boolean) =>
  `🔑 Your Swarm ${attach ? 'code to connect this number' : 'sign-in code'} is ${code}. It expires in 10 minutes. Didn't ask for it? Ignore this.`;

/**
 * The front desk calls this for a text from a number with no link yet: if that number has a pending phone login,
 * reply with its code (and remember where they wrote, to connect the number on success).
 */
export async function replyWithCode(s: { phone: string; channel: Channel; transport: Transport; chatRef?: string | null; name?: string | null }, reply: (text: string) => Promise<void>): Promise<boolean> {
  const row = pendingFor(digits(s.phone));
  if (!row) return false;
  const code = pendingCodes.get(row.id);
  if (!code) return false; // server restarted since the code was made: they can ask for a new one
  db.prepare('UPDATE phone_logins SET channel=?, transport=?, chat_ref=?, name=? WHERE id=?').run(s.channel, s.transport, s.chatRef ?? null, s.name ?? null, row.id);
  await reply(codeText(code, !!row.attach_user_id));
  return true;
}

export type VerifyResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; status: number; error: string; needInvite?: boolean };

/** Check the code. Signs in / creates the account, or attaches the number to `attachTo`, and connects the number. */
export async function verifyPhoneLogin(id: string, code: string, opts: { inviteCode?: string; attachTo?: string } = {}): Promise<VerifyResult> {
  const row = db.prepare('SELECT * FROM phone_logins WHERE id=?').get(String(id ?? '')) as any;
  if (!row || row.used_at || row.expires_at < now()) return { ok: false, status: 410, error: 'This code has expired. Start again to get a new one.' };
  if ((row.attach_user_id ?? undefined) !== opts.attachTo) return { ok: false, status: 400, error: 'Start again.' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many wrong codes. Start again to get a new one.' };
  const want = Buffer.from(row.code_hash);
  const got = Buffer.from(hash(row.id, String(code ?? '').replace(/\D/g, '')));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    db.prepare('UPDATE phone_logins SET attempts=attempts+1 WHERE id=?').run(row.id);
    return { ok: false, status: 400, error: "That code isn't right." };
  }

  const phone: string = row.phone;
  const existing = accountByPhone(phone);
  const connect = (userId: string) => {
    if (row.chat_ref && row.channel && row.transport) {
      upsertLink(userId, row.channel, row.transport, { status: 'connected', phone, chatRef: row.chat_ref, name: row.name ?? null, error: null, lastInboundAt: now() });
    }
  };
  const done = (userId: string, created: boolean): VerifyResult => {
    db.prepare('UPDATE phone_logins SET used_at=? WHERE id=?').run(now(), row.id);
    pendingCodes.delete(row.id);
    return { ok: true, userId, created };
  };

  if (opts.attachTo) {
    if (existing && existing.id !== opts.attachTo) return { ok: false, status: 409, error: 'This number already has its own Swarm account. Sign in with it instead.' };
    const me = getAccount(opts.attachTo);
    if (!me) return { ok: false, status: 404, error: 'Account not found.' };
    if (!me.phone) db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, opts.attachTo);
    connect(opts.attachTo);
    if (row.chat_ref) void deliver(opts.attachTo, { text: '✅ **Connected.** This number now reaches your Bots. Type a message to talk to your primary Bot, or send /help.' }, { kind: 'system' });
    return done(opts.attachTo, false);
  }

  if (existing) { connect(existing.id); return done(existing.id, false); }

  // A new account: the server's sign-up rules apply, as for sign-up by text. The owner's number always gets in.
  if (!mayCreateAccount(phone)) return { ok: false, status: 403, error: "This Swarm server isn't set up yet." };
  const cfg = signupConfig();
  let invitedBy: string | null = null;
  if (adminPhones().includes(phone)) { /* owner: no invite needed */ }
  else if (cfg.mode === 'closed') return { ok: false, status: 403, error: "Swarm isn't taking new members right now." };
  else if (cfg.mode === 'invite') {
    const inv = opts.inviteCode ? takeInvite(opts.inviteCode) : null;
    if (!inv) return { ok: false, status: 403, needInvite: true, error: opts.inviteCode ? "That invite code isn't valid." : 'Swarm is invite-only. Enter your invite code.' };
    invitedBy = inv.createdBy;
  }
  if (!row.chat_ref) return { ok: false, status: 400, error: 'Text the line first, then try again.' };
  const userId = await startAccount({ phone, channel: row.channel, transport: row.transport, chatRef: row.chat_ref, name: row.name, text: '' }, invitedBy);
  return done(userId, true);
}
