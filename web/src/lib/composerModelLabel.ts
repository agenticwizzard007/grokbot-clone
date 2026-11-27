import { providerBrand } from './providerBrand';

/** The full label is also retained in model memory and the accessible name. */
export function composerModelLabel(label: string, provider: string | null, planMode: boolean): string {
  return planMode && provider === 'codex-cli' ? 'Codex · ChatGPT plan' : label;
}

export type ComposerLabel = { name: string; billing: string; effort: string; compact: boolean };

/** Complete alternatives, in preference order. Never slice a model name to fit. */
export function composerLabelSteps(label: string, provider: string | null, planMode: boolean, _plan: string | null, effort: string, _hasMark: boolean): ComposerLabel[] {
  const full = /^Codex(?:[ ·]|$)/.test(label) || (planMode && provider === 'codex-cli') ? 'Codex' : label;
  const billing = provider ? planMode ? 'Plan' : 'API' : '';
  const shortName = compactModelName(label, provider);
  return [
    { name: full, billing, effort, compact: false },
    { name: shortName, billing: '', effort, compact: true },
  ];
}

export function fittingComposerLabel(steps: ComposerLabel[], available: number, measure: (label: ComposerLabel) => number): ComposerLabel {
  return steps.find(step => measure(step) <= available) ?? steps[steps.length - 1];
}

/** Short complete names keep the model identifiable on phones. */
export function compactModelName(label: string, provider: string | null): string {
  if (provider === 'codex-cli') return 'Codex';
  const family = label.match(/\b(Sonnet|Opus|Haiku|Fable|Codex|Gemini|Grok|DeepSeek|Qwen|Llama|Mistral|Nova|MiniMax)\b/i)?.[0];
  if (family) return family;
  if (/\bKimi\b/i.test(label)) return 'Kimi K2';
  if (/\bGPT\b/i.test(label)) return label.match(/GPT[ -]?[\d.]+/i)?.[0] ?? 'GPT';
  if (providerBrand(label) === 'claude' || provider === 'claude-cli') return 'Claude';
  return /loading/i.test(label) ? 'Loading model' : /unavailable/i.test(label) ? 'Unavailable' : 'Model';
}
