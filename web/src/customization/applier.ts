import { effectiveTokens } from '../../../server/src/ui-config/derive';
import { TOKENS } from '../../../server/src/ui-config/registry-tokens';
import { FONTS, SCALES, DENSITIES, RADII } from '../../../server/src/ui-config/registry-fonts';
import { SIDEBAR_WIDTHS, CHAT_WIDTHS } from '../../../server/src/ui-config/registry-nav';
import type { UiConfig } from '../../../server/src/ui-config/schema';
import { ensureFonts } from './fonts';

const colors = new Set(TOKENS.flatMap(token => token.cssVars));
/** Non-color properties are fixed mappings from the shared enum registries. */
export const TOKEN_VALUES = new Map<string, readonly string[]>([
  ['--font-stack', FONTS.map(font => font.stack)],
  ['--font-heading', ['var(--font-stack)', ...FONTS.map(font => font.stack)]],
  ['--font-scale', Object.values(SCALES).map(String)],
  ['--control-h', Object.values(DENSITIES).map(density => `${density.control}px`)],
  ['--stack-gap', Object.values(DENSITIES).map(density => `${density.gap}px`)],
  ['--card-pad', Object.values(DENSITIES).map(density => `${density.padding}px`)],
  ...['sm', 'md', 'card', 'bubble', 'composer'].map((role, index): [string, string[]] => [`--radius-${role}`, Object.values(RADII).map(radii => `${radii[index]}px`)]),
  ['--ui-sidebar-width', Object.values(SIDEBAR_WIDTHS).map(width => `${width}px`)],
  ['--ui-content-width', Object.values(CHAT_WIDTHS).map(width => `${width}px`)],
]);
export const TOKEN_NAMES = [...colors, ...TOKEN_VALUES.keys()];
export function safeToken(name: string, value: unknown): value is string {
  return typeof value === 'string' && (colors.has(name as `--${string}`) ? /^#[0-9a-f]{6}$/i.test(value) : !!TOKEN_VALUES.get(name)?.includes(value));
}
export function resolvedMode(mode: UiConfig['theme']['mode']) {
  return mode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : mode;
}
/** Derivation happens once per config/media change; DOM writes are a single batch. */
export function applyAppearance(doc: UiConfig, fallbackMode?: UiConfig['theme']['mode']) {
  const root = document.documentElement, mode = resolvedMode(fallbackMode ?? doc.theme.mode);
  const tokens = effectiveTokens(doc, mode), forced = matchMedia('(forced-colors: active)').matches;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name as `--${string}`];
    if (safeToken(name, value) && !(forced && colors.has(name as `--${string}`))) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  root.dataset.density = doc.theme.density;
  root.dataset.contrast = doc.theme.contrast;
  root.dataset.motion = doc.theme.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'system';
  ensureFonts(doc.theme.font);
}
