import { EFFORT_ORDER, supportedModelEfforts, modelDefaultEffort } from '../../../server/src/lib/model-efforts';
import { create } from 'zustand';
import { useStore } from '../store';
import type { Bot, Effort } from '@shared/types';

/** The composer's model picker: the provider's models, the user's favourites, effort levels. */

export interface PlanUsage { available: boolean; checkedAt: number; windows: { label: string; usedPercent: number; resetsAt: number | null }[] }
export type ModelProvider = 'openrouter' | 'direct' | 'codex-cli' | 'claude-cli';

export interface PickerModel {
  billing?: 'api' | 'plan';
  resolvedModel?: string;
  id: string;
  name: string;
  /** Short display name: "Opus 5.5", "GPT-5.5". */
  short: string;
  author: string;
  /** Effort levels the model accepts: null = use a verified fallback, [] = no effort selection. */
  efforts: string[] | null;
  defaultEffort: string | null;
  reasoning: boolean;
  vision: boolean;
  context: number;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, credentials: 'include', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

interface ModelsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  provider: ModelProvider | null;
  billing: 'api' | 'plan' | null;
  defaultModel: string | null;
  plan: string | null;
  usage: PlanUsage | null;
  canFast: boolean;
  models: PickerModel[];
  byId: Map<string, PickerModel>;
  favourites: string[];
  error: string | null;
  load(force?: boolean): Promise<void>;
  setFavourites(ids: string[]): Promise<void>;
}

let loadVersion = 0;
export const useModels = create<ModelsState>((set, get) => ({
  status: 'idle', provider: null, billing: null, defaultModel: null, plan: null, usage: null, canFast: false, models: [], byId: new Map(), favourites: [], error: null,
  async load(force) {
    if (!force && (get().status === 'loading' || get().status === 'ready')) return;
    const version = ++loadVersion;
    set({ status: 'loading', ...(force ? { provider: null, billing: null, canFast: false, models: [], byId: new Map(), usage: null, plan: null, defaultModel: null } : {}) });
    try {
      const r = await req<{ provider: ModelProvider; billing: 'api' | 'plan'; defaultModel?: string | null; plan?: string | null; usage?: PlanUsage; canFast: boolean; models: PickerModel[]; favourites: string[]; error?: string }>('GET', '/models');
      if (version !== loadVersion) return;
      set({ status: 'ready', provider: r.provider, billing: r.billing, defaultModel: r.defaultModel ?? null, plan: r.plan ?? null, usage: r.usage ?? null, canFast: r.canFast, models: r.models, byId: new Map(r.models.map((m) => [m.id, m])), favourites: r.favourites, error: r.error ?? null });
    } catch (e) {
      if (version !== loadVersion) return;
      set({ status: 'error', models: [], byId: new Map(), usage: null, plan: null, error: (e as Error).message });
    }
  },
  async setFavourites(ids) {
    const version = loadVersion;
    const prev = get().favourites;
    set({ favourites: ids });
    try { await req('PUT', '/models/favourites', { ids }); } catch { if (version === loadVersion) set({ favourites: prev }); }
  },
}));

// A sign-out/reauthentication within the same page must not retain another account’s plan data.
useStore.subscribe((state, previous) => {
  if (state.user?.id === previous.user?.id) return;
  loadVersion++;
  useModels.setState({ status: 'idle', provider: null, billing: null, defaultModel: null, plan: null, usage: null, canFast: false, models: [], byId: new Map(), favourites: [], error: null });
});

const ORDER = EFFORT_ORDER;
/** Real levels only, strongest first. A saved ultracode value is an alias, not an extra level. */
export function effortsFor(m: PickerModel | undefined): Effort[] {
  if (!m) return [];
  const accepted = supportedModelEfforts(m);
  const order: Effort[] = [...ORDER, 'ultracode'];
  return order.filter(e => accepted.includes(e)).reverse();
}

/** Closest supported level, with ties going lower, matching server effortFor. */
export function effectiveEffort(effort: Effort, m: PickerModel | undefined): Effort {
  const supported = effortsFor(m);
  if (!supported.length) return effort;
  if (effort === 'ultracode') return supported[0];
  if (supported.includes(effort)) return effort;
  const at = ORDER.indexOf(effort);
  return [...supported].sort((a, b) => {
    const ai = ORDER.indexOf(a as Exclude<Effort, 'ultracode'>), bi = ORDER.indexOf(b as Exclude<Effort, 'ultracode'>);
    return Math.abs(ai - at) - Math.abs(bi - at) || ai - bi;
  })[0];
}

/** The provider's default, not the Bot's previously saved preference. */
export function defaultEffortFor(m: PickerModel | undefined): Effort | null {
  const levels = effortsFor(m);
  if (!m || !levels.length) return null;
  return modelDefaultEffort(m);
}

export function isTopEffort(effort: Effort | null, m: PickerModel | undefined): boolean {
  const top = effortsFor(m)[0];
  return !!effort && !!top && effectiveEffort(effort, m) === top;
}

export function effortLabel(effort: Effort, m: PickerModel | undefined): string {
  const value = effectiveEffort(effort, m);
  if (value === 'ultracode' && !m?.efforts?.includes('ultracode')) return 'Default';
  // Provider ids are the names: None, Minimal, Low, Medium, High, Xhigh, Max.
  // Fallback for other catalog authors uses the same readable spelling of their ids.
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function effortDescription(effort: Effort, m: PickerModel | undefined): string {
  if (m?.author === 'custom') return 'Compatible direct-provider effort';
  if (isTopEffort(effort, m)) return 'Highest effort for this model';
  const value = effectiveEffort(effort, m);
  return value === 'none' ? 'Reasoning disabled' : `${effortLabel(value, m)} reasoning effort`;
}

/** Resolve defaults like the server. An explicit model removed from the catalog stays unavailable. */
export function modelSelection(bot: Pick<Bot, 'model' | 'effort'>, catalog: Pick<ModelsState, 'provider' | 'billing' | 'defaultModel' | 'byId'>) {
  const cli = catalog.provider === 'codex-cli' ? 'codex' : catalog.provider === 'claude-cli' ? 'claude' : null;
  const implicitPlanDefault = !!cli && !bot.model?.startsWith(`${cli}/`);
  let id = bot.model;
  if (cli) {
    if (implicitPlanDefault || id === `${cli}/default`) id = catalog.defaultModel;
  } else if (!id || /^(claude|codex)\//.test(id) || (catalog.provider === 'openrouter') !== id.includes('/')) {
    id = catalog.defaultModel;
  }
  const current = id ? catalog.byId.get(id) : undefined;
  const supported = effortsFor(current);
  // An implicit CLI default runs with the CLI's default effort until the user picks one.
  const effort = !current || !supported.length ? null : implicitPlanDefault
    ? defaultEffortFor(current)
    : effectiveEffort(bot.effort, current);
  return { current, effort };
}

/** "anthropic/claude-opus-5.5" → "claude-opus-5.5", for models missing from the catalog. */
export const fallbackShort = (id: string) => id.split('/').pop() ?? id;

/** Authors whose icon the server can fetch from OpenRouter; others get a monogram. */
export const ICON_AUTHORS = new Set(['openai', 'google', 'meta', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'moonshotai', 'cohere']);
