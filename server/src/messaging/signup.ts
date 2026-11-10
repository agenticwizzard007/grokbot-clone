import { db, now } from '../db.js';
import { env } from '../env.js';
import { enqueue } from '../agent/loop.js';
import { accountByPhone, createAccount, getAccount, hasOwner } from '../accounts.js';
import { deliver } from './bridge.js';
import { replyWithCode } from './phone-auth.js';
import {
  CHANNEL_NAMES, digits, getLink, hostLinkByPhone, randomCode, redeemLinkCode, upsertLink,
  type Channel, type Transport,
} from './store.js';

/**
 * Signing up by text: the front desk for messages from phone numbers that have no account link yet.
 *
 * 1. The phone claimed an invite on the join page (/join/<code>) → create the account.
 * 2. "LINK <code>" → attach this phone to an existing (web) account.
 * 3. "JOIN <code>" or a bare invite code → create the account.
 * 4. Otherwise, by sign-up mode: 'invite' (default) puts them on the waitlist, 'open' creates the account,
 *    'closed' answers once a day.
 * Texting from a number proves you hold it, so no verification code is needed.
 */

export type SignupMode = 'invite' | 'open' | 'closed';

export function signupConfig() {
  const mode = env.messagingSignupMode;
  return {
    mode: (['invite', 'open', 'closed'].includes(mode) ? mode : 'invite') as SignupMode,
    signupsPerDay: Number(env.messagingSignupsPerDay || 50),
    dailyTurns: Number(env.messagingDailyTurns || 200),
    memberInvites: Number(env.messagingMemberInvites || 5),
  };
}

const startOfDayUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

/** Messages a text-first account sent to its Bots today, from any channel or the web. Only text-first accounts are capped. */
export function dailyUsage(userId: string): { used: number; limit: number; over: boolean } {
  const acct = getAccount(userId);
  const used = (db.prepare(`SELECT COUNT(*) n FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.kind='message' AND r.created_at>=?
    AND json_extract(r.body,'$.role')='user' AND (json_extract(r.body,'$.from.kind') IS NULL OR json_extract(r.body,'$.from.kind') IN ('imessage','sms','voice'))`)
    .get(userId, startOfDayUtc()) as any).n as number;
  const limit = acct?.signupSource === 'text' ? signupConfig().dailyTurns : 0;
  return { used, limit, over: limit > 0 && used >= limit };
}

const signupsToday = () => (db.prepare("SELECT COUNT(*) n FROM users WHERE signup_source='text' AND created_at>=?").get(startOfDayUtc()) as any).n as number;

// ---------- invites ----------

export interface Invite { code: string; createdBy: string | null; maxUses: number; uses: number; expiresAt: number | null; note: string; revoked: boolean; createdAt: number; url: string }

export const joinUrl = (code: string) => `${env.appUrl.replace(/\/$/, '')}/join/${code}`;

const toInvite = (r: any): Invite => ({ code: r.code, createdBy: r.created_by, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at, note: r.note, revoked: !!r.revoked, createdAt: r.created_at, url: joinUrl(r.code) });

export function createInvite(createdBy: string | null, opts: { maxUses?: number; expiresInDays?: number | null; note?: string } = {}): Invite {
  const code = randomCode(8);
  const maxUses = Math.max(1, Math.min(10_000, Math.floor(opts.maxUses ?? 1)));
  const expiresAt = opts.expiresInDays ? now() + opts.expiresInDays * 86_400_000 : null;
  db.prepare('INSERT INTO messaging_invites(code,created_by,max_uses,expires_at,note,created_at) VALUES (?,?,?,?,?,?)').run(code, createdBy, maxUses, expiresAt, (opts.note ?? '').slice(0, 120), now());
  return toInvite(db.prepare('SELECT * FROM messaging_invites WHERE code=?').get(code));
}

export const listInvites = (createdBy?: string): Invite[] =>
  (createdBy ? db.prepare('SELECT * FROM messaging_invites WHERE created_by=? ORDER BY created_at DESC').all(createdBy) : db.prepare('SELECT * FROM messaging_invites ORDER BY created_at DESC LIMIT 200').all()).map(toInvite);

export const revokeInvite = (code: string) => db.prepare('UPDATE messaging_invites SET revoked=1 WHERE code=?').run(code.toUpperCase()).changes > 0;

function usableInvite(code: string): Invite | null {
  const r = db.prepare('SELECT * FROM messaging_invites WHERE code=?').get(code.toUpperCase()) as any;
  if (!r || r.revoked || r.uses >= r.max_uses || (r.expires_at && r.expires_at < now())) return null;
  return toInvite(r);
}

/** Use one seat of an invite (web sign-up by phone). Returns the invite, or null if it can't be used. */
export function takeInvite(code: string): Invite | null {
  const inv = usableInvite(code.trim());
  if (!inv) return null;
  const r = db.prepare('UPDATE messaging_invites SET uses=uses+1 WHERE code=? AND uses<max_uses AND revoked=0').run(inv.code);
  return r.changes ? inv : null;
}

/** A member's own invite link (created on first use), with the remaining invites. */
export function memberInvite(userId: string): { url: string; remaining: number } | { error: string } {
  const allowance = signupConfig().memberInvites;
  if (allowance <= 0) return { error: 'Invites are turned off on this server.' };
  let inv = (db.prepare('SELECT * FROM messaging_invites WHERE created_by=? AND revoked=0 AND note=? ORDER BY created_at DESC LIMIT 1').get(userId, 'member') as any);
  if (!inv) inv = { code: createInvite(userId, { maxUses: allowance, note: 'member' }).code };
  const i = toInvite(db.prepare('SELECT * FROM messaging_invites WHERE code=?').get(inv.code));
  const remaining = Math.max(0, i.maxUses - i.uses);
  if (!remaining) return { error: "You've used all your invites." };
  return { url: i.url, remaining };
}

/** What the join page shows. Reveals nothing about phone numbers. */
export function inviteInfo(code: string): { valid: boolean; inviter: string | null } {
  const inv = usableInvite(code);
  if (!inv) return { valid: false, inviter: null };
  const inviter = inv.createdBy ? getAccount(inv.createdBy)?.name ?? null : null;
  return { valid: true, inviter };
}

// ---------- claims: the join page reserves an invite for a phone until it texts ----------

const CLAIM_TTL = 30 * 60_000;
const claimHits = new Map<string, number[]>();
let globalClaims: number[] = [];

function rateLimited(ip: string) {
  const t = now();
  const mine = (claimHits.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
  globalClaims = globalClaims.filter((x) => t - x < 3600_000);
  if (mine.length >= 5 || globalClaims.length >= 200) return true;
  mine.push(t);
  claimHits.set(ip, mine);
  globalClaims.push(t);
  return false;
}

/**
 * Reserve an invite for a phone number. Answers the same whether or not the number already has an account
 * (a known number simply reaches its own account when it texts).
 */
export function claimInvite(code: string, phone: string, ip: string): { ok: true } | { ok: false; error: string; status: number } {
  const p = digits(phone);
  if (p.length < 8 || p.length > 15) return { ok: false, status: 400, error: 'Enter your full number with country code, like +1 415 555 0100.' };
  if (!usableInvite(code)) return { ok: false, status: 410, error: 'This invite has expired or has been used up.' };
  if (rateLimited(ip || 'unknown')) return { ok: false, status: 429, error: 'Too many tries. Wait a few minutes and try again.' };
  db.prepare('INSERT OR REPLACE INTO messaging_claims(phone,invite_code,expires_at,created_at) VALUES (?,?,?,?)').run(p, code.toUpperCase(), now() + CLAIM_TTL, now());
  return { ok: true };
}

const activeClaim = (phone: string) => db.prepare('SELECT * FROM messaging_claims WHERE phone=? AND expires_at>?').get(phone, now()) as { invite_code: string } | undefined;

// ---------- waitlist ----------

export interface WaitlistEntry { phone: string; channel: Channel; name: string | null; firstMessage: string; status: string; createdAt: number; decidedAt: number | null }
const toEntry = (r: any): WaitlistEntry => ({ phone: r.phone, channel: r.channel, name: r.name, firstMessage: r.first_message, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at });

export const listWaitlist = (): WaitlistEntry[] => (db.prepare("SELECT * FROM messaging_waitlist ORDER BY status='pending' DESC, created_at DESC LIMIT 500").all() as any[]).map(toEntry);

function addToWaitlist(s: Sender): 'added' | 'already' {
  const r = db.prepare('INSERT OR IGNORE INTO messaging_waitlist(phone,channel,transport,chat_ref,name,first_message,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(s.phone, s.channel, s.transport, s.chatRef ?? null, s.name ?? null, (s.text ?? '').slice(0, 500), now());
  if (r.changes) return 'added';
  db.prepare('UPDATE messaging_waitlist SET chat_ref=COALESCE(?,chat_ref), channel=?, transport=? WHERE phone=?').run(s.chatRef ?? null, s.channel, s.transport, s.phone);
  return 'already';
}

/** Owner approves a waitlisted number: create the account and say hello where they wrote. */
export async function approveWaitlist(phone: string, approvedBy: string): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const w = db.prepare('SELECT * FROM messaging_waitlist WHERE phone=?').get(digits(phone)) as any;
  if (!w) return { ok: false, error: 'Not on the waitlist.' };
  if (w.status === 'approved' && w.user_id) return { ok: true, userId: w.user_id };
  const userId = await startAccount({ phone: w.phone, channel: w.channel, transport: w.transport, chatRef: w.chat_ref, name: w.name, text: '' }, approvedBy);
  db.prepare("UPDATE messaging_waitlist SET status='approved', user_id=?, decided_at=? WHERE phone=?").run(userId, now(), w.phone);
  return { ok: true, userId };
}

export function declineWaitlist(phone: string) {
  return db.prepare("UPDATE messaging_waitlist SET status='declined', decided_at=? WHERE phone=?").run(now(), digits(phone)).changes > 0;
}

// ---------- the front desk ----------

export interface Sender {
  phone: string;
  channel: Channel;
  transport: Transport;
  /** Where replies go (e.g. the Inkbox conversation id). */
  chatRef?: string | null;
  /** Their name, if the channel reports one. */
  name?: string | null;
  text?: string;
}

/** Reply to someone who has no account yet (adapters implement it; the link doesn't exist). */
export type RawReply = (text: string) => Promise<void>;

const nagged = new Map<string, number>();
const onceADay = (phone: string) => {
  if (now() - (nagged.get(phone) ?? 0) < 24 * 3600_000) return false;
  nagged.set(phone, now());
  return true;
};

/**
 * A message from a number with no link on this channel. Returns the user id when the sender now has an account
 * (the adapter then hands the message to the bridge), or null when the front desk handled it.
 */
export async function frontDesk(s: Sender, reply: RawReply): Promise<{ userId: string; continueWith: boolean } | null> {
  const phone = digits(s.phone);
  const text = (s.text ?? '').trim();
  s = { ...s, phone };

  // Signing in from a browser with this number: reply with the code (this text proves they hold the phone).
  if (await replyWithCode(s, reply)) return null;

  // A known phone on a new channel (e.g. SMS after iMessage): the channel verified it, so link it.
  const known = accountByPhone(phone);
  if (known) {
    upsertLink(known.id, s.channel, s.transport, { status: 'connected', phone, chatRef: s.chatRef ?? null, name: s.name ?? null, error: null, lastInboundAt: now() });
    return { userId: known.id, continueWith: true };
  }

  // LINK <code>: attach this phone to an existing account (made in the web app).
  const link = text.match(/^link\s+([A-Za-z0-9]{6,12})$/i)?.[1];
  if (link) {
    const userId = redeemLinkCode(link);
    if (!userId) { await reply('That link code is invalid or expired. Get a new one in Grokbot → Settings → Messaging.'); return null; }
    const owner = getAccount(userId);
    if (owner && !owner.phone) db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, userId);
    upsertLink(userId, s.channel, s.transport, { status: 'connected', phone, chatRef: s.chatRef ?? null, name: s.name ?? null, error: null, lastInboundAt: now() });
    await deliver(userId, { text: `✅ **Connected.** This ${CHANNEL_NAMES[s.channel]} thread now reaches your Bots. Type a message to talk to your primary Bot, or send /help.` }, { kind: 'system', channel: s.channel });
    return { userId, continueWith: false };
  }

  if (!hasOwner()) { if (onceADay(phone)) await reply("This Grokbot server isn't set up yet."); return null; }

  const cfg = signupConfig();
  const claim = activeClaim(phone);
  // "JOIN <code>" in any case, or a bare code typed as shown (upper case, no look-alike characters).
  const typed = text.match(/^join\s+([A-Za-z0-9]{8})$/i)?.[1] ?? text.match(/^([A-HJ-NP-Z2-9]{8})$/)?.[1];
  const invite = (claim && usableInvite(claim.invite_code)) || (typed ? usableInvite(typed) : null);

  if (typed && !invite && !claim) { await reply("That invite code isn't valid anymore. Ask for a new invite, or reply with anything to join the waitlist."); return null; }

  if (invite || cfg.mode === 'open') {
    if (signupsToday() >= cfg.signupsPerDay) {
      addToWaitlist(s);
      await reply("Grokbot is at capacity for today, so you're on the waitlist. I'll text you here when you're in.");
      return null;
    }
    if (invite) db.prepare('UPDATE messaging_invites SET uses=uses+1 WHERE code=?').run(invite.code);
    db.prepare('DELETE FROM messaging_claims WHERE phone=?').run(phone);
    const userId = await startAccount(s, invite?.createdBy ?? null);
    return { userId, continueWith: false };
  }

  if (cfg.mode === 'closed') { if (onceADay(phone)) await reply("Grokbot isn't taking new members right now."); return null; }

  const state = addToWaitlist(s);
  if (state === 'added') nagged.set(phone, now());
  if (state === 'added') await reply("Thanks for texting Grokbot! 👋 It's invite-only for now, so you're on the waitlist. I'll text you here as soon as you're in. Have an invite code? Reply with it.");
  else if (onceADay(phone)) await reply("You're still on the waitlist. I'll text you here when you're in.");
  return null;
}

/** Create the account, link this channel, welcome them, and start onboarding with their primary Bot. */
export async function startAccount(s: Sender, invitedBy: string | null): Promise<string> {
  const { id: userId } = createAccount({ phone: s.phone, name: s.name ?? undefined, source: 'text', invitedBy });
  upsertLink(userId, s.channel, s.transport, { status: 'connected', phone: s.phone, chatRef: s.chatRef ?? null, name: s.name ?? null, error: null, lastInboundAt: now() });
  const primary = db.prepare('SELECT id, name FROM bots WHERE user_id=? AND is_primary=1').get(userId) as { id: string; name: string };
  const first = s.name?.split(/\s+/)[0];
  await deliver(userId, {
    text: `Hi${first ? ` ${first}` : ''}! 👋 I'm ${primary.name}, your Grokbot. I can get things done on the web, handle email and calendar once you connect them, and bring in teammate Bots for bigger jobs. Let's get you set up; it takes a minute.`,
  }, { kind: 'system', channel: s.channel });
  const inviter = invitedBy ? getAccount(invitedBy)?.name : null;
  enqueue(primary.id, {
    type: 'system',
    text: `[onboarding] A new user just joined by ${CHANNEL_NAMES[s.channel]}${inviter ? `, invited by ${inviter}` : ''}. ` +
      `Their ${CHANNEL_NAMES[s.channel]} name: ${s.name ?? 'unknown'}. Their number starts with +${s.phone.slice(0, Math.max(1, s.phone.length - 7))}. ` +
      `${s.text ? `Their first message was: ${JSON.stringify(s.text.slice(0, 300))}. ` : ''}` +
      'The welcome text was already sent. Start onboarding now, following the Onboarding section of your instructions: ask the first question in one short text.',
  });
  return userId;
}

export const isHostLinked = (transport: Transport, channel: Channel, phone: string) => !!hostLinkByPhone(transport, channel, phone);
export { getLink };
