import { Hono } from 'hono';
import { env } from '../../env.js';
import { saveSetting } from '../../settings.js';
import { handleInbound, type ChannelAdapter, type Inbound } from '../bridge.js';
import { chunk, toPlainText } from '../format.js';
import { accept, registerInboxHandler } from '../inbox.js';
import { frontDesk, type Sender } from '../signup.js';
import { digits, hostLinkByPhone, type Channel, type Link } from '../store.js';
import * as ib from './client.js';
import { startTunnel, tunnelEnabled, tunnelStatus, tunnelWebhookUrl } from './tunnel.js';

/**
 * Inkbox adapter: the server's iMessage/SMS line. One Inkbox identity (the "front desk") serves every user; people
 * reach it by texting the shared router number "connect @<handle>" (the join page pre-fills this), and are told apart
 * by phone number. iMessage falls back to SMS for people without iMessage. With a local number on the identity,
 * plain SMS to that number works too.
 */

export const IMESSAGE_MAX = 1500;
export const SMS_MAX = 1200;

export const inkboxConfigured = () => !!(env.inkboxIdentityKey && env.inkboxSigningKey && env.inkboxIdentityId);

export const inkboxAdapter: ChannelAdapter = {
  transport: 'inkbox',
  ready: (link) => inkboxConfigured() && link.status === 'connected' && (!!link.chatRef || !!link.phone),
  format: (md) => toPlainText(md),
  maxChars: (link) => (link.channel === 'sms' ? SMS_MAX : IMESSAGE_MAX),
  async send(link: Link, msg) {
    const key = env.inkboxIdentityKey;
    if (link.channel === 'sms' && env.inkboxPhoneNumberId) {
      return (await ib.sendSms(key, env.inkboxPhoneNumberId, { conversationId: link.chatRef ?? undefined, to: link.chatRef ? undefined : `+${link.phone}`, text: msg.text })).id;
    }
    return (await ib.sendIMessage(key, { conversationId: link.chatRef ?? undefined, to: link.chatRef ? undefined : `+${link.phone}`, text: msg.text, replyToMessageId: msg.quote })).id;
  },
  // Voice notes: iMessage only (SMS gets the text). Arrives as an audio attachment that plays in the thread.
  canSendAudio: (link) => link.channel === 'imessage' && (!!link.chatRef || !!link.phone),
  async sendAudio(link: Link, audio) {
    const key = env.inkboxIdentityKey;
    const url = await ib.uploadMedia(key, { data: audio.data, filename: audio.filename, contentType: audio.mime });
    return (await ib.sendIMessage(key, { conversationId: link.chatRef ?? undefined, to: link.chatRef ? undefined : `+${link.phone}`, mediaUrls: [url] })).id;
  },
  async typing(link, inb) {
    const conv = inb.chatRef ?? link.chatRef;
    if (link.channel !== 'imessage' || !conv) return;
    await ib.markRead(env.inkboxIdentityKey, conv).catch(() => {});
    await ib.typing(env.inkboxIdentityKey, conv);
  },
};

// ---------- inbound ----------

const dict = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

interface Parsed {
  channel: Channel;
  phone: string;
  conversationId?: string;
  messageId: string;
  text: string;
  replyTo?: string;
  media: { url: string; mime: string }[];
  reaction?: { targetId: string; kind: string };
  name?: string;
}

/** Normalize an Inkbox webhook event. Delivery lifecycle events and groups return null. */
export function parseEvent(p: any): Parsed | null {
  const type = str(p?.event_type);
  const data = dict(p?.data);
  if (!type || !data) return null;
  const media = (m: any) => (Array.isArray(m) ? m : []).map((x: any) => ({ url: str(x?.url) ?? '', mime: str(x?.content_type) ?? str(x?.mime_type) ?? '' })).filter((x: any) => x.url);
  const nameFor = (num: string) => (Array.isArray(data.contacts) ? data.contacts : []).find((c: any) => digits(c?.phone_number ?? c?.number) === num)?.name;
  if (type === 'imessage.received') {
    const m = dict(data.message);
    if (!m || m.is_group === true) return null;
    const phone = digits(str(m.remote_number) ?? str(m.sender_number));
    if (!phone || !str(m.id)) return null;
    return { channel: 'imessage', phone, conversationId: str(m.conversation_id), messageId: m.id, text: str(m.content) ?? str(m.text) ?? '', replyTo: str(m.reply_to_message_id), media: media(m.media), name: nameFor(phone) };
  }
  if (type === 'imessage.reaction_received') {
    const r = dict(data.reaction);
    if (!r) return null;
    const phone = digits(str(r.remote_number));
    if (!phone) return null;
    return { channel: 'imessage', phone, conversationId: str(r.conversation_id), messageId: str(r.id) ?? `${r.target_message_id}:${r.reaction}`, text: '', media: [], reaction: { targetId: String(r.target_message_id ?? ''), kind: String(r.reaction ?? '') } };
  }
  if (type === 'text.received') {
    const m = dict(data.text_message) ?? dict(data.message);
    if (!m) return null;
    const phone = digits(str(m.sender_phone_number) ?? str(m.remote_phone_number) ?? str(m.remote_number) ?? str(m.from));
    if (!phone) return null;
    return { channel: 'sms', phone, conversationId: str(m.conversation_id), messageId: str(m.id) ?? `${phone}:${p.timestamp}`, text: str(m.text) ?? str(m.content) ?? str(m.body) ?? '', media: media(m.media), name: nameFor(phone) };
  }
  return null;
}

/** Handle one saved event (called from the durable inbox). */
async function onEvent(p: any) {
  const e = parseEvent(p);
  if (!e) return;
  const link = hostLinkByPhone('inkbox', e.channel, e.phone);
  let userId = link?.userId ?? null;
  if (!userId) {
    if (e.reaction) return;
    const sender: Sender = { phone: e.phone, channel: e.channel, transport: 'inkbox', chatRef: e.conversationId ?? null, name: e.name ?? null, text: e.text };
    const r = await frontDesk(sender, (text) => rawReply(e, text));
    if (!r?.continueWith) return;
    userId = r.userId;
  }
  const audio = e.media.find((m) => m.mime.startsWith('audio/'));
  const image = e.media.find((m) => m.mime.startsWith('image/'));
  const inb: Inbound = {
    userId, channel: e.channel, waId: e.messageId, chatRef: e.conversationId, text: e.text, quotedId: e.replyTo,
    reaction: e.reaction,
    audio: audio ? () => ib.download(audio.url).then((d) => ({ ...d, mime: audio.mime || d.mime })) : undefined,
    image: image ? () => ib.download(image.url, 5 * 1024 * 1024).then((d) => ({ ...d, mime: image.mime || d.mime })) : undefined,
  };
  await handleInbound(inb);
}

/** Reply to someone without an account (no link exists yet). They just wrote, so the conversation is open. */
async function rawReply(e: Parsed, text: string) {
  for (const part of chunk(toPlainText(text), IMESSAGE_MAX)) {
    if (e.channel === 'sms' && env.inkboxPhoneNumberId) await ib.sendSms(env.inkboxIdentityKey, env.inkboxPhoneNumberId, { conversationId: e.conversationId, to: e.conversationId ? undefined : `+${e.phone}`, text: part });
    else await ib.sendIMessage(env.inkboxIdentityKey, { conversationId: e.conversationId, to: e.conversationId ? undefined : `+${e.phone}`, text: part });
  }
}

registerInboxHandler('inkbox', onEvent);

/** Public webhook: POST /api/messaging/inkbox/webhook. Verified, saved, acknowledged; handled in the background. */
export const inkboxWebhook = new Hono();
inkboxWebhook.post('/', async (c) => {
  if (!inkboxConfigured()) return c.text('not configured', 503);
  const raw = await c.req.text();
  const ok = ib.verifySignature(raw, { requestId: c.req.header('x-inkbox-request-id'), timestamp: c.req.header('x-inkbox-timestamp'), signature: c.req.header('x-inkbox-signature') }, env.inkboxSigningKey);
  if (!ok) return c.text('bad signature', 401);
  let body: any;
  try { body = JSON.parse(raw); } catch { return c.text('bad json', 400); }
  const type = String(body?.event_type ?? '');
  if (!/^(imessage\.received|imessage\.reaction_received|text\.received)$/.test(type)) return c.body(null, 204);
  const id = String(body?.id ?? c.req.header('x-inkbox-request-id') ?? '');
  if (!id) return c.text('missing id', 400);
  accept('inkbox', id, body);
  return c.body(null, 204);
});

// ---------- owner setup ----------

export const webhookUrl = () => tunnelWebhookUrl() ?? `${env.serverUrl.replace(/\/$/, '')}/api/messaging/inkbox/webhook`;
export { tunnelStatus };

/** Open the line's tunnel (when enabled and the line is set up). Returns the webhook URL Inkbox should post to. */
export async function ensureTunnel(): Promise<string | null> {
  if (!tunnelEnabled() || !env.inkboxIdentityKey || !env.inkboxIdentityId) return null;
  await startTunnel(inkboxWebhook);
  return tunnelWebhookUrl();
}

/** Check an admin key against Inkbox (reads the router number). */
export async function verifyAdminKey(key: string) {
  try { return { ok: true as const, router: await ib.routerInfo(key) }; }
  catch (e: any) { return { ok: false as const, error: e?.status === 401 || e?.status === 403 ? 'Inkbox rejected this key.' : `Couldn't reach Inkbox: ${e?.message ?? e}` }; }
}

export interface SetupState { step: 'identity' | 'key' | 'signing' | 'webhook' | 'done'; handle: string; identityId: string | null; error?: string }

/**
 * Set up the line, resumably: each step is saved before the next, so a failure picks up where it stopped.
 * An existing signing key we don't hold is never replaced silently (that would break other receivers).
 */
export async function setupLine(userId: string, opts: { handle?: string; withPhone?: boolean; rotateSigningKey?: boolean } = {}): Promise<SetupState> {
  const admin = env.inkboxAdminKey;
  if (!admin) throw new Error('Add your Inkbox admin key first.');
  const wanted = (opts.handle || env.inkboxHandle).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'grokbot';
  let handle = env.inkboxIdentityId ? env.inkboxHandle : wanted;
  let identityId = env.inkboxIdentityId || null;
  const state = (step: SetupState['step'], error?: string): SetupState => ({ step, handle, identityId, error });
  try {
    if (!identityId) {
      const ident = await ib.createIdentity(admin, wanted, 'Grokbot', !!opts.withPhone);
      handle = ident.handle;
      identityId = ident.id;
      saveSetting('inkbox_handle', handle, userId);
      saveSetting('inkbox_identity_id', identityId, userId);
      if (ident.phoneNumberId) saveSetting('inkbox_phone_number_id', ident.phoneNumberId, userId);
    }
    if (!env.inkboxIdentityKey) saveSetting('inkbox_identity_key', await ib.mintIdentityKey(admin, identityId, `grokbot-server-${handle}`), userId);
    if (!env.inkboxSigningKey || opts.rotateSigningKey) {
      if (!opts.rotateSigningKey && (await ib.signingKeyConfigured(admin, handle))) {
        return state('signing', 'This line already has a webhook signing key that this server doesn\'t have. Paste it into INKBOX_SIGNING_KEY, or choose "Replace signing key" (other receivers of this line will stop accepting its webhooks).');
      }
      saveSetting('inkbox_signing_key', await ib.createSigningKey(admin, handle), userId);
    }
    // The line's own tunnel (https://<handle>.inkboxwire.com) unless it's turned off for a public SERVER_URL.
    const tunneled = await ensureTunnel();
    if (!tunneled && /^http:\/\/(localhost|127\.)/.test(env.serverUrl)) return state('webhook', 'Inkbox can\'t reach localhost. Set SERVER_URL to this server\'s public HTTPS address, or turn the Inkbox tunnel back on (unset INKBOX_TUNNEL), then run setup again.');
    saveSetting('inkbox_subscription_id', await ib.subscribeWebhook(admin, identityId, tunneled ?? webhookUrl()), userId);
    return state('done');
  } catch (e: any) {
    const step: SetupState['step'] = !identityId ? 'identity' : !env.inkboxIdentityKey ? 'key' : !env.inkboxSigningKey ? 'signing' : 'webhook';
    return state(step, String(e?.message ?? e));
  }
}

/**
 * Is this number connected to the line yet? (Inkbox sends no event when someone texts "connect @handle".)
 * Used while someone waits for a sign-in code, so the code can go out as soon as they connect.
 */
export async function isConnectedToLine(phone: string): Promise<boolean> {
  if (!env.inkboxAdminKey || !env.inkboxIdentityId) return false;
  const list = await ib.listAssignments(env.inkboxAdminKey, env.inkboxIdentityId);
  return list.some((a) => digits(a.remoteNumber) === digits(phone) && a.status === 'active');
}

/** Text a number that just connected (no conversation id yet). Returns false if Inkbox won't allow it yet. */
export async function textNewlyConnected(phone: string, text: string): Promise<boolean> {
  try {
    await ib.sendIMessage(env.inkboxIdentityKey, { to: `+${digits(phone)}`, text: toPlainText(text) });
    return true;
  } catch (e: any) {
    console.warn('[inkbox] first text to a newly connected number failed:', e?.code ?? '', e?.message ?? e);
    return false;
  }
}

let router: { info: ib.RouterInfo; at: number } | null = null;
/** The number people text and the exact connect command for this line (cached). */
export async function lineInfo(): Promise<(ib.RouterInfo & { handle: string }) | null> {
  if (!env.inkboxAdminKey || !inkboxConfigured()) return null;
  if (!router || Date.now() - router.at > 3600_000) router = { info: await ib.routerInfo(env.inkboxAdminKey), at: Date.now() };
  const handle = env.inkboxHandle;
  const connect = `connect @${handle}`;
  // "?&body=" opens Messages with the text filled in on both iOS and Android.
  const smsLink = `sms:${router.info.number}?&body=${encodeURIComponent(connect)}`;
  return { ...router.info, handle, connectCommand: connect, smsLink: router.info.smsLink && router.info.smsLink.includes(handle) ? router.info.smsLink : smsLink };
}
export const forgetLineInfo = () => { router = null; };
