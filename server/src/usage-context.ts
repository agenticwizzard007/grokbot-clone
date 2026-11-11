import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db.js';
import type { UsageKind } from './usage.js';
import { localAccess } from './computers/local-access.js';
import { LegacyActivityGate } from './security/legacy-activity.js';

interface UsageCtx { userId?: string | null; botId?: string | null; kind?: UsageKind; resolveUser?: () => string | null | undefined; computerRevision?: number }
const als = new AsyncLocalStorage<UsageCtx>();
const legacyActivities = new LegacyActivityGate(db);
/** Only one part of migration quiescence; subprocesses, VM jobs and files need separate fences. */
export const drainLegacyUsage = (userId: string, timeoutMs?: number) => legacyActivities.drain(userId, timeoutMs);

export function withUsage<T>(ctx: UsageCtx, fn: () => T): T {
  const previous = als.getStore();
  const merged = { ...previous, ...ctx };
  if (ctx.botId && (ctx.botId !== previous?.botId || previous.computerRevision === undefined)) {
    const owner = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(ctx.botId) as { user_id: string } | undefined)?.user_id;
    if (owner) merged.computerRevision = localAccess(owner).revision;
  }
  if (ctx.botId === null) delete merged.computerRevision;
  const botOwner = merged.botId ? (db.prepare('SELECT user_id FROM bots WHERE id=?').get(merged.botId) as {user_id:string}|undefined)?.user_id : null;
  const owner = botOwner ?? merged.userId ?? merged.resolveUser?.();
  return legacyActivities.run(owner, () => als.run(merged, fn));
}

export function attribution(explicit: { userId?: string | null; botId?: string | null; kind?: UsageKind } = {}) {
  const store = als.getStore() ?? {};
  const botId = explicit.botId ?? store.botId ?? null;
  // A queued Bot job can inherit the request of another user; the Bot's owner is authoritative.
  const botOwner = botId ? (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined)?.user_id : null;
  let userId = explicit.userId ?? botOwner ?? store.userId ?? null;
  if (!userId && store.resolveUser) {
    try { userId = store.resolveUser() ?? null; } catch { userId = null; }
  }
  return { userId, botId, kind: explicit.kind ?? store.kind ?? 'other' };
}

export const currentUserId = () => attribution().userId;
export const currentComputerRevision = () => als.getStore()?.computerRevision;
