import type { UiConfig } from './schema.js';
import type { Violation } from './service.js';
import { effectivePalette } from './derive.js';
import { TOKENS, type ColorMode, type TokenId } from './registry-tokens.js';
export type Oklch = [number, number, number];
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
function rgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); }
export function luminance(hex: string): number { const [r, g, b] = rgb(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrastRatio(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export function toOklch(hex: string): Oklch {
  const [r, g, b] = rgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}
export function fromOklch([lightness, chroma, hue]: Oklch): string {
  const L = Math.max(0, Math.min(1, lightness));
  const convert = (c: number) => {
    const a = c * Math.cos(hue), b = c * Math.sin(hue), l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  };
  const inGamut = (values: number[]) => values.every(v => v >= -1e-7 && v <= 1.0000001);
  let values = convert(Math.max(0, chroma));
  if (!inGamut(values)) {
    let lo = 0, hi = chroma;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (inGamut(convert(mid))) lo = mid; else hi = mid; }
    values = convert(lo);
  }
  return '#' + values.map(v => Math.round(Math.min(1, Math.max(0, srgb(v))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function deltaE(a: string, b: string): number {
  const x = toOklch(a), y = toOklch(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] * Math.cos(x[2]) - y[1] * Math.cos(y[2]), x[1] * Math.sin(x[2]) - y[1] * Math.sin(y[2]));
}
/** Search both lightness directions and return the nearest passing in-gamut 8-bit shade. */
export function nearestPassingColor(hex: string, passes: (hex: string) => boolean): string | undefined {
  if (passes(hex)) return hex.toUpperCase();
  const [L, C, h] = toOklch(hex), candidates: { color: string; distance: number }[] = [];
  for (const end of [0, 1]) {
    let last = L;
    for (let step = 1; step <= 100; step++) {
      const trial = L + (end - L) * step / 100, color = fromOklch([trial, C, h]);
      if (passes(color)) {
        let fail = last, pass = trial;
        for (let j = 0; j < 18; j++) { const mid = (fail + pass) / 2; if (passes(fromOklch([mid, C, h]))) pass = mid; else fail = mid; }
        const found = fromOklch([pass, C, h]); candidates.push({ color: found, distance: Math.abs(pass - L) }); break;
      }
      last = trial;
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance)[0]?.color;
}
export interface ContrastRule { token: TokenId; against: TokenId; min: number }
export function contrastRules(high: boolean): ContrastRule[] {
  const rules = TOKENS.flatMap(t => (t.contrast ?? []).map(c => ({ token: t.id, against: c.against, min: high && t.id === 'ink' ? 7 : c.min })));
  rules.push({ token: 'focus', against: 'sidebar', min: 3 });
  if (high) for (const token of ['border', 'borderSubtle', 'borderStrong'] as const) rules.push({ token, against: 'pane', min: 3 });
  return rules;
}
export function checkAccessibility(doc: UiConfig): Violation[] {
  const errors: Violation[] = [];
  for (const mode of ['light', 'dark'] as ColorMode[]) {
    const palette = effectivePalette(doc, mode), rules = contrastRules(doc.theme.contrast === 'high');
    for (const rule of rules) {
      const ratio = contrastRatio(palette[rule.token], palette[rule.against]);
      if (ratio + 1e-9 >= rule.min) continue;
      const def = TOKENS.find(t => t.id === rule.token)!;
      // Unoverridden surfaces are derived again when ink changes, so they must not
      // pin an ink repair to their old contrast-adjusted lightness.
      const related = rules.filter(r => r.token === rule.token && !(rule.token === 'ink' && ['elevated', 'bubbleAgent'].includes(r.against) && !Object.hasOwn(doc.theme.overrides[mode], r.against)));
      const suggested = nearestPassingColor(palette[rule.token], color => related.every(r => contrastRatio(color, palette[r.against]) >= r.min));
      errors.push({ path: `/theme/${def.kind === 'seed' ? 'colors' : 'overrides'}/${mode}/${rule.token}`, code: 'accessibility', message: `${def.label} against ${TOKENS.find(t => t.id === rule.against)!.label.toLowerCase()}: ${ratio.toFixed(2)}:1; needs ${rule.min}:1.`, ratio, minimum: rule.min, ...(suggested ? { suggested, hint: `Try ${suggested}.` } : { hint: 'Choose backgrounds with compatible contrast.' }) });
    }
    if (Math.max(contrastRatio(palette.ink, palette.bubbleUser), contrastRatio(palette.onPrimary, palette.bubbleUser)) < 4.5) {
      const suggested = nearestPassingColor(palette.bubbleUser, c => Math.max(contrastRatio(palette.ink, c), contrastRatio(palette.onPrimary, c)) >= 4.5);
      errors.push({ path: `/theme/colors/${mode}/bubbleUser`, code: 'accessibility', message: 'User bubble text needs 4.5:1 contrast.', minimum: 4.5, suggested });
    }
  }
  return errors;
}
