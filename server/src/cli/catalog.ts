import { z } from 'zod';
import { cliRequest } from './bridge.js';
import { cliRuntime, selectedCli, type CliProvider } from './store.js';

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const schema = z.object({
  models: z.array(z.object({ id: z.string().max(130), name: z.string().max(160), resolvedModel: z.string().max(120).optional(), efforts: z.array(effort), defaultEffort: effort.nullable(), vision: z.boolean() })).max(1000),
  defaultModel: z.string().nullable(), plan: z.string().max(160).nullable(),
  usage: z.object({ available: z.boolean(), checkedAt: z.number().finite(), windows: z.array(z.object({ label: z.string().max(700), usedPercent: z.number().min(0).max(100), resetsAt: z.number().finite().nullable() })).max(100) }),
});
const revisions = new Map<string, number>();
const cache = new Map<string, { at: number; value: ReturnType<typeof normalize> }>();

/** Saved defaults and explicit picker IDs must resolve identically for metadata and generation. */
export function catalogModelId(provider: CliProvider, requested: string, catalog: { defaultModel: string | null }): string {
  return requested === `${provider}/default` ? catalog.defaultModel ?? requested : requested;
}

function normalize(raw: unknown, provider: CliProvider) {
  const data = schema.parse(raw);
  if (data.models.some(m => !m.id.startsWith(`${provider}/`) || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,119}$/.test(m.id.slice(provider.length + 1)))) throw new Error('Invalid subscription model catalog.');
  if (data.defaultModel && !data.models.some(m => m.id === data.defaultModel)) data.defaultModel = null;
  return { ...data, models: data.models.map(m => ({ ...m, short: m.name, author: provider === 'codex' ? 'openai' : 'anthropic', reasoning: m.efforts.length > 0, context: 0, price: null, billing: 'plan' as const })) };
}

/** Never share an account's capabilities or quota with another account/runtime. */
export async function cliCatalog(userId: string, provider: CliProvider, force = false, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('CLI request cancelled.');
  const key = `${userId}:${cliRuntime(userId)}:${provider}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.value;
  const revision = revisions.get(userId);
  const raw = await cliRequest(userId, 'catalog', { provider }, 23_000, signal);
  const value = normalize(raw, provider);
  if (selectedCli(userId) !== provider || revisions.get(userId) !== revision) throw new Error('The model connection changed. Refresh the model picker.');
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearCliCatalog(userId: string) {
  revisions.set(userId, (revisions.get(userId) ?? 0) + 1);
  for (const key of cache.keys()) if (key.startsWith(`${userId}:`)) cache.delete(key);
}
