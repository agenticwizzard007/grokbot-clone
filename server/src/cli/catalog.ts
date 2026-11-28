import { normalizeModelEfforts } from '../lib/model-efforts.js';
import { z } from 'zod';
import { cliRequest } from './bridge.js';
import { cliRuntime, selectedCli, type CliProvider } from './store.js';

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const schema = z.object({
  models: z.array(z.object({ id: z.string().max(130), name: z.string().max(160), resolvedModel: z.string().max(120).optional(), efforts: z.array(effort), defaultEffort: effort.nullable(), vision: z.boolean() })).max(1000),
  defaultModel: z.string().nullable(), plan: z.string().max(160).nullable(),
  usage: z.object({ available: z.boolean(), checkedAt: z.number().finite(), windows: z.array(z.object({ label: z.string().max(700), usedPercent: z.number().finite().min(0), resetsAt: z.number().finite().nullable() })).max(100) }),
});
const revisions = new Map<string, number>();
const cache = new Map<string, { at: number; value: ReturnType<typeof normalize> }>();
/** Local observation only. Reading usage must never start a provider probe. */
export function cachedCliCatalog(userId: string, provider: CliProvider) {
  return cache.get(`${userId}:${cliRuntime(userId)}:${provider}`)?.value ?? null;
}
interface PendingCatalog {
  controller: AbortController;
  promise: Promise<ReturnType<typeof normalize>>;
  waiters: number;
  settled: boolean;
}
const pending = new Map<string, PendingCatalog>();

/** Saved defaults and explicit picker IDs must resolve identically for metadata and generation. */
export function catalogModelId(provider: CliProvider, requested: string, catalog: { defaultModel: string | null }): string {
  return requested === `${provider}/default` ? catalog.defaultModel ?? requested : requested;
}

function normalize(raw: unknown, provider: CliProvider) {
  const data = schema.parse(raw);
  if (data.models.some(m => !m.id.startsWith(`${provider}/`) || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,119}$/.test(m.id.slice(provider.length + 1)))) throw new Error('Invalid subscription model catalog.');
  if (data.defaultModel && !data.models.some(m => m.id === data.defaultModel)) data.defaultModel = null;
  return { ...data, models: data.models.map(m => normalizeModelEfforts({ ...m, short: m.name, author: provider === 'codex' ? 'openai' : 'anthropic', reasoning: m.efforts.length > 0, context: 0, price: null, billing: 'plan' as const })) };
}

/** Never share an account's capabilities or quota with another account/runtime. */
export async function cliCatalog(userId: string, provider: CliProvider, force = false, signal?: AbortSignal) {
  return loadCatalog(userId, provider, force, signal, 30_000);
}

/** Passive UI reads share the existing account/runtime cache and never wait on a full CLI probe. */
export async function cliDisplayCatalog(userId: string, provider: CliProvider) {
  const key = `${userId}:${cliRuntime(userId)}:${provider}`;
  const hit = cache.get(key);
  // The display waiter owns no cancellation signal. A short HTTP read or a
  // remount must not kill the account's cold CLI probe before it can cache data.
  const refresh = cliCatalog(userId, provider);
  if (hit) {
    void refresh.catch(() => {});
    return { ...hit.value, stale: Date.now() - hit.at >= 30_000 || pending.has(key) };
  }
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      refresh.then(value => ({ ...value, stale: false })),
      new Promise<ReturnType<typeof normalize> & { stale: boolean }>(resolve => {
        timer = setTimeout(() => resolve({ ...normalize({ models: [], defaultModel: null, plan: null,
          usage: { available: false, checkedAt: 0, windows: [] } }, provider), stale: true }), 200);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}

/** Generation needs capabilities, not fresh quota. Auth is still checked by every generation. */
export async function cliModelCatalog(userId: string, provider: CliProvider, signal?: AbortSignal) {
  return loadCatalog(userId, provider, false, signal, 5 * 60_000);
}

async function loadCatalog(userId: string, provider: CliProvider, force: boolean, signal: AbortSignal | undefined, maxAgeMs: number) {
  if (signal?.aborted) throw new Error('CLI request cancelled.');
  const runtime = cliRuntime(userId);
  const key = `${userId}:${runtime}:${provider}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  let entry = pending.get(key);
  if (!entry || entry.controller.signal.aborted) {
    const revision = revisions.get(userId);
    const next: PendingCatalog = { controller: new AbortController(), promise: null!, waiters: 0, settled: false };
    next.promise = (async () => {
      const deadline = setTimeout(() => next.controller.abort(), 30_000);
      let raw: unknown;
      try { raw = await cliRequest(userId, 'catalog', { provider }, 30_000, next.controller.signal); }
      finally { clearTimeout(deadline); }
      const value = normalize(raw, provider);
      if (selectedCli(userId) !== provider || cliRuntime(userId) !== runtime || revisions.get(userId) !== revision) throw new Error('The model connection changed. Refresh the model picker.');
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), value });
      return value;
    })().finally(() => {
      next.settled = true;
      if (pending.get(key) === next) pending.delete(key);
    });
    pending.set(key, next);
    entry = next;
  }
  return waitForCatalog(entry, signal);
}

/** Cancelling one bot must not cancel another bot's shared metadata request. */
function waitForCatalog(entry: PendingCatalog, signal?: AbortSignal) {
  entry.waiters++;
  return new Promise<ReturnType<typeof normalize>>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown, value?: ReturnType<typeof normalize>) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      if (--entry.waiters === 0 && !entry.settled) entry.controller.abort();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error('CLI request cancelled.'));
    entry.promise.then(value => finish(undefined, value), error => finish(error));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function clearCliCatalog(userId: string) {
  revisions.set(userId, (revisions.get(userId) ?? 0) + 1);
  for (const key of cache.keys()) if (key.startsWith(`${userId}:`)) cache.delete(key);
  for (const key of pending.keys()) if (key.startsWith(`${userId}:`)) pending.delete(key);
}
