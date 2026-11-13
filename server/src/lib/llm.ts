import { catalogModelId, cliModelCatalog } from '../cli/catalog.js';
import { isTenant, assertTenant } from '../deployment.js';
import { privateKey } from '../providers/private-keys.js';
import OpenAI from 'openai';
import { env } from '../env.js';
import { currentUserId } from '../usage-context.js';
import { selectedCli } from '../cli/store.js';
import { cliResponsesClient } from '../cli/responses.js';
import { openrouterConnection, personalOpenRouterKey, usesPersonalOpenRouter } from '../providers/openrouter.js';

/**
 * Per-account subscription CLI connections override the server's API provider.
 * The adapter presents the Responses interface to chat and background jobs alike.
 */

export type LlmProvider = 'direct' | 'openrouter' | 'codex-cli' | 'claude-cli';
export const NO_LLM_KEY = 'Connect a subscription in Settings → Subscriptions, or add a model key in Settings → API keys.';

const clients = new Map<string, { sig: string; client: OpenAI }>();

export const llmProvider = (): LlmProvider => {
  const cli = selectedCli(currentUserId());
  return cli ? `${cli}-cli` : usesPersonalOpenRouter(currentUserId()) ? 'openrouter' : env.llmProvider;
};

/** A Responses API client for the active provider. subscriptionTimeoutMs: 0 opts agent work out of a total CLI deadline. */
export function llmClient(timeout: number, options: { subscriptionTimeoutMs?: number } = {}): OpenAI | ReturnType<typeof cliResponsesClient> {
  const userId = currentUserId();
  const cli = selectedCli(userId);
  if (cli && userId) return cliResponsesClient(userId, cli, options.subscriptionTimeoutMs ?? timeout);
  if (isTenant) { if (!userId) throw new Error(NO_LLM_KEY); assertTenant(userId); }
  const p = llmProvider();
  const personal = userId && usesPersonalOpenRouter(userId);
  const apiKey = personal ? personalOpenRouterKey(userId!) : isTenant ? privateKey(userId,'direct') : p === 'openrouter' ? env.openrouterKey : env.directKey;
  if (!apiKey) throw new Error(NO_LLM_KEY);
  const baseURL = p === 'openrouter' ? env.openrouterBaseUrl : env.directBaseUrl;
  const sig = `${p}|${apiKey}|${baseURL}`;
  const slot = `${personal ? userId : 'server'}:${p}:${timeout}`;
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
    // Bound retained clients/credentials in servers with many users.
    if (clients.size >= 200) clients.delete(clients.keys().next().value!);
    clients.set(slot, c);
  }
  return c.client;
}

export const defaultModel = () => {
  const cli = selectedCli(currentUserId());
  const personal = openrouterConnection(currentUserId());
  return cli ? `${cli}/default` : personal?.enabled ? personal.model || env.openrouterModel : llmProvider() === 'openrouter' ? env.openrouterModel : env.directModel;
};

/** A Bot's own model if it suits the active provider (OpenRouter ids look like "vendor/model"), else the default. */
export function modelFor(botModel?: string | null): string {
  const cli = selectedCli(currentUserId());
  if (cli) return botModel?.startsWith(`${cli}/`) ? botModel : defaultModel();
  if (!botModel || /^(codex|claude)\//.test(botModel)) return defaultModel();
  return (llmProvider() === 'openrouter') === botModel.includes('/') ? botModel : defaultModel();
}

/** OpenRouter's fastest-provider routing: the ":nitro" variant (throughput-sorted, priority tiers eligible). */
export function withFast(model: string, fast: boolean): string {
  if (!fast || llmProvider() !== 'openrouter' || model.includes(':')) return model;
  return `${model}:nitro`;
}

/** Server-side tools the provider runs itself. */
export function serverTools(): any[] {
  if (selectedCli(currentUserId())) return [];
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

/** A text turn may follow old screenshots. Preserve their text and disclose omitted images;
 * never drop an image from the current request or a tool result awaiting interpretation. */
export function textOnlyInput(items: any[]): { input: any[]; omitted: number } {
  const lastUser = items.findLastIndex(it => it?.role === 'user');
  let omitted = 0;
  const visit = (value: any, historical: boolean): any => {
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'input_image') {
      if (!historical) throw new Error('The selected model cannot read this request’s image or screenshot. Choose a model with image support.');
      omitted++;
      return { type: 'input_text', text: '[Earlier image omitted because this model accepts text only. Do not infer its contents. Ask the user to select an image-capable model if the image is needed.]' };
    }
    if (Array.isArray(value)) return value.map(v => visit(v, historical));
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, visit(v, historical)]));
  };
  return { input: items.map((item, index) => visit(item, lastUser >= 0 && index < lastUser)), omitted };
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The effort to send for a model: Ultracode asks for the model's top level; anything else snaps to the
 * nearest level the model accepts (ties go lower). `undefined` = don't send an effort.
 */
export function effortFor(effort: string, supported: string[] | null | undefined): string | undefined {
  const want = effort === 'ultracode' ? 'max' : effort;
  if (supported === null) return want; // the model accepts every gateway level
  if (!supported?.length) return undefined; // no effort selection for this model
  if (supported.includes(want)) return want;
  const at = EFFORT_ORDER.indexOf(want as (typeof EFFORT_ORDER)[number]);
  const ranked = supported
    .map((s) => ({ s, i: EFFORT_ORDER.indexOf(s as (typeof EFFORT_ORDER)[number]) }))
    .filter((x) => x.i >= 0 && (effort !== 'ultracode' || x.s !== 'none'))
    .sort((a, b) => (effort === 'ultracode' ? b.i - a.i : Math.abs(a.i - at) - Math.abs(b.i - at) || a.i - b.i));
  return ranked[0]?.s;
}

/** Request fields that differ by provider. */
export function providerFields(opts: { effort: string; reasoning: boolean; efforts?: string[] | null; cacheKey: string; safetyId: string }): Record<string, unknown> {
  if (selectedCli(currentUserId())) {
    const effort = effortFor(opts.effort, opts.efforts);
    return effort ? { reasoning: { effort } } : {};
  }
  if (llmProvider() === 'direct') {
    // A compatible direct provider takes low | medium | high | xhigh.
    const direct = opts.effort === 'none' || opts.effort === 'minimal' ? 'low' : opts.effort === 'max' || opts.effort === 'ultracode' ? 'xhigh' : opts.effort;
    return {
      reasoning: { effort: direct },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: opts.cacheKey,
      safety_identifier: opts.safetyId,
    };
  }
  // OpenRouter: stateless (store must be false); effort only for models that reason, snapped to what the model accepts.
  if (!opts.reasoning) return {};
  const effort = effortFor(opts.effort, opts.efforts === undefined ? ['low', 'medium', 'high'] : opts.efforts);
  return effort ? { reasoning: { effort } } : {};
}

// ---------- OpenRouter model catalog ----------

export interface ModelInfo {
  id: string;
  name: string;
  /** The model's maker, from the id ("anthropic" in "anthropic/claude-opus-5.5"). */
  author: string;
  /** Effort levels the model accepts: null = all of them, [] = no effort selection. */
  efforts: string[] | null;
  defaultEffort: string | null;
  /** Can see images (needed for screenshots / browser work). */
  vision: boolean;
  reasoning: boolean;
  context: number;
  /** USD per million tokens. */
  price: { input: number; output: number } | null;
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
      author: String(m.id).split('/')[0].replace(/^~/, ''),
      efforts: m.reasoning ? (m.reasoning.supported_efforts === null ? null : Array.isArray(m.reasoning.supported_efforts) ? m.reasoning.supported_efforts.map(String) : []) : [],
      defaultEffort: m.reasoning?.default_effort ? String(m.reasoning.default_effort) : null,
      vision: (m.architecture?.input_modalities ?? []).includes('image'),
      reasoning: (m.supported_parameters ?? []).includes('reasoning'),
      context: m.context_length ?? 0,
      price: { input: Number(m.pricing?.prompt ?? 0) * 1e6, output: Number(m.pricing?.completion ?? 0) * 1e6 },
    }))
    .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
  catalog = { at: Date.now(), models };
  return models;
}

export async function modelInfo(id: string, explicit = false, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  const userId = currentUserId(), cli = selectedCli(userId);
  if (cli && userId) {
    if (id === `${cli}/default` && !explicit) return undefined;
    const catalog = await cliModelCatalog(userId, cli, signal);
    const effective = catalogModelId(cli, id, catalog);
    return catalog.models.find(m => m.id === effective);
  }
  if (llmProvider() !== 'openrouter') return undefined;
  const base = id.replace(/:nitro$/, '');
  return (await openrouterModels().catch(() => [] as ModelInfo[])).find((m) => m.id === base);
}
