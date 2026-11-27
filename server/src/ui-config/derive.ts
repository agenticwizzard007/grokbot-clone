import { DEFAULT_CONFIG, type UiConfig, hexColorSchema } from './schema.js';
import { TOKENS, DEFAULT_SEEDS, DEFAULT_DERIVED, type CssVar, type ColorMode, type SeedId, type TokenId } from './registry-tokens.js';
import { FONTS, SCALES, DENSITIES, RADII } from './registry-fonts.js';
import { CHAT_WIDTHS, SIDEBAR_WIDTHS } from './registry-nav.js';
import { effectiveConfig } from './presets.js';
import { contrastRatio, contrastRules, fromOklch, nearestPassingColor, toOklch } from './contrast.js';
export type { CssVar } from './registry-tokens.js';
export type Palette = Record<TokenId, string>;
/** Calibrated OKLCH ramps keep the shipped palette exact while seeds change hue and lightness. */
export function derive(seeds: Partial<Record<SeedId, string>>, mode: ColorMode, high = false): Palette {
  const base = DEFAULT_SEEDS[mode], values = { ...base, ...seeds }, result: Palette = { ...DEFAULT_DERIVED[mode], ...values };
  for (const token of TOKENS.filter(t => t.kind === 'derived')) {
    const original = DEFAULT_DERIVED[mode][token.id as keyof typeof DEFAULT_DERIVED.light];
    let [L, C, h] = toOklch(original);
    for (const seed of token.dependsOn ?? []) {
      if (values[seed].toUpperCase() === base[seed]) continue;
      const from = toOklch(base[seed]), to = toOklch(values[seed]);
      const weight = token.dependsOn!.length === 1 ? 1 : seed === 'pane' ? 0.85 : 0.15;
      L += (to[0] - from[0]) * weight;
      C = Math.max(0, C + (to[1] - from[1]) * weight);
      if (seed !== 'pane' && seed !== 'ink') h += to[2] - from[2];
    }
    result[token.id] = (token.dependsOn ?? []).every(s => values[s].toUpperCase() === base[s]) ? original : fromOklch([L, C, h]);
  }
  if (contrastRatio(result.onPrimary, result.primary) < 4.5) result.onPrimary = contrastRatio('#000000', result.primary) > contrastRatio('#FFFFFF', result.primary) ? '#000000' : '#FFFFFF';
  // Backgrounds are adjusted before foreground ramps, preserving user seeds exactly.
  for (const id of ['elevated', 'bubbleAgent'] as const) result[id] = nearestPassingColor(result[id], c => contrastRatio(values.ink, c) >= (high ? 7 : 4.5)) ?? result[id];
  const rules = contrastRules(high);
  for (const token of TOKENS.filter(t => t.kind === 'derived')) {
    const pairs = rules.filter(r => r.token === token.id);
    if (pairs.length) result[token.id] = nearestPassingColor(result[token.id], c => pairs.every(r => contrastRatio(c, result[r.against]) >= r.min)) ?? result[token.id];
  }
  return result;
}
export function effectivePalette(doc: UiConfig, mode: ColorMode): Palette {
  const effective = effectiveConfig(doc);
  return { ...derive(effective.theme.colors[mode], mode, effective.theme.contrast === 'high'), ...effective.theme.overrides[mode] };
}
export function effectiveTokens(doc: UiConfig, mode: ColorMode): Record<CssVar, string> {
  const effective = effectiveConfig(doc), result: Record<CssVar, string> = {}, palette = effectivePalette(effective, mode);
  const base = { ...DEFAULT_SEEDS[mode], ...DEFAULT_DERIVED[mode] };
  for (const token of TOKENS) if (palette[token.id] !== base[token.id]) for (const variable of token.cssVars) result[variable] = palette[token.id];
  const theme = effective.theme;
  if (theme.font.ui !== 'inter') result['--font-stack'] = FONTS.find(f => f.id === theme.font.ui)!.stack;
  if (theme.font.heading !== 'instrument') result['--font-heading'] = theme.font.heading === 'same' ? 'var(--font-stack)' : FONTS.find(f => f.id === theme.font.heading)!.stack;
  if (theme.font.scale !== 'default') result['--font-scale'] = String(SCALES[theme.font.scale]);
  if (theme.density !== 'default') { const d = DENSITIES[theme.density]; result['--control-h'] = `${d.control}px`; result['--stack-gap'] = `${d.gap}px`; result['--card-pad'] = `${d.padding}px`; }
  if (theme.radius !== 'default') ['sm', 'md', 'card', 'bubble', 'composer'].forEach((role, i) => { result[`--radius-${role}`] = `${RADII[theme.radius][i]}px`; });
  if (effective.layout.sidebar.width !== DEFAULT_CONFIG.layout.sidebar.width) result['--ui-sidebar-width'] = `${SIDEBAR_WIDTHS[effective.layout.sidebar.width]}px`;
  if (effective.layout.chat.width !== 'default') result['--ui-content-width'] = `${CHAT_WIDTHS[effective.layout.chat.width]}px`;
  return result;
}
export function accentPair(hex: string): { light: string; dark: string } {
  const color = hexColorSchema.parse(hex);
  const shade = (mode: ColorMode) => nearestPassingColor(color, c => contrastRatio(c, DEFAULT_SEEDS[mode].pane) >= 3 && Math.max(contrastRatio(c, '#000000'), contrastRatio(c, '#FFFFFF')) >= 4.5)!;
  return { light: shade('light'), dark: shade('dark') };
}
