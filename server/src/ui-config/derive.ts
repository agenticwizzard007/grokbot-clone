import type { UiConfig } from './schema.js';
export type CssVar = `--${string}`;
export function effectiveTokens(_doc: UiConfig, _mode: 'light' | 'dark'): Record<CssVar, string> { return {}; }
