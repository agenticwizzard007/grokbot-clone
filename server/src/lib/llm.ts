import OpenAI from 'openai';
import { env } from '../env.js';

/**
 * The model provider for Bots: OpenRouter (any model, one key) or a compatible direct provider. Both speak the
 * Responses API; this module hides the differences (client, model ids, request shape, history).
 */

export type LlmProvider = 'direct' | 'openrouter';
export const NO_LLM_KEY = 'No AI model key yet. Add an OpenRouter or direct provider key in Settings → API keys.';

const clients = new Map<string, { sig: string; client: OpenAI }>();

export const llmProvider = (): LlmProvider => env.llmProvider;

/** A Responses API client for the active provider (rebuilt when keys change in Settings). */
export function llmClient(timeout: number): OpenAI {
  const p = llmProvider();
  const apiKey = p === 'openrouter' ? env.openrouterKey : env.directKey;
  if (!apiKey) throw new Error(NO_LLM_KEY);
  const baseURL = p === 'openrouter' ? env.openrouterBaseUrl : env.directBaseUrl;
  const sig = `${p}|${apiKey}|${baseURL}`;
  const slot = `${p}:${timeout}`;
  let c = clients.get(slot);
  if (!c || c.sig !== sig) {
    c = {
      sig,
      client: new OpenAI({
        apiKey,
        baseURL,
        timeout,
        // OpenRouter app attribution (optional headers).
        defaultHeaders: p === 'openrouter' ? { 'HTTP-Referer': env.appUrl, 'X-Title': 'Swarm' } : undefined,
      }),
    };
    clients.set(slot, c);
  }
  return c.client;
}

export const defaultModel = () => (llmProvider() === 'openrouter' ? env.openrouterModel : env.directModel);

/** A Bot's own model if it suits the active provider (OpenRouter ids look like "vendor/model"), else the default. */
export function modelFor(botModel?: string | null): string {
  if (!botModel) return defaultModel();
  return (llmProvider() === 'openrouter') === botModel.includes('/') ? botModel : defaultModel();
}

/** Server-side tools the provider runs itself. */
export function serverTools(): any[] {
  return llmProvider() === 'openrouter' ? [{ type: 'openrouter:web_search' }] : [{ type: 'web_search' }, { type: 'x_search' }];
}

// ---------- history: items are tagged with the model that produced them ----------

/** Tag for output items, so model-specific items (encrypted reasoning, search calls) only go back to that model. */
export const modelTag = (model: string) => `${llmProvider()}:${model}`;

const PORTABLE = new Set(['message', 'function_call', 'function_call_output']);

/**
 * Input items for a request: drops reasoning/compaction/server-search items made by a different model
 * (another model can't read them, and they would fail the request) and removes our tags.
 * Untagged items predate tagging and came from direct provider.
 */
export function prepareInput(items: any[], model: string): any[] {
  const tag = modelTag(model);
  const legacy = `direct:${env.directModel}`;
  const out: any[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') { out.push(it); continue; }
    const { _m, ...rest } = it;
    const type = rest.type ?? (rest.role ? 'message' : undefined);
    if (type && !PORTABLE.has(type) && (_m ?? legacy) !== tag) continue;
    out.push(rest);
  }
  return out;
}

export const tagOutput = (items: any[], model: string) => items.map((it) => (it && typeof it === 'object' ? { ...it, _m: modelTag(model) } : it));

/** Request fields that differ by provider. */
export function providerFields(opts: { effort: string; reasoning: boolean; cacheKey: string; safetyId: string }): Record<string, unknown> {
  if (llmProvider() === 'direct') {
    return {
      reasoning: { effort: opts.effort },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: opts.cacheKey,
      safety_identifier: opts.safetyId,
    };
  }
  // OpenRouter: stateless (store must be false), reasoning effort minimal|low|medium|high, only for models that reason.
  return opts.reasoning ? { reasoning: { effort: opts.effort === 'xhigh' ? 'high' : opts.effort } } : {};
}

// ---------- OpenRouter model catalog ----------

export interface ModelInfo {
  id: string;
  name: string;
  /** Can see images (needed for screenshots / browser work). */
  vision: boolean;
  reasoning: boolean;
  context: number;
  /** USD per million tokens. */
  price: { input: number; output: number };
}

let catalog: { at: number; models: ModelInfo[] } | null = null;
let catalogPending: Promise<ModelInfo[]> | null = null;
let catalogRetryAt = 0;

/** OpenRouter models that can call tools (the agent needs them). Public endpoint, cached for an hour. */
export async function openrouterModels(): Promise<ModelInfo[]> {
  if (catalog && Date.now() - catalog.at < 3600_000) return catalog.models;
  // Share refreshes across Bots and usage accounting. A stale catalog remains useful
  // during an outage; don't put the same slow request in front of every model step.
  if (Date.now() < catalogRetryAt) {
    if (catalog) return catalog.models;
    throw new Error('OpenRouter model catalog temporarily unavailable');
  }
  if (!catalogPending) {
    catalogPending = fetchModels().catch((e) => {
      catalogRetryAt = Date.now() + 30_000;
      throw e;
    }).finally(() => { catalogPending = null; });
  }
  if (catalog) {
    void catalogPending.catch(() => {});
    return catalog.models;
  }
  return catalogPending;
}

async function fetchModels(): Promise<ModelInfo[]> {
  const r = await fetch(`${env.openrouterBaseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`OpenRouter models: ${r.status}`);
  const data = ((await r.json()) as any).data ?? [];
  const models: ModelInfo[] = data
    .filter((m: any) => (m.supported_parameters ?? []).includes('tools') && !String(m.id).endsWith(':batch'))
    .map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      vision: (m.architecture?.input_modalities ?? []).includes('image'),
      reasoning: (m.supported_parameters ?? []).includes('reasoning'),
      context: m.context_length ?? 0,
      price: { input: Number(m.pricing?.prompt ?? 0) * 1e6, output: Number(m.pricing?.completion ?? 0) * 1e6 },
    }))
    .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
  catalog = { at: Date.now(), models };
  return models;
}

export async function modelInfo(id: string): Promise<ModelInfo | undefined> {
  if (llmProvider() !== 'openrouter') return undefined;
  return (await openrouterModels().catch(() => [] as ModelInfo[])).find((m) => m.id === id);
}
