import type { ReactNode } from 'react';
import { providerBrand } from '../lib/providerBrand';
import '../styles/provider-marks.css';

/** Local monochrome brand artwork inherits the label's light or dark text color. */
export function ProviderMark({ provider, fallbackProvider, label, reserve = false }: { provider?: string | null; fallbackProvider?: string | null; label?: string; reserve?: boolean }) {
  const brand = providerBrand(provider) ?? providerBrand(fallbackProvider);
  if (!brand) return reserve ? <span className="provider-icon" aria-hidden="true" /> : null;
  return <svg className="provider-icon" data-provider={brand} width={16} height={16} viewBox="0 0 24 24"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
    <use href={`/assets/providers/${brand}.svg#mark`} />
  </svg>;
}

/** Text remains the accessible name. Long labels can wrap beside the fixed mark. */
export function ProviderLabel({ provider, children }: { provider?: string | null; children: ReactNode }) {
  return <span className="provider-label"><ProviderMark provider={provider} /><span>{children}</span></span>;
}

/** Keep existing status copy intact while placing each mark beside the name it describes. */
export function ProviderText({ children }: { children: string }) {
  return <>{children.split(/(Claude(?: (?:Max|Pro|Team|Ultra|Enterprise))? plan|Claude Code|ChatGPT plan|Codex|OpenRouter)/g).map((part, index) =>
    index % 2 ? <ProviderLabel key={index} provider={part}>{part}</ProviderLabel> : part)}</>;
}
