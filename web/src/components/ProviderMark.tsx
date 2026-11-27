import type { ReactNode } from 'react';
import { providerBrand } from '../lib/providerBrand';
import '../styles/provider-marks.css';

/** Official artwork in a reserved slot, including while the catalog loads. */
export function ProviderMark({ provider, fallbackProvider, label }: { provider?: string | null; fallbackProvider?: string | null; label?: string; reserve?: boolean }) {
  const brand = providerBrand(provider) ?? providerBrand(fallbackProvider);
  if (!brand) return <span className="provider-icon" aria-hidden="true" />;
  return <svg className="provider-icon" data-provider={brand} width={16} height={16} viewBox="0 0 24 24"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
    <use href={`/assets/providers/${brand}.svg#mark`} />
  </svg>;
}

/** Text remains the accessible name. Long labels can wrap beside the fixed mark. */
export function ProviderLabel({ provider, children, reserve = true }: { provider?: string | null; children: ReactNode; reserve?: boolean }) {
  return <span className="provider-label"><ProviderMark provider={provider} reserve={reserve} /><span className="provider-label__text">{typeof children === 'string' ? <LabelWords>{children}</LabelWords> : children}</span></span>;
}

/** Keep existing status copy intact while placing each mark beside the name it describes. */
export function ProviderText({ children }: { children: string }) {
  return <>{children.split(/(Claude(?: (?:Max|Pro|Team|Ultra|Enterprise))? plan|Claude Code|ChatGPT plan|Codex|OpenRouter)/g).map((part, index) =>
    index % 2 ? <ProviderLabel key={index} provider={part}>{part}</ProviderLabel> : part)}</>;
}

/** Explicit hyphens in a name are part of the word, not wrap opportunities. */
export function LabelWords({ children }: { children: string }) {
  return <>{children.split(/(\s+)/).map((part, i) => /\s/.test(part) ? part : <span className="label-word" key={i}>{part}</span>)}</>;
}
