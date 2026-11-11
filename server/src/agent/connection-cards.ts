import { connectionsDetail, startConnect, type AppConnection } from '../composio.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { getBotRow, getRow, updateRow } from '../store.js';
import type { CardBody } from '../types.js';
import { newId } from '../lib/ids.js';

type ConnectBody = Extract<CardBody, { card: 'connect' }>;
export class ConnectionCardChanged extends Error {
  constructor() { super('This connection request changed. Start again from the current conversation.'); }
}
const starting = new Map<string, Promise<Awaited<ReturnType<typeof startConnect>>>>();

/** Bind new browser or messaging authorizations to the exact card and generation.
 * OAuth URLs remain out of chat rows, native snapshots and model prompts. */
export async function startCardConnect(userId: string, toolkit: string, callback: URL, botId?: string, seq?: number) {
  if (botId === undefined && seq === undefined) return startConnect(userId, toolkit, callback.href);
  const bot = botId ? getBotRow(botId) : null;
  const row = bot && bot.user_id === userId && Number.isSafeInteger(seq) && seq! > 0 ? getRow(bot.id, seq!) : null;
  if (!bot || !row || row.body.type !== 'card' || row.body.card !== 'connect' || row.body.toolkit !== toolkit || row.body.status !== 'pending') throw new ConnectionCardChanged();
  const key = JSON.stringify([userId, bot.id, row.generation, row.seq]);
  const pending = starting.get(key);
  if (pending) return pending;
  const attempt = newId('connect');
  callback.searchParams.set('generation', String(row.generation));
  callback.searchParams.set('attempt', attempt);
  updateRow(bot.id, row.seq, { ...row.body, connectedAccountId: undefined, connectionAttempt: attempt });
  const promise = (async () => {
    const result = await startConnect(userId, toolkit, callback.href);
    const currentBot = getBotRow(bot.id);
    const current = currentBot?.user_id === userId && currentBot.generation === row.generation ? getRow(bot.id, row.seq) : null;
    if (!current || current.body.type !== 'card' || current.body.card !== 'connect' || current.body.status !== 'pending' || current.body.connectionAttempt !== attempt) throw new ConnectionCardChanged();
    if (result.connectedAccountId) updateRow(bot.id, row.seq, { ...current.body, connectedAccountId: result.connectedAccountId });
    return result;
  })();
  starting.set(key, promise);
  try { return await promise; }
  finally { if (starting.get(key) === promise) starting.delete(key); }
}
export interface PendingConnectionCard {
  botId: string; generation: number; seq: number; createdAt: number; body: ConnectBody;
}

export function pendingConnectionCards(userId: string): PendingConnectionCard[] {
  return (db.prepare(`SELECT r.bot_id,r.generation,r.seq,r.created_at,r.body FROM rows r JOIN bots b
    ON b.id=r.bot_id AND b.generation=r.generation WHERE b.user_id=? AND r.kind='card'
    AND json_extract(r.body,'$.card')='connect' AND json_extract(r.body,'$.status')='pending'
    ORDER BY r.created_at DESC,r.seq DESC LIMIT 500`).all(userId) as any[])
    .map(r => ({ botId: r.bot_id, generation: r.generation, seq: r.seq, createdAt: r.created_at, body: JSON.parse(r.body) }));
}

/** The caller supplies a complete, owner-scoped provider list. Never infer a legacy
 * card's account by toolkit, and never interpret a missing account as expiration
 * (tenant lists deliberately omit unfinished authorization attempts). No jobs run. */
export function reconcileConnectionCards(userId: string, cards: PendingConnectionCard[], accounts: AppConnection[]) {
  for (const card of cards) {
    if (!card.body.connectedAccountId) continue;
    const matches = accounts.filter(a => a.id === card.body.connectedAccountId);
    if (matches.length !== 1 || matches[0].toolkit !== card.body.toolkit) continue;
    const account = matches[0];
    const status = account.status === 'ACTIVE' && !account.isDisabled ? 'connected'
      : ['EXPIRED', 'REVOKED', 'INACTIVE', 'FAILED'].includes(account.status) ? 'expired' : null;
    if (!status) continue;
    // A live assignment stays blocked until its exact callback queues the
    // continuation. Resolving it here would let independent work overtake it.
    if (status === 'connected' && card.body.jobId && !card.body.answerJobId) continue;
    const bot = getBotRow(card.botId);
    if (!bot || bot.user_id !== userId || bot.generation !== card.generation) continue;
    const row = getRow(card.botId, card.seq);
    // A retry, dismissal or callback that arrived during the lookup wins.
    if (!row || row.generation !== card.generation || JSON.stringify(row.body) !== JSON.stringify(card.body)) continue;
    updateRow(card.botId, card.seq, { ...card.body, status });
  }
}

/** Bounded status maintenance only; never creates auth, deletes accounts, or resumes work. */
export async function refreshConnectionCards(userId: string) {
  const cards = pendingConnectionCards(userId).filter(c => c.body.connectedAccountId);
  if (!cards.length || !env.composioEnabled) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accounts = await Promise.race([
      connectionsDetail(userId, { signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timed out')); }, 1500); }),
    ]);
    reconcileConnectionCards(userId, cards, accounts);
  } catch { /* Unknown status preserves pending cards. Provider errors stay private. */ }
  finally { clearTimeout(timer); controller.abort(); }
}
