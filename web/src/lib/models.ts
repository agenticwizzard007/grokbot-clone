import { create } from 'zustand';
import { useStore } from '../store';
import type { Effort } from '@shared/types';

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
  /** Effort levels the model accepts: null = all of them, [] = no effort selection. */
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

export const EFFORT_LABEL: Record<Effort, string> = {
  none: 'No thinking', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultracode: 'Ultracode',
};
export const EFFORT_DESC: Record<Effort, string> = {
  ultracode: 'Max effort, runs 2.5× longer', max: 'Deepest thinking', xhigh: 'For the hardest problems', high: 'Thinks it through',
  medium: 'Balanced', low: 'Fastest replies', minimal: 'Barely stops to think', none: 'Answers straight away',
};

const ORDER: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The levels to offer for a model, strongest first. Ultracode for any model that reasons. */
export function effortsFor(m: PickerModel | undefined): Effort[] {
  if (!m) return [];
  if (!m.reasoning && !m.efforts?.length) return [];
  const accepted = m.efforts === null ? ORDER : ORDER.filter((e) => m.efforts!.includes(e));
  if (!accepted.length) return [];
  return m.billing === 'plan' ? [...accepted].reverse() : ['ultracode', ...[...accepted].reverse()];
}

/** The level the server will actually send (same rule as server/src/lib/llm.ts effortFor). */
export function effectiveEffort(effort: Effort, m: PickerModel | undefined): Effort {
  if (!m || m.efforts === null) return effort;
  if (effort === 'ultracode') return m.billing === 'plan' ? effortsFor(m)[0] ?? 'medium' : effort;
  const supported = m.efforts;
  if (!supported.length || supported.includes(effort)) return effort;
  const at = ORDER.indexOf(effort);
  const best = supported.map((s) => ({ s: s as Effort, i: ORDER.indexOf(s as Effort) })).filter((x) => x.i >= 0)
    .sort((a, b) => Math.abs(a.i - at) - Math.abs(b.i - at) || a.i - b.i)[0];
  return best?.s ?? effort;
}

/** "anthropic/claude-opus-5.5" → "claude-opus-5.5", for models missing from the catalog. */
export const fallbackShort = (id: string) => id.split('/').pop() ?? id;

/** Authors whose icon the server can fetch from OpenRouter; others get a monogram. */
export const ICON_AUTHORS = new Set(['openai', 'google', 'meta', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'moonshotai', 'cohere']);
