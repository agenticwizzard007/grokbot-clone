import type { Effort } from '../types.js';

/** Pure capability policy shared by the catalog, request path and browser picker. */
export interface ModelEffortMetadata {
  id: string;
  author: string;
  resolvedModel?: string;
  billing?: 'api' | 'plan';
  efforts: string[] | null;
  defaultEffort: string | null;
  reasoning: boolean;
}

type RealEffort = Exclude<Effort, 'ultracode'>;
export const EFFORT_ORDER: RealEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
interface EffortProfile { levels: RealEffort[]; defaultEffort: RealEffort | null }
const profile = (levels: RealEffort[], defaultEffort: RealEffort | null): EffortProfile => ({ levels, defaultEffort });

// Verified against the model pages linked in docs/qa/R3-EFFORT-PICKER.md.
// These are fallbacks for missing metadata and limits for known API models, not
// capabilities inferred for other versions. Catalog defaults always take precedence.
// GPT-6.2 Astra and other unlisted variants use catalog efforts/defaultEffort.
// Its model page rejects none; the latest-model guide recommends medium but
// does not declare the omitted-parameter default or a complete supported list.
const OPENAI_EFFORTS: Record<string, EffortProfile> = {
  'gpt-5': profile(['minimal', 'low', 'medium', 'high'], 'medium'),
  'gpt-5-mini': profile(['minimal', 'low', 'medium', 'high'], 'medium'),
  'gpt-5-nano': profile(['minimal', 'low', 'medium', 'high'], 'medium'),
  'gpt-5.1': profile(['none', 'low', 'medium', 'high'], 'none'),
  'gpt-5.2': profile(['none', 'low', 'medium', 'high', 'xhigh'], 'none'),
  // The Codex model pages do not state a default. Medium is the documented app fallback.
  'gpt-5.2-codex': profile(['low', 'medium', 'high', 'xhigh'], 'medium'),
  'gpt-5.3-codex': profile(['low', 'medium', 'high', 'xhigh'], 'medium'),
  'gpt-5.4': profile(['none', 'low', 'medium', 'high', 'xhigh'], 'none'),
  'gpt-5.5': profile(['none', 'low', 'medium', 'high', 'xhigh'], 'medium'),
};
// https://platform.claude.com/docs/en/build-with-claude/effort
const CLAUDE_EFFORTS: Record<string, EffortProfile> = {
  'claude-opus-5-5': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
  'claude-sonnet-5-5': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'high'),
  'claude-haiku-5-5': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
  'claude-opus-5': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'high'),
  'claude-opus-4-8': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'high'),
  'claude-opus-4-7': profile(['low', 'medium', 'high', 'xhigh', 'max'], 'high'),
  'claude-opus-4-6': profile(['low', 'medium', 'high', 'max'], 'high'),
};
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
const GEMINI_EFFORTS: Record<string, EffortProfile> = {
  'gemini-4-argon': profile(['low', 'medium', 'high'], 'medium'),
  'gemini-4-carbon': profile(['low', 'medium', 'high'], 'medium'),
  'gemini-4-argon-cyber-permissive': profile(['low', 'medium', 'high'], 'high'),
  'gemini-4-carbon-cyber-permissive': profile(['low', 'medium', 'high'], 'high'),
  'gemini-4-hydrogen': profile(['low', 'medium', 'high', 'xhigh'], 'high'),
  'gemini-3.5-flash': profile(['minimal', 'low', 'medium', 'high'], 'medium'),
  'gemini-3.6-flash': profile(['minimal', 'low', 'medium', 'high'], 'medium'),
  'gemini-3.5-flash-lite': profile(['minimal', 'low', 'medium', 'high'], 'minimal'),
};
// https://docs.x.ai/developers/model-capabilities/text/reasoning
const GROK_EFFORTS: Record<string, EffortProfile> = {
  'grok-4.7': profile(['low', 'medium', 'high', 'xhigh'], 'high'),
  'grok-4.6': profile(['low', 'medium', 'high', 'xhigh'], 'high'),
  'grok-4.5': profile(['low', 'medium', 'high'], 'high'),
  // The 4.3 model page lists xhigh, but the reasoning guide says 4.6 and later.
  // Fall back to their common set; never add xhigh to the catalog's four levels.
  'grok-4.3': profile(['none', 'low', 'medium', 'high'], 'low'),
};

function modelEffortId(m: ModelEffortMetadata): string {
  return (m.resolvedModel ?? m.id.split('/').pop() ?? m.id).split(':')[0].replace(/-1m$/, '');
}

function claudeEffortId(id: string): string {
  return (id.startsWith('claude-') ? id : `claude-${id}`).replaceAll('.', '-');
}

// CLI defaults are a separate fallback: they can differ from the API defaults.
// https://code.claude.com/docs/en/model-config#adjust-effort-level
const CLAUDE_CODE_DEFAULTS: Record<string, RealEffort> = {
  'claude-opus-5-5': 'medium', 'claude-sonnet-5-5': 'medium', 'claude-haiku-5-5': 'medium',
  'claude-opus-5': 'high', 'claude-opus-4-8': 'high', 'claude-opus-4-7': 'xhigh', 'claude-opus-4-6': 'high',
  'claude-sonnet-5': 'high', 'claude-sonnet-4-6': 'high',
};

function effortProfile(m: ModelEffortMetadata): EffortProfile | undefined {
  const id = modelEffortId(m);
  if (m.author === 'openai') return OPENAI_EFFORTS[id];
  if (m.author === 'anthropic') return CLAUDE_EFFORTS[claudeEffortId(id)];
  if (m.author === 'google') return GEMINI_EFFORTS[id];
  if (m.author === 'x-ai') return GROK_EFFORTS[id];
}

/** Catalog support restricts documented models; unknown variants stay catalog driven. */
export function supportedModelEfforts(m: ModelEffortMetadata): string[] {
  if (!m.reasoning && !m.efforts?.length) return [];
  const documented = effortProfile(m);
  // Fallback for unknown families, custom direct providers and unverified variants:
  // use catalog levels only. No metadata (including Gemini 2.5) invents no picker.
  const accepted = m.efforts ?? documented?.levels ?? [];
  return accepted.filter(e => !documented || documented.levels.includes(e as RealEffort));
}

export function modelDefaultEffort(m: ModelEffortMetadata): Effort | null {
  // Account metadata wins. Unverified CLI defaults stay unknown, even when the
  // corresponding API model has a documented default.
  const fallback = m.billing === 'plan'
    ? m.author === 'anthropic' ? CLAUDE_CODE_DEFAULTS[claudeEffortId(modelEffortId(m))] : null
    : effortProfile(m)?.defaultEffort;
  const value = m.defaultEffort ?? fallback;
  return value && supportedModelEfforts(m).includes(value) ? value as Effort : null;
}

export function normalizeModelEfforts<T extends ModelEffortMetadata>(m: T): T {
  return { ...m, efforts: supportedModelEfforts(m), defaultEffort: m.defaultEffort ?? modelDefaultEffort(m) };
}
