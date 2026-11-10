import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';

/**
 * Messaging state: how each user reaches their Bots by text.
 *
 * A user has at most one link per channel (iMessage, SMS). Each link names the transport that carries it; today that is
 * 'inkbox': the server's iMessage/SMS line through Inkbox (inkbox.ai). A host line serves every user from one number
 * and tells users apart by phone number. New channels plug in as adapters (bridge.ts).
 */

export type Channel = 'imessage' | 'sms';
export type Transport = 'inkbox';
export type LinkStatus = 'pairing' | 'connected' | 'disconnected' | 'logged_out' | 'error';
export type ForwardMode = 'all' | 'engaged';
/** When Bots also answer with a voice note: 'voice-in' = when you sent one (default), 'always', or 'off'. */
export type VoiceReplies = 'voice-in' | 'always' | 'off';
export const VOICE_REPLIES: VoiceReplies[] = ['voice-in', 'always', 'off'];
export const CHANNELS: Channel[] = ['imessage', 'sms'];
export const CHANNEL_NAMES: Record<Channel, string> = { imessage: 'iMessage', sms: 'SMS' };
export const isChannel = (v: unknown): v is Channel => CHANNELS.includes(v as Channel);

db.exec(`
CREATE TABLE IF NOT EXISTS messaging_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pairing',
  phone TEXT,
  name TEXT,
  chat_ref TEXT,
  last_inbound_at INTEGER,
  last_prompted TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel)
);
CREATE UNIQUE INDEX IF NOT EXISTS messaging_host_phone ON messaging_links(transport, channel, phone);
CREATE TABLE IF NOT EXISTS messaging_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_bot_id TEXT,
  forward TEXT NOT NULL DEFAULT 'all'
);
CREATE TABLE IF NOT EXISTS messaging_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT,
  wa_id TEXT,
  bot_id TEXT,
  generation INTEGER,
  seq INTEGER,
  kind TEXT NOT NULL,
  ref TEXT,
  token TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messaging_messages_ext ON messaging_messages(user_id, wa_id);
CREATE UNIQUE INDEX IF NOT EXISTS messaging_messages_row ON messaging_messages(user_id, bot_id, generation, seq, kind) WHERE seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS messaging_inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messaging_inbox_pending ON messaging_inbox(status, next_at);
CREATE TABLE IF NOT EXISTS messaging_invites (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_claims (
  phone TEXT PRIMARY KEY,
  invite_code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_waitlist (
  phone TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  transport TEXT NOT NULL,
  chat_ref TEXT,
  name TEXT,
  first_message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`);

for (const [col, ddl] of [['voice_replies', "TEXT NOT NULL DEFAULT 'voice-in'"], ['tts_voice', 'TEXT']] as const) {
  const cols = db.prepare('PRAGMA table_info(messaging_prefs)').all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE messaging_prefs ADD COLUMN ${col} ${ddl}`);
}

// The earlier WhatsApp-only experiment is gone; drop its tables if a database still has them.
db.exec('DROP TABLE IF EXISTS whatsapp_links; DROP TABLE IF EXISTS whatsapp_messages; DROP TABLE IF EXISTS whatsapp_codes; DROP TABLE IF EXISTS whatsapp_auth;');

export interface Link {
  userId: string;
  channel: Channel;
  transport: Transport;
  status: LinkStatus;
  /** The user's own number, digits only. */
  phone: string | null;
  /** Their name as the channel reports it, if any. */
  name: string | null;
  /** Where replies go: the Inkbox conversation id. */
  chatRef: string | null;
  lastInboundAt: number | null;
  /** Token of the approval that was the last thing sent on this link (see approvals.ts). */
  lastPrompted: string | null;
  error: string | null;
}

const toLink = (r: any): Link => ({
  userId: r.user_id, channel: r.channel, transport: r.transport, status: r.status, phone: r.phone, name: r.name,
  chatRef: r.chat_ref, lastInboundAt: r.last_inbound_at, lastPrompted: r.last_prompted, error: r.error,
});

export function getLink(userId: string, channel: Channel): Link | null {
  const r = db.prepare('SELECT * FROM messaging_links WHERE user_id=? AND channel=?').get(userId, channel);
  return r ? toLink(r) : null;
}

export const listUserLinks = (userId: string): Link[] => (db.prepare('SELECT * FROM messaging_links WHERE user_id=? ORDER BY channel').all(userId) as any[]).map(toLink);

export const listLinks = (transport?: Transport): Link[] =>
  (transport ? db.prepare('SELECT * FROM messaging_links WHERE transport=?').all(transport) : db.prepare('SELECT * FROM messaging_links').all()).map(toLink);

export const isLive = (l: Link | null | undefined): l is Link => !!l && (l.status === 'connected' || l.status === 'disconnected');

/** A host-line link by the user's phone number. */
export function hostLinkByPhone(transport: Transport, channel: Channel, phone: string): Link | null {
  const r = db.prepare('SELECT * FROM messaging_links WHERE transport=? AND channel=? AND phone=?').get(transport, channel, digits(phone));
  return r ? toLink(r) : null;
}

export function upsertLink(userId: string, channel: Channel, transport: Transport, patch: Partial<Omit<Link, 'userId' | 'channel' | 'transport'>> = {}) {
  const cur = getLink(userId, channel);
  if (!cur || cur.transport !== transport) {
    db.prepare('DELETE FROM messaging_links WHERE user_id=? AND channel=?').run(userId, channel);
    db.prepare('INSERT INTO messaging_links(user_id,channel,transport,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(userId, channel, transport, 'pairing', now(), now());
  }
  updateLink(userId, channel, patch);
}

const COLS: Record<string, string> = {
  status: 'status', phone: 'phone', name: 'name', chatRef: 'chat_ref',
  lastInboundAt: 'last_inbound_at', lastPrompted: 'last_prompted', error: 'error',
};

export function updateLink(userId: string, channel: Channel, patch: Partial<Omit<Link, 'userId' | 'channel' | 'transport'>>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in COLS) || v === undefined) continue;
    sets.push(`${COLS[k]}=?`);
    vals.push(v);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE messaging_links SET ${sets.join(',')}, updated_at=? WHERE user_id=? AND channel=?`).run(...vals, now(), userId, channel);
  if (Object.keys(patch).some((k) => k !== 'lastPrompted' && k !== 'lastInboundAt')) hub.emit(userId, { type: 'messaging' });
}

export function deleteLink(userId: string, channel: Channel) {
  db.prepare('DELETE FROM messaging_links WHERE user_id=? AND channel=?').run(userId, channel);
  hub.emit(userId, { type: 'messaging' });
}

export const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

// ---------- per-user preferences (shared by every channel) ----------

export interface Prefs { activeBotId: string | null; forward: ForwardMode; voiceReplies: VoiceReplies; ttsVoice: string | null }

export function getPrefs(userId: string): Prefs {
  const r = db.prepare('SELECT * FROM messaging_prefs WHERE user_id=?').get(userId) as any;
  return {
    activeBotId: r?.active_bot_id ?? null, forward: r?.forward === 'engaged' ? 'engaged' : 'all',
    voiceReplies: VOICE_REPLIES.includes(r?.voice_replies) ? r.voice_replies : 'voice-in', ttsVoice: r?.tts_voice ?? null,
  };
}

export function setPrefs(userId: string, p: Partial<Prefs>) {
  const cur = getPrefs(userId);
  db.prepare('INSERT OR REPLACE INTO messaging_prefs(user_id,active_bot_id,forward,voice_replies,tts_voice) VALUES (?,?,?,?,?)')
    .run(userId, p.activeBotId !== undefined ? p.activeBotId : cur.activeBotId, p.forward ?? cur.forward, p.voiceReplies ?? cur.voiceReplies, p.ttsVoice !== undefined ? p.ttsVoice : cur.ttsVoice);
  hub.emit(userId, { type: 'messaging' });
}

// ---------- one-time link codes (attach a phone to an existing account) ----------

const CODE_TTL = 15 * 60_000;
/** No look-alike characters (0/O, 1/I/L): people type these on phones. */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const randomCode = (n: number) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

export function newLinkCode(userId: string): { code: string; expiresAt: number } {
  db.prepare('DELETE FROM messaging_codes WHERE user_id=? OR expires_at<?').run(userId, now());
  const code = randomCode(8);
  const expiresAt = now() + CODE_TTL;
  db.prepare('INSERT INTO messaging_codes(code,user_id,expires_at) VALUES (?,?,?)').run(code, userId, expiresAt);
  return { code, expiresAt };
}

export function redeemLinkCode(code: string): string | null {
  const r = db.prepare('SELECT * FROM messaging_codes WHERE code=? AND expires_at>?').get(code.toUpperCase(), now()) as any;
  if (!r) return null;
  db.prepare('DELETE FROM messaging_codes WHERE code=?').run(r.code);
  return r.user_id;
}

// ---------- message log: maps external message ids to transcript rows (quoted replies, dedupe, queue) ----------

export type MsgKind = 'reply' | 'approval' | 'question' | 'connect' | 'notice' | 'inbound' | 'system';

export interface LoggedMsg { id: number; userId: string; channel: Channel | null; waId: string | null; botId: string | null; generation: number | null; seq: number | null; kind: MsgKind; ref: string | null; token: string | null; status: string; payload: string | null; createdAt: number }

const toMsg = (r: any): LoggedMsg => ({ id: r.id, userId: r.user_id, channel: r.channel, waId: r.wa_id, botId: r.bot_id, generation: r.generation, seq: r.seq, kind: r.kind, ref: r.ref, token: r.token, status: r.status, payload: r.payload, createdAt: r.created_at });

/** Reserve a row → message slot. Returns null if this row was already forwarded (dedupe). */
export function claimRow(userId: string, botId: string, generation: number, seq: number, kind: MsgKind, ref?: string, token?: string): number | null {
  const r = db.prepare('INSERT OR IGNORE INTO messaging_messages(user_id,bot_id,generation,seq,kind,ref,token,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(userId, botId, generation, seq, kind, ref ?? null, token ?? null, 'sending', now());
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export function logMessage(userId: string, m: { channel?: Channel | null; waId?: string | null; botId?: string | null; kind: MsgKind; ref?: string | null; token?: string | null; status?: string; payload?: string | null }): number {
  return Number(db.prepare('INSERT INTO messaging_messages(user_id,channel,wa_id,bot_id,kind,ref,token,status,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(userId, m.channel ?? null, m.waId ?? null, m.botId ?? null, m.kind, m.ref ?? null, m.token ?? null, m.status ?? 'sent', m.payload ?? null, now()).lastInsertRowid);
}

export function markMessage(id: number, patch: { waId?: string | null; status?: string; payload?: string | null; channel?: Channel | null }) {
  db.prepare('UPDATE messaging_messages SET wa_id=COALESCE(?,wa_id), status=COALESCE(?,status), payload=COALESCE(?,payload), channel=COALESCE(?,channel) WHERE id=?')
    .run(patch.waId ?? null, patch.status ?? null, patch.payload ?? null, patch.channel ?? null, id);
}

export function messageByWaId(userId: string, waId: string): LoggedMsg | null {
  const r = db.prepare('SELECT * FROM messaging_messages WHERE user_id=? AND wa_id=? ORDER BY id DESC LIMIT 1').get(userId, waId);
  return r ? toMsg(r) : null;
}

export const isOwnMessage = (userId: string, waId: string) =>
  !!db.prepare("SELECT 1 FROM messaging_messages WHERE user_id=? AND wa_id=? AND kind<>'inbound'").get(userId, waId);

export const seenInbound = (userId: string, waId: string) =>
  !!db.prepare("SELECT 1 FROM messaging_messages WHERE user_id=? AND wa_id=? AND kind='inbound'").get(userId, waId);

/** The most recent card of a kind sent to this user that may still be open. */
export function latestCard(userId: string, kind: 'approval' | 'question' | 'connect', withinMs = 24 * 3600_000): LoggedMsg | null {
  const r = db.prepare("SELECT * FROM messaging_messages WHERE user_id=? AND kind=? AND status IN ('sent','queued') AND created_at>? ORDER BY id DESC LIMIT 1").get(userId, kind, now() - withinMs);
  return r ? toMsg(r) : null;
}

/** Approval cards sent to this user whose approval is still pending. */
export function openApprovals(userId: string): LoggedMsg[] {
  return (db.prepare(`SELECT m.* FROM messaging_messages m JOIN approvals a ON a.id=m.ref
    WHERE m.user_id=? AND m.kind='approval' AND m.token IS NOT NULL AND m.status IN ('sent','queued') AND a.status='pending' ORDER BY m.id DESC`).all(userId) as any[]).map(toMsg);
}

export function closeCard(userId: string, kind: MsgKind, ref: string) {
  db.prepare("UPDATE messaging_messages SET status='closed' WHERE user_id=? AND kind=? AND ref=?").run(userId, kind, ref);
}

export const queuedMessages = (userId: string): LoggedMsg[] =>
  (db.prepare("SELECT * FROM messaging_messages WHERE user_id=? AND status='queued' ORDER BY id ASC LIMIT 50").all(userId) as any[]).map(toMsg);

const TEXT_KINDS = "('imessage','sms')";

/** Has the user messaged this Bot by text recently? Its replies then always come back by text. */
export function engagedByText(botId: string, withinMs = 24 * 3600_000): boolean {
  return !!db.prepare(
    `SELECT 1 FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.from.kind') IN ${TEXT_KINDS} AND created_at>? LIMIT 1`,
  ).get(botId, now() - withinMs);
}

/** Where the user last wrote to this Bot: a text channel, 'web', or null if never. */
export function lastUserChannel(botId: string): Channel | 'web' | null {
  const r = db.prepare(`SELECT body FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='user' AND (json_extract(body,'$.from.kind') IS NULL OR json_extract(body,'$.from.kind') IN ('voice','imessage','sms')) ORDER BY created_at DESC, seq DESC LIMIT 1`).get(botId) as any;
  if (!r) return null;
  const kind = JSON.parse(r.body).from?.kind;
  return isChannel(kind) ? kind : 'web';
}

// ---------- signed callback params (app connections opened from a phone, without a browser session) ----------

const sigKey = crypto.createHash('sha256').update(`grokbot-messaging:${env.sessionSecret}`).digest();
export const signUser = (userId: string, scope: string) => crypto.createHmac('sha256', sigKey).update(`${scope}:${userId}`).digest('base64url').slice(0, 32);
export function verifyUserSig(userId: string, scope: string, sig: string) {
  const want = Buffer.from(signUser(userId, scope));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
