import { planLabel } from './planLabel';
import { providerBrand } from './providerBrand';

/** The full label is also retained in model memory and the accessible name. */
export function composerModelLabel(label: string, provider: string | null, planMode: boolean): string {
  return planMode && provider === 'codex-cli' ? 'Codex · ChatGPT plan' : label;
}

export type ComposerLabel = { name: string; billing: string; effort: string; compact: boolean };

/** Complete alternatives, in preference order. Never slice a model name to fit. */
export function composerLabelSteps(label: string, provider: string | null, planMode: boolean, plan: string | null, effort: string, hasMark: boolean): ComposerLabel[] {
  const full = composerModelLabel(label, provider, planMode);
  const billing = planMode ? provider === 'codex-cli' ? '' : planLabel(provider, plan) : provider ? 'API' : '';
  const shortEffort = ({ Medium: 'Med', Default: 'Auto', Minimal: 'Min' } as Record<string, string>)[effort] ?? effort;
  const brand = providerBrand(label) ?? providerBrand(provider);
  const shortName = /^Codex(?: |$)/.test(label) ? 'Codex' : planMode ? provider === 'codex-cli' ? 'Codex' : 'Claude'
    : ({ claude: 'Claude', openai: 'GPT', xai: 'Grok', gemini: 'Gemini' } as Record<string, string>)[brand ?? ''] ?? 'Model';
  const names = planMode
    ? provider === 'codex-cli' ? [full, 'Codex'] : [planLabel(provider, plan), planLabel(provider, plan).replace(/ plan$/, ''), shortName]
    : [label, shortName];
  return [
    { name: full, billing, effort, compact: false },
    ...names.map(name => ({ name, billing: '', effort: shortEffort, compact: true })),
    // A named mark and effort are the final complete alternative. Unknown endpoints stay neutral.
    { name: hasMark && effort ? '' : shortName, billing: '', effort: shortEffort, compact: true },
  ];
}

export function fittingComposerLabel(steps: ComposerLabel[], available: number, measure: (label: ComposerLabel) => number): ComposerLabel {
  return steps.find(step => measure(step) <= available) ?? steps[steps.length - 1];
}
