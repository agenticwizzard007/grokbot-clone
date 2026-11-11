import { withUsage } from '../usage-context.js';
import { assertLegacyWorkOpen, legacyWorkHeld, withLegacyWork } from '../security/legacy-work.js';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { appendRow, clearConversation, emitBot, getBotRow, getLive, getRow, listBots, onRowChange, updateRow } from '../store.js';
import { currentTrigger, enqueue, interrupt, isBotBusy, resolveApproval, runInBotQueue, type Trigger } from '../agent/loop.js';
import { dispatchRoomMessage } from '../agent/rooms.js';
import { activateSetup, getSetup } from '../bot-setup.js';
import { connectedToolkits, startConnect, toolkitInfo } from '../composio.js';
import { computers } from '../computers/index.js';
import { createPairing } from '../computers/local.js';
import { isTenant } from '../deployment.js';
import { createLoginLink, deleteAccount, getAccount } from '../accounts.js';
import type { CardBody, MessageBody, NoticeBody, Row } from '../types.js';
import { chunk, clip, toPlainText } from './format.js';
import { DEFAULT_TTS_VOICE, SpeechUnavailable, synthesize, transcribe, speechStatus, TTS_VOICES } from '../lib/speech.js';
import { matchApprovalReply, newToken, parseVerdict, type Verdict } from './approvals.js';
import { dailyUsage, memberInvite } from './signup.js';
import {
  CHANNEL_NAMES, claimRow, closeCard, engagedByText, getLink, getPrefs, isChannel, isLive, isOwnMessage, lastUserChannel, latestCard,
  listUserLinks, logMessage, markMessage, messageByWaId, openApprovals, queuedMessages, seenInbound, setPrefs, signUser, updateLink,
  type Channel, type Link, type LoggedMsg, type MsgKind, type Transport,
} from './store.js';

/**
 * The messaging bridge: one text thread on the user's phone reaches every Bot. Channel-agnostic: iMessage and SMS go
 * through here today (Inkbox adapter), and any later channel plugs in as another adapter; adapters only move messages.
 *
 * Inbound: messages go to the active Bot (the primary Bot unless changed with /use), to "@Name …", or to the Bot whose
 * message was quoted. Replies answer approvals (with a token, see approvals.ts) and questions. Slash commands manage
 * the team and the account.
 * Outbound: the transcript is watched (onRowChange). Finished replies, approvals, questions, app-connection requests
 * and errors are sent when the conversation is happening by text, or in the background (routines, check-ins, Bots
 * reporting back), or when the user isn't in the web app. Background messages follow the user to the channel they
 * last wrote from.
 *
 * Text is composed in Markdown; each adapter converts it to what its channel shows.
 */

export interface OutMessage {
  /** Markdown. */
  text: string;
  /** External message id to reply to (threaded reply where the channel supports it). */
  quote?: string;
  /** A voice note to send after the text (adapters without audio skip it). */
  audio?: { data: Buffer; mime: string; filename: string };
}

export interface InboundMedia { data: Buffer; mime: string }

export interface Inbound {
  userId: string;
  channel: Channel;
  /** External message id. */
  waId: string;
  /** Where replies go (the Inkbox conversation id). Saved on the link. */
  chatRef?: string;
  text?: string;
  /** The message this one replies to. */
  quotedId?: string;
  /** A tapback/reaction on one of our messages. */
  reaction?: { targetId: string; kind: string };
  audio?: () => Promise<InboundMedia>;
  image?: () => Promise<InboundMedia>;
}

export interface ChannelAdapter {
  transport: Transport;
  /** Send one message (already formatted and short enough); returns its external id. */
  send(link: Link, msg: OutMessage): Promise<string | null>;
  /** Whether it can deliver right now (credentials set, line ready). Otherwise messages wait in the queue. */
  ready(link: Link): boolean;
  typing?(link: Link, inb: Inbound): Promise<void>;
  /** Markdown → what this channel shows. */
  format(md: string, link: Link): string;
  /** Characters per message. */
  maxChars(link: Link): number;
  /** Send a voice note (an audio attachment); returns its external id. Only where `canSendAudio`. */
  sendAudio?(link: Link, audio: NonNullable<OutMessage['audio']>): Promise<string | null>;
  canSendAudio?(link: Link): boolean;
}

const adapters = new Map<Transport, ChannelAdapter>();
export const registerAdapter = (a: ChannelAdapter) => adapters.set(a.transport, a);
const adapterFor = (link: Link) => adapters.get(link.transport);

// ---------- sending ----------

const chains = new Map<string, Promise<unknown>>();
/** Serialize per user so messages arrive in order. */
function serial(userId: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(userId) ?? Promise.resolve();
  // Recheck after waiting: work queued before the hold must not dispatch later.
  const admitted = () => legacyWorkHeld(userId) ? Promise.resolve() : withLegacyWork(userId, job);
  const p = prev.then(admitted, admitted);
  const tail = p.then(() => {}, () => {});
  chains.set(userId, tail);
  void tail.then(() => { if (chains.get(userId) === tail) chains.delete(userId); });
  return p;
}

/** Wait for everything queued for a user to go out (tests, shutdown). */
export const drain = async (userId: string) => { while (chains.get(userId)) await chains.get(userId); };

interface Meta { botId?: string | null; kind: MsgKind; ref?: string | null; token?: string | null; slot?: number | null; channel?: Channel | null }
const TYPING_HEARTBEAT_MS = Math.max(5_000, Number(process.env.MESSAGING_TYPING_HEARTBEAT_MS ?? 20_000));
const TYPING_HEARTBEAT_MAX_MS = Math.max(TYPING_HEARTBEAT_MS, Number(process.env.MESSAGING_TYPING_HEARTBEAT_MAX_MS ?? 2 * 60 * 60_000));
const PROGRESS_FIRST_MS = Math.max(TYPING_HEARTBEAT_MS, Number(process.env.MESSAGING_PROGRESS_FIRST_MS ?? 25_000));
const PROGRESS_EVERY_MS = Math.max(TYPING_HEARTBEAT_MS, Number(process.env.MESSAGING_PROGRESS_EVERY_MS ?? 90_000));
const typingHeartbeats = new Map<string, NodeJS.Timeout>();

/**
 * Which channel reaches this user now: the one asked for if it's linked, else the one they last wrote from,
 * else any linked channel.
 */
export function pickLink(userId: string, channel?: Channel | null): Link | null {
  const links = listUserLinks(userId).filter(isLive);
  if (channel) {
    const l = links.find((x) => x.channel === channel);
    if (l) return l;
  }
  return links.sort((a, b) => (b.lastInboundAt ?? 0) - (a.lastInboundAt ?? 0) || (a.status === 'connected' ? -1 : 1))[0] ?? null;
}

export const hasTextLink = (userId: string) => listUserLinks(userId).some(isLive);

/** Deliver, or queue until the adapter can. */
export function deliver(userId: string, msg: OutMessage, meta: Meta): Promise<void> {
  return serial(userId, async () => {
    const link = pickLink(userId, meta.channel);
    const a = link && adapterFor(link);
    if (!link || !a) {
      if (meta.slot) markMessage(meta.slot, { status: 'dropped' });
      return;
    }
    if (!a.ready(link)) return queue(userId, link.channel, msg, meta);
    try {
      await sendParts(link, a, msg, meta);
    } catch (e) {
      if (legacyWorkHeld(userId)) return;
      console.warn(`[messaging] ${link.channel} send failed`, (e as Error).message);
      if (meta.slot) markMessage(meta.slot, { status: 'failed' });
    }
  });
}

function queue(userId: string, channel: Channel, full: OutMessage, meta: Meta) {
  const { audio: _audio, ...msg } = full;
  if (!msg.text) return;
  if (meta.slot) markMessage(meta.slot, { status: 'queued', payload: JSON.stringify(msg), channel });
  else logMessage(userId, { channel, botId: meta.botId, kind: meta.kind, ref: meta.ref, token: meta.token, status: 'queued', payload: JSON.stringify(msg) });
}

async function sendParts(link: Link, a: ChannelAdapter, msg: OutMessage, meta: Meta) {
  const parts = chunk(a.format(msg.text, link), a.maxChars(link));
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    assertLegacyWorkOpen(link.userId);
    const id = await a.send(link, { text: parts[i], quote: i === 0 ? msg.quote : undefined });
    // Every part maps back to its row, so quoting any of them reaches the right Bot.
    if (last && meta.slot) markMessage(meta.slot, { waId: id, status: 'sent', channel: link.channel });
    else logMessage(link.userId, { channel: link.channel, waId: id, botId: meta.botId, kind: meta.kind, ref: meta.ref, token: meta.token, status: last ? 'sent' : 'part' });
  }
  if (msg.audio && a.sendAudio && a.canSendAudio?.(link)) {
    assertLegacyWorkOpen(link.userId);
    const id = await a.sendAudio(link, msg.audio);
    if (!parts.length && meta.slot) markMessage(meta.slot, { waId: id, status: 'sent', channel: link.channel });
    else logMessage(link.userId, { channel: link.channel, waId: id, botId: meta.botId, kind: meta.kind, ref: meta.ref, status: 'sent' });
  }
  // Remember whether an approval was the last thing this channel saw (bare "yes" rules).
  updateLink(link.userId, link.channel, { lastPrompted: meta.kind === 'approval' ? meta.token ?? null : null });
}

/** Send what waited for the adapter (line set up again, the user wrote). */
export function flushQueue(userId: string) {
  if (!queuedMessages(userId).length) return Promise.resolve();
  return serial(userId, async () => {
    for (const m of queuedMessages(userId)) {
      const link = pickLink(userId, m.channel);
      const a = link && adapterFor(link);
      if (!link || !a || !a.ready(link)) continue;
      try {
        await sendParts(link, a, JSON.parse(m.payload ?? '{"text":""}'), { botId: m.botId, kind: m.kind, ref: m.ref, token: m.token, slot: m.id });
      } catch {
        if (legacyWorkHeld(userId)) return;
        markMessage(m.id, { status: 'failed' });
      }
    }
  });
}

/** Reply to the user outside any Bot (command output, errors). */
export const say = (userId: string, text: string, quote?: string, channel?: Channel) => deliver(userId, { text, quote }, { kind: 'system', channel });

function keepTypingWhileBusy(userId: string, botId: string, channel: Channel, chatRef?: string) {
  const key = `${userId}:${botId}:${channel}`;
  if (typingHeartbeats.has(key)) return;
  const started = Date.now();
  let lastProgressAt = 0;
  let lastProgressText = '';
  const tick = async () => {
    const link = pickLink(userId, channel);
    const a = link && adapterFor(link);
    const live = getLive(botId);
    const busy = isBotBusy(botId) || live.isRunning;
    if (legacyWorkHeld(userId) || !busy || !link || !a?.typing || Date.now() - started > TYPING_HEARTBEAT_MAX_MS) {
      const t = typingHeartbeats.get(key);
      if (t) clearTimeout(t);
      typingHeartbeats.delete(key);
      return;
    }
    await withLegacyWork(userId, () => a.typing!(link, { userId, channel, waId: `typing:${botId}:${Date.now()}`, chatRef: chatRef ?? link.chatRef ?? undefined })).catch(() => {});
    if (legacyWorkHeld(userId)) { typingHeartbeats.delete(key); return; }
    const progress = progressText(botId, live);
    const pastFirst = Date.now() - started >= PROGRESS_FIRST_MS;
    const due = Date.now() - lastProgressAt >= PROGRESS_EVERY_MS;
    if (progress && pastFirst && (due || progress !== lastProgressText)) {
      lastProgressAt = Date.now();
      lastProgressText = progress;
      void deliver(userId, { text: progress }, { botId, kind: 'system', channel });
    }
    typingHeartbeats.set(key, setTimeout(() => void tick(), TYPING_HEARTBEAT_MS).unref());
  };
  typingHeartbeats.set(key, setTimeout(() => void tick(), TYPING_HEARTBEAT_MS).unref());
}

// ---------- outbound: watch the transcript ----------

type Origin = Channel | 'web' | 'background' | 'bot';

/** Where the turn that wrote this row came from. */
function originOf(botId: string): Origin {
  const t: Trigger | undefined = currentTrigger(botId);
  if (t?.type === 'user') return t.channel ?? 'web';
  if (t?.type === 'routine') return 'background';
  if (t?.type === 'bot') return 'bot';
  if (t?.type === 'system' && (t.text.startsWith('[check-in]') || t.text.startsWith('[onboarding]'))) return t.text.startsWith('[onboarding]') ? lastUserChannel(botId) ?? 'background' : 'background';
  // Approvals resumed, apps connected, group replies: continue where the user last wrote.
  return lastUserChannel(botId) ?? 'background';
}

export function startBridge() {
  return onRowChange((userId, row, isNew) => {
    if (!isNew && row.body.type === 'message' && row.body.streaming !== false) return; // fast path while streaming
    if (!hasTextLink(userId)) return;
    try { onRow(userId, row, isNew); } catch (e) { console.warn('[messaging] outbound failed', (e as Error).message); }
  });
}

function onRow(userId: string, row: Row, isNew: boolean) {
  if (legacyWorkHeld(userId)) return;
  const bot = getBotRow(row.botId);
  if (!bot || bot.hidden) return;
  const b = row.body;
  const away = !hub.isOnline(userId);
  const t = currentTrigger(row.botId);
  const origin = originOf(row.botId);
  const textOrigin = isChannel(origin) ? origin : null;
  const prefs = getPrefs(userId);

  if (b.type === 'message') {
    if (b.role !== 'assistant' || b.streaming || !b.text?.trim()) return;
    const primary = !!bot.is_primary;
    const engaged = () => engagedByText(row.botId);
    const lastCh = lastUserChannel(row.botId);
    const want =
      textOrigin ? true
      : origin === 'web' ? away
      : origin === 'bot' ? (primary || engaged()) && (isChannel(lastCh) || away)
      : prefs.forward === 'all' || primary || engaged();
    if (!want) return;
    if (repeatsPrevious(row, b.text)) return;
    const slot = claimRow(userId, row.botId, row.generation, row.seq, 'reply');
    if (!slot) return;
    const channel = textOrigin ?? (isChannel(lastCh) ? lastCh : null);
    const spoken = wantsVoice(userId, row.botId, channel);
    const quote = t?.type === 'user' && textOrigin && t.channel === textOrigin ? t.quote : undefined;
    void deliver(userId, { text: replyText(userId, bot, b), quote }, { botId: row.botId, kind: 'reply', slot, channel })
      .then(() => (spoken ? voiceReply(userId, row.botId, b.text, channel) : undefined));
    return;
  }

  if (b.type === 'card') {
    const pending = b.status === 'pending';
    const kind = b.card === 'approval' ? 'approval' : b.card === 'question' ? 'question' : b.card === 'connect' ? 'connect' : null;
    if (!kind) return;
    const ref = b.card === 'approval' ? b.approvalId : `${row.botId}:${row.seq}`;
    if (!pending) { closeCard(userId, kind, ref); return; }
    if (!isNew) return;
    if (origin === 'web' && !away) return;
    const token = kind === 'approval' ? newToken() : undefined;
    const slot = claimRow(userId, row.botId, row.generation, row.seq, kind, ref, token);
    if (!slot) return;
    const channel = textOrigin ?? null;
    void cardMessage(userId, bot, row, b, token).then((msg) => deliver(userId, msg, { botId: row.botId, kind, ref, token, slot, channel }));
    return;
  }

  if (b.type === 'notice' && isNew && b.tone === 'error' && textOrigin) {
    const slot = claimRow(userId, row.botId, row.generation, row.seq, 'notice');
    if (slot) void deliver(userId, { text: `⚠️ **${bot.name}**: ${clip((b as NoticeBody).text, 600)}` }, { botId: row.botId, kind: 'notice', slot, channel: textOrigin });
  }
}

/**
 * Models often write a reply, call a tool (save a memory, update the profile), then write the same reply again.
 * Don't text it twice: skip a message identical to this Bot's previous message when nothing came in between.
 */
function repeatsPrevious(row: Row, text: string): boolean {
  const prev = db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq<? AND kind='message' ORDER BY seq DESC LIMIT 1").get(row.botId, row.generation, row.seq) as { body: string } | undefined;
  if (!prev) return false;
  const p = JSON.parse(prev.body) as MessageBody;
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  return p.role === 'assistant' && !p.from && norm(p.text ?? '') === norm(text);
}

// ---------- voice replies ----------

/** Reply by voice too? 'always', or 'voice-in' when the turn answers a voice note; iMessage only. */
function wantsVoice(userId: string, botId: string, channel: Channel | null): boolean {
  const { voiceReplies } = getPrefs(userId);
  if (voiceReplies === 'off') return false;
  const link = pickLink(userId, channel);
  const a = link && adapterFor(link);
  if (!link || !a?.canSendAudio?.(link)) return false;
  if (voiceReplies === 'always') return true;
  const t = currentTrigger(botId);
  return t?.type === 'user' && !!t.voice;
}

const SPEAK_MAX = 900;
/** What to say aloud: plain text, links not read out, long replies cut at a sentence with a pointer to the text. */
export function speakable(md: string): string {
  let t = toPlainText(md).replace(/\(?https?:\/\/\S+\)?/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  if (/https?:\/\//.test(md)) t = `${t}${/[.!?]$/.test(t) ? '' : '.'} I've sent the link in my text.`;
  if (t.length <= SPEAK_MAX) return t;
  const cut = t.slice(0, SPEAK_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return `${(end > SPEAK_MAX * 0.4 ? cut.slice(0, end + 1) : cut).trim()} The details are in my text.`;
}

/** Synthesize and send a voice note after the text. A failure leaves the text as the reply. */
async function voiceReply(userId: string, botId: string, md: string, channel: Channel | null) {
  const say = speakable(md);
  if (!say) return;
  try {
    // The user's chosen voice, else the Bot's own voice (the one it uses on live calls).
    const voice = getPrefs(userId).ttsVoice ?? getBotRow(botId)?.voice ?? DEFAULT_TTS_VOICE;
    const a = await withUsage({ userId, botId }, () => synthesize(say, voice, 'mp3'));
    await deliver(userId, { text: '', audio: { data: a.data, mime: a.mime, filename: 'voice.mp3' } }, { botId, kind: 'reply', channel });
  } catch (e) {
    console.warn('[messaging] voice reply failed:', (e as Error).message);
  }
}

/** Name the sender unless it's the Bot you're talking to. */
const needsName = (userId: string, botId: string) => activeBot(userId)?.id !== botId;

function replyText(userId: string, bot: any, b: MessageBody): string {
  let text = b.text;
  if (bot.kind === 'room' && b.from?.kind === 'bot') text = `**${b.from.name}** in _${bot.name}_:\n${text}`;
  else if (needsName(userId, bot.id)) text = `**${bot.name}:** ${text}`;
  const setup = bot.kind !== 'room' ? getSetup(bot.id) : null;
  if (setup?.onboarding.status === 'review') text += `\n\n_Reply **/activate ${bot.name}** to activate ${bot.name} with this setup._`;
  return text;
}

async function cardMessage(userId: string, bot: any, row: Row, b: CardBody, token?: string): Promise<OutMessage> {
  if (b.card === 'approval') {
    const detail = b.detail ? `\n${clip(b.detail, 700)}` : '';
    return {
      text: `🔐 **${bot.name}** needs your OK\n**${b.title}**${detail}\n\nReply **yes ${token}** to allow, **always ${token}** to always allow, or **no ${token}**. You can also tap 👍 or 👎 on this message.`,
    };
  }
  if (b.card === 'question') {
    const opts = b.options.slice(0, 10);
    return {
      text: `❓ **${bot.name}**: ${b.question}\n${opts.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n_Reply with a number, or type your own answer._`,
    };
  }
  if (b.card === 'connect') {
    let url = '';
    try { url = await connectLink(userId, b.toolkit, row.botId, row.seq); } catch (e) { console.warn('[messaging] connect link failed', (e as Error).message); }
    return {
      text: `🔌 **${bot.name}** needs **${b.toolkitName}** connected: ${b.reason}\n${url ? `Connect it here: ${url}` : 'Open Swarm to connect it.'}\n\n_Reply **skip** to continue without it._`,
    };
  }
  return { text: `${bot.name} sent something to review in Swarm.` };
}

/** A Composio connect link that works from the phone: the callback is signed instead of relying on a browser session. */
async function connectLink(userId: string, slug: string, botId?: string, seq?: number) {
  const cb = new URL(`${env.serverUrl}/api/apps/callback`);
  cb.searchParams.set('slug', slug);
  if (botId) cb.searchParams.set('bot', botId);
  if (seq) cb.searchParams.set('seq', String(seq));
  cb.searchParams.set('u', userId);
  cb.searchParams.set('sig', signUser(userId, 'apps-callback'));
  return (await startConnect(userId, slug, cb.toString())).redirectUrl;
}

// ---------- inbound ----------

const visibleBots = (userId: string) => listBots(userId);

function activeBot(userId: string) {
  const bots = visibleBots(userId);
  const { activeBotId } = getPrefs(userId);
  return bots.find((b) => b.id === activeBotId) ?? bots.find((b) => b.isPrimary) ?? bots[0] ?? null;
}

function botByName(userId: string, name: string) {
  const n = name.trim().replace(/^@/, '').toLowerCase();
  const bots = visibleBots(userId);
  return bots.find((b) => b.name.toLowerCase() === n) ?? bots.find((b) => b.name.toLowerCase().startsWith(n)) ?? null;
}

/** "@Ava do x" → Ava, "do x". Longest name wins, so "@Ava Lee" beats "@Ava". */
function mentioned(userId: string, text: string): { bot: ReturnType<typeof botByName>; rest: string } | null {
  if (!text.startsWith('@')) return null;
  const lower = text.toLowerCase();
  const hit = visibleBots(userId)
    .filter((b) => lower.startsWith(`@${b.name.toLowerCase()}`) && /^[\s,:]|^$/.test(text.slice(b.name.length + 1)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return hit ? { bot: hit, rest: text.slice(hit.name.length + 1).replace(/^[\s,:]+/, '') } : null;
}

export async function handleInbound(inb: Inbound): Promise<void> {
  return withLegacyWork(inb.userId, () => admittedInbound(inb));
}

async function admittedInbound(inb: Inbound): Promise<void> {
  const link = getLink(inb.userId, inb.channel);
  if (!isLive(link)) return;
  if (isOwnMessage(inb.userId, inb.waId) || seenInbound(inb.userId, inb.waId)) return;
  updateLink(inb.userId, inb.channel, { lastInboundAt: now(), ...(inb.chatRef ? { chatRef: inb.chatRef } : {}) });
  logMessage(inb.userId, { channel: inb.channel, waId: inb.waId, kind: 'inbound' });
  void flushQueue(inb.userId);
  const reply = (text: string) => say(inb.userId, text, inb.waId, inb.channel);

  if (inb.reaction) return handleReaction(link, inb);

  const a = adapterFor(link);
  if (a?.typing) void withLegacyWork(inb.userId, () => a.typing!(link, inb)).catch(() => {});

  let text = (inb.text ?? '').trim();
  let voice = false;
  const images: string[] = [];
  try {
    if (inb.audio) {
      const media = await inb.audio();
      console.log(`[messaging] voice note ${media.mime} ${media.data.length} bytes`);
      let heard: string;
      try { heard = await withUsage({ userId: inb.userId, botId: null }, () => transcribe(media)); }
      catch (e) {
        console.warn('[messaging] transcription failed', (e as Error).message, media.mime);
        if (e instanceof SpeechUnavailable) return void reply(`🎙️ ${e.message} Type your message instead.`);
        return void reply("🎙️ I couldn't transcribe that voice note right now. Type your message instead.");
      }
      voice = true;
      text = [text, heard].filter(Boolean).join('\n');
      if (!text) return void reply("🎙️ I couldn't make out that voice note. Try again or type it.");
    }
    if (inb.image) {
      const img = await inb.image();
      if (img.data.length <= 5 * 1024 * 1024) images.push(`data:${img.mime};base64,${img.data.toString('base64')}`);
      else return void reply('That image is too large (5 MB max).');
    }
  } catch (e) {
    console.warn('[messaging] media failed', (e as Error).message);
    return void reply("I couldn't download that attachment. Try sending it again.");
  }

  if (!text && !images.length) return;

  const quoted = inb.quotedId ? messageByWaId(inb.userId, inb.quotedId) : null;
  if (/^[/!]\w/.test(text)) return command(link, inb, text);
  if (await answerCard(link, inb, text, quoted)) return;

  const usage = dailyUsage(inb.userId);
  if (usage.over) return void reply(`You've reached today's limit of ${usage.limit} messages. It resets at midnight UTC.`);

  const m = mentioned(inb.userId, text);
  const quotedBot = quoted?.botId ? visibleBots(inb.userId).find((b) => b.id === quoted.botId) : null;
  const bot = m?.bot ?? quotedBot ?? activeBot(inb.userId);
  if (!bot) return void reply('You have no Bots yet.');
  const body = m ? m.rest : text;
  if (!body && !images.length) return void reply(`What should I tell ${bot.name}?`);
  sendToBot(inb.userId, bot.id, body || '(image)', images, inb.channel, voice, inb.waId, inb.chatRef);
}

const fromChannel = (channel: Channel): NonNullable<MessageBody['from']> => ({ kind: channel, id: channel, name: CHANNEL_NAMES[channel] });

/** Put a text message into a Bot's chat (or a group) and start its turn. */
export function sendToBot(userId: string, botId: string, text: string, images: string[] = [], channel: Channel = 'imessage', voice = false, quote?: string, chatRef?: string) {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId) return;
  appendRow(botId, 'message', { type: 'message', role: 'user', text: images.length ? `${text}${text ? '\n' : ''}📷 ${images.length} photo${images.length > 1 ? 's' : ''}` : text, from: fromChannel(channel) });
  if (bot.kind === 'room') dispatchRoomMessage(botId, text, enqueue);
  else enqueue(botId, { type: 'user', text, channel, images, voice, quote });
  keepTypingWhileBusy(userId, botId, channel, chatRef);
}

/** Replies to approval/question/connect cards. Returns true if the message was consumed. */
async function answerCard(link: Link, inb: Inbound, text: string, quoted: LoggedMsg | null): Promise<boolean> {
  const userId = link.userId;

  // Approvals: a token always counts; a bare verdict only when unambiguous (approvals.ts).
  const open = openApprovals(userId);
  const quotedApproval = quoted?.kind === 'approval' ? open.find((c) => c.ref === quoted.ref) : undefined;
  const match = quotedApproval ? (() => { const v = parseVerdict(text); return v ? { card: quotedApproval, verdict: v } : undefined; })() : matchApprovalReply(text, open, link);
  if (match?.card.ref) {
    await decide(link, inb, match.card.ref, match.verdict);
    return true;
  }
  if (quoted?.kind === 'approval' && !quotedApproval && parseVerdict(text)) {
    void say(userId, 'That request was already handled.', inb.waId, inb.channel);
    return true;
  }

  // Questions: a number or an option picks it; free text answers it when quoted or aimed at the same Bot.
  const q = quoted?.kind === 'question' ? quoted : latestCard(userId, 'question');
  const qRow = q?.botId && q.ref ? getRow(q.botId, Number(q.ref.split(':')[1])) : null;
  if (q && qRow?.body.type === 'card' && qRow.body.card === 'question' && qRow.body.status === 'pending') {
    const opts = qRow.body.options;
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    const picked = n >= 1 && n <= opts.length ? opts[n - 1] : opts.find((o) => o.toLowerCase() === text.toLowerCase());
    const sameBot = !mentioned(userId, text) && activeBot(userId)?.id === q.botId;
    if (picked || quoted?.kind === 'question' || sameBot) {
      answerQuestion(userId, q.botId!, qRow.seq, picked ?? text, inb.channel);
      return true;
    }
  }

  // App connection: "skip".
  const c = quoted?.kind === 'connect' ? quoted : latestCard(userId, 'connect');
  if (c?.botId && c.ref && /^(skip|later|not now|no)[.!]*$/i.test(text)) {
    const row = getRow(c.botId, Number(c.ref.split(':')[1]));
    if (row?.body.type === 'card' && row.body.card === 'connect' && row.body.status === 'pending') {
      updateRow(c.botId, row.seq, { ...row.body, status: 'skipped' });
      enqueue(c.botId, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
      void say(userId, `Okay, ${getBotRow(c.botId)?.name ?? 'the Bot'} will continue without ${row.body.toolkitName}.`, inb.waId, inb.channel);
      return true;
    }
  }
  return false;
}

async function decide(link: Link, inb: Inbound, approvalId: string, decision: Verdict) {
  try {
    resolveApproval(link.userId, approvalId, decision);
    closeCard(link.userId, 'approval', approvalId);
    await say(link.userId, decision === 'deny' ? "❌ Not allowed. I'll let them know." : decision === 'always' ? '✅ Allowed, and I won’t ask again for this action.' : '✅ Allowed.', inb.waId, inb.channel);
  } catch {
    await say(link.userId, 'That request is no longer waiting.', inb.waId, inb.channel);
  }
}

/** A tapback on an approval message: 👍 allows, 👎 denies. Reactions on anything else are ignored. */
async function handleReaction(link: Link, inb: Inbound) {
  const target = messageByWaId(link.userId, inb.reaction!.targetId);
  if (target?.kind !== 'approval' || !target.ref) return;
  const verdict = inb.reaction!.kind === 'like' ? 'allow' : inb.reaction!.kind === 'dislike' ? 'deny' : null;
  if (!verdict) return;
  const ap = db.prepare('SELECT status FROM approvals WHERE id=?').get(target.ref) as { status: string } | undefined;
  if (ap?.status !== 'pending') return;
  await decide(link, inb, target.ref, verdict);
}

function answerQuestion(userId: string, botId: string, seq: number, answer: string, channel: Channel) {
  const row = getRow(botId, seq);
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return;
  updateRow(botId, seq, { ...row.body, status: 'answered', answer });
  closeCard(userId, 'question', `${botId}:${seq}`);
  appendRow(botId, 'message', { type: 'message', role: 'user', text: answer, from: fromChannel(channel) });
  enqueue(botId, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}`, channel });
}

// ---------- commands ----------

function helpText(link: Link) {
  return `**Swarm on ${CHANNEL_NAMES[link.channel]}**
Just type to talk to your active Bot. Start with **@Name** to talk to another Bot, or reply to a Bot's message to answer it.

/bots: your team and what each Bot is doing
/use Name: make Name your active Bot
/status: running work, approvals and open tasks
/tasks: open tasks across your Bots
/stop [Name]: stop a Bot's current work
/new [Name]: start a fresh conversation
/apps: connected apps · /connect app: connect one
/approve · /deny: answer the latest approval
/activate Name: activate a new Bot after its setup interview
/invite: invite a friend
/voice [on|auto|off]: voice-note replies · /voice name nova
/web: open your account in a browser
/me: your profile and today's usage
/computer: connect your PC as your Bots' computer
/delete: delete your account
/help: this list`;
}

const ACTIVITY: Record<string, string> = {
  thinking: 'thinking', working: 'working', searching_web: 'searching the web', reading_web: 'reading the web', browsing_web: 'browsing',
  on_its_computer: 'on its computer', running_commands: 'running commands', waiting_on_command: 'waiting on a command',
  messaging_named: 'checking with another Bot', connecting_service: 'using a connected app', waiting_for_you: 'waiting for you',
  drafting_file: 'writing a file', remembering: 'making a note',
};

function progressText(botId: string, live = getLive(botId)): string | null {
  if (!live.isRunning) return null;
  const bot = getBotRow(botId);
  if (!bot) return null;
  const activity = ACTIVITY[live.activity?.kind ?? 'working'] ?? 'working';
  const detail = live.activity?.detail ? ` (${live.activity.detail})` : '';
  return `${bot.name} is still working: ${activity}${detail}.`;
}

function liveLine(botId: string) {
  const l = getLive(botId);
  if (l.awaiting) return `⏸ waiting for you: ${l.awaiting.reason}`;
  if (l.isRunning) return `⏳ ${ACTIVITY[l.activity?.kind ?? 'working'] ?? 'working'}${l.activity?.detail ? ` (${l.activity.detail})` : ''}`;
  return 'idle';
}

const deleteRequests = new Map<string, number>();

async function command(link: Link, inb: Inbound, raw: string) {
  const userId = link.userId;
  const [, cmd, argRaw = ''] = raw.match(/^[/!](\w+)\s*([\s\S]*)$/) ?? [];
  const arg = argRaw.trim();
  const reply = (text: string) => say(userId, text, inb.waId, inb.channel);
  const target = () => (arg ? botByName(userId, arg) : activeBot(userId));

  switch (cmd.toLowerCase()) {
    case 'help': case 'start': case 'commands':
      return void reply(helpText(link));

    case 'bots': case 'team': {
      const active = activeBot(userId);
      const lines = visibleBots(userId).map((b) => `${b.id === active?.id ? '👉' : '•'} **${b.name}**${b.label ? ` · ${b.label}` : ''}${b.kind === 'room' ? ' (group)' : ''}${b.isPrimary ? ' ⭐' : ''}\n   ${b.kind === 'room' ? 'group chat' : liveLine(b.id)}`);
      return void reply(`**Your team**\n${lines.join('\n')}\n\n_/use Name to switch · @Name message to talk to one Bot_`);
    }

    case 'use': case 'switch': case 'talk': {
      if (!arg) return void reply(`You're talking to **${activeBot(userId)?.name ?? 'nobody'}**. Use /use Name to switch.`);
      const b = botByName(userId, arg);
      if (!b) return void reply(`No Bot named "${arg}". Send /bots to see your team.`);
      setPrefs(userId, { activeBotId: b.id });
      return void reply(`👉 You're now talking to **${b.name}**${b.label ? ` (${b.label})` : ''}. Messages go to ${b.name} until you switch.`);
    }

    case 'status': {
      const bots = visibleBots(userId).filter((b) => b.kind !== 'room');
      const busy = bots.filter((b) => getLive(b.id).isRunning || getLive(b.id).awaiting).map((b) => `• **${b.name}**: ${liveLine(b.id)}`);
      const approvals = db.prepare("SELECT b.name, a.tool FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? AND a.status='pending' ORDER BY a.created_at DESC LIMIT 10").all(userId) as any[];
      const tasks = db.prepare("SELECT b.name, t.title, t.state FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? AND t.state<>'done' ORDER BY t.updated_at DESC LIMIT 10").all(userId) as any[];
      return void reply([
        busy.length ? `**Working now**\n${busy.join('\n')}` : '**Working now**\nNobody is busy.',
        approvals.length ? `**Waiting for your OK**\n${approvals.map((a) => `• ${a.name}: ${a.tool}`).join('\n')}` : '',
        tasks.length ? `**Open tasks**\n${tasks.map((t) => `• ${t.title} (${t.name}${t.state === 'needs_input' ? ', needs you' : ''})`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n'));
    }

    case 'tasks': {
      const tasks = db.prepare("SELECT b.name, t.title, t.state, t.note FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? AND t.state<>'done' ORDER BY t.updated_at DESC LIMIT 20").all(userId) as any[];
      return void reply(tasks.length ? `**Open tasks**\n${tasks.map((t) => `• **${t.title}** · ${t.name}${t.state === 'needs_input' ? ' · needs you' : ''}${t.note ? `\n   ${clip(t.note, 120)}` : ''}`).join('\n')}` : 'No open tasks.');
    }

    case 'stop': case 'cancel': {
      const b = target();
      if (!b) return void reply(`No Bot named "${arg}".`);
      interrupt(b.id);
      return void reply(`⏹ Stopped **${b.name}**.`);
    }

    case 'new': case 'reset': case 'fresh': {
      const b = target();
      if (!b) return void reply(`No Bot named "${arg}".`);
      interrupt(b.id);
      clearConversation(b.id);
      emitBot(b.id);
      return void reply(`🆕 Started a fresh conversation with **${b.name}**.`);
    }

    case 'apps': {
      if (!env.composioEnabled) return void reply("Connected apps aren't set up on this server yet.");
      const apps = [...(await connectedToolkits(userId).catch(() => new Set<string>()))];
      return void reply(apps.length ? `**Connected apps**\n${apps.map((a) => `• ${a}`).join('\n')}\n\n_/connect app to add one_` : 'No apps connected yet. Send /connect gmail (or any app) to connect one.');
    }

    case 'connect': {
      if (!env.composioEnabled) return void reply("Connected apps aren't set up on this server yet.");
      if (!arg) return void reply('Which app? For example /connect gmail, /connect googlecalendar or /connect slack.');
      const slug = arg.toLowerCase().replace(/[^a-z0-9_]/g, '');
      const info = await toolkitInfo(slug).catch(() => undefined);
      if (!info) return void reply(`I couldn't find an app called "${arg}". Try its short name, like gmail, slack, notion or github.`);
      try {
        return void reply(`🔌 Connect **${info.name}**: ${await connectLink(userId, info.slug)}`);
      } catch (e) {
        return void reply(`Couldn't start connecting ${info.name}: ${(e as Error).message}`);
      }
    }

    case 'approve': case 'allow': case 'deny': case 'reject': {
      const open = openApprovals(userId);
      const tok = arg.toUpperCase().match(/\b[A-Z0-9]{4}\b/)?.[0];
      const card = (tok && open.find((c) => c.token === tok)) || (open.length === 1 ? open[0] : undefined);
      if (!open.length) return void reply('Nothing is waiting for your approval.');
      if (!card?.ref) return void reply(`${open.length} requests are waiting. Add the code, like /approve ${open[0].token}.`);
      const deny = cmd.toLowerCase() === 'deny' || cmd.toLowerCase() === 'reject';
      return decide(link, inb, card.ref, deny ? 'deny' : /\balways\b/i.test(arg) ? 'always' : 'allow');
    }

    case 'activate': {
      const b = target();
      if (!b || b.kind === 'room') return void reply(arg ? `No Bot named "${arg}".` : 'Which Bot? /activate Name');
      const setup = getSetup(b.id);
      if (!setup || setup.onboarding.status === 'active') return void reply(`**${b.name}** is already active.`);
      if (setup.onboarding.status !== 'review') return void reply(`**${b.name}** is still in its setup interview. Answer its questions first (@${b.name} …).`);
      try {
        const pending = await runInBotQueue(b.id, async () => activateSetup(b.id, setup.onboarding.revision));
        if (pending) enqueue(b.id, { type: 'system', text: `Your setup has been confirmed by the user. Now handle this initial assignment from your creation brief:\n${pending}` });
        return void reply(`✅ **${b.name}** is active.`);
      } catch (e) {
        return void reply(`Couldn't activate ${b.name}: ${(e as Error).message}`);
      }
    }

    case 'invite': {
      const r = isTenant ? await (await import('../runtime/messaging.js')).messagingRequest('invite',{channel:inb.channel}) : memberInvite(userId);
      if ('error' in r) return void reply(r.error);
      return void reply(`🎟️ Your invite link (${r.remaining} left):\n${r.url}\n\nSend it to someone; they enter their number and text us to get their own Bots.`);
    }

    case 'voice': {
      const [sub, ...rest] = arg.toLowerCase().split(/\s+/);
      const cur = getPrefs(userId);
      const describe = (v: string) => (v === 'always' ? 'every reply also comes as a voice note' : v === 'off' ? 'replies are text only' : 'when you send a voice note, the reply comes as a voice note too');
      if (!sub) return void reply(`🔊 Voice replies: ${describe(cur.voiceReplies)}. Voice: ${cur.ttsVoice ?? "each Bot's own"}.\n/voice on · /voice auto · /voice off · /voice name eve (or /voice name bot)`);
      if (sub === 'name' || sub === 'as') {
        const v = rest[0];
        if (v === 'bot' || v === 'default') { setPrefs(userId, { ttsVoice: null }); return void reply("🔊 Each Bot will use its own voice."); }
        if (!v || !TTS_VOICES.includes(v)) return void reply(`Pick a voice: ${TTS_VOICES.join(', ')}, or "bot" for each Bot's own.`);
        setPrefs(userId, { ttsVoice: v });
        return void reply(`🔊 Voice set to ${v}.`);
      }
      const mode = sub === 'on' || sub === 'always' ? 'always' : sub === 'auto' ? 'voice-in' : sub === 'off' ? 'off' : null;
      if (!mode) return void reply('Use /voice on, /voice auto, /voice off, or /voice name <voice>.');
      setPrefs(userId, { voiceReplies: mode });
      return void reply(`🔊 Got it: ${describe(mode)}.`);
    }

    case 'web': case 'login': {
      if(isTenant){await (await import('../runtime/messaging.js')).messagingRequest('login-link',{channel:inb.channel});return;}
      const url = createLoginLink(userId);
      return void reply(`🔑 Open your Swarm in a browser (works once, for 10 minutes):\n${url}`);
    }

    case 'me': case 'profile': case 'usage': {
      const acct = getAccount(userId);
      const usage = dailyUsage(userId);
      const channels = listUserLinks(userId).filter(isLive).map((l) => CHANNEL_NAMES[l.channel]).join(', ');
      return void reply(`**${acct?.name ?? 'You'}**\n${acct?.phone ? `Phone: +${acct.phone}\n` : ''}${acct?.email && !acct.email.endsWith('.invalid') ? `Email: ${acct.email}\n` : ''}Time zone: ${acct?.timezone ?? 'not set'}\nConnected: ${channels || 'none'}\nToday: ${usage.used}${usage.limit ? ` of ${usage.limit}` : ''} messages\nVoice replies: ${getPrefs(userId).voiceReplies}${speechStatus().speech ? '' : ' (not available on this server)'}`);
    }

    case 'computer': case 'pc': {
      if (computers.kind !== 'local') {
        const st = computers.state(userId);
        return void reply(`Your Bots use a cloud computer (status: ${st.status}). Nothing to set up.`);
      }
      const token = createPairing(userId);
      if(isTenant)await (await import('../runtime/companion-registration.js')).registerCompanion('desktop',token);
      const server = env.serverUrl.replace(/\/+$/, '');
      return void reply(`💻 To let your Bots use a browser on your PC, run this on it (needs Node.js 22+ and Chrome) and keep it running:\n\ncurl -fsSL ${server}/api/companion/script -o swarm-companion.mjs && node swarm-companion.mjs --server ${server} --token ${token}${env.localDesktop ? ' --desktop' : ''}\n\nThe token is private: anyone with it can connect their PC as your Bots' computer.`);
    }

    case 'delete': {
      if(isTenant)return void reply('Open Settings → Account to delete your account, or send /delete again through your connected phone.');
      if (arg.toLowerCase() !== 'confirm') {
        deleteRequests.set(userId, now());
        return void reply('⚠️ This deletes your Swarm account: every Bot, conversation, memory and connection. Send **/delete confirm** within 5 minutes to go ahead.');
      }
      const asked = deleteRequests.get(userId);
      if (!asked || now() - asked > 5 * 60_000) return void reply('Send /delete first, then /delete confirm.');
      deleteRequests.delete(userId);
      await reply('Your account is being deleted. Goodbye 👋');
      await drain(userId);
      await deleteAccount(userId);
      return;
    }

    default:
      return void reply(`I don't know /${cmd}. Send /help for commands.`);
  }
}
