import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG, DEFAULT_SEEDS, TOKENS, REGISTRY, derive, effectivePalette, effectiveTokens, checkAccessibility, contrastRatio, toOklch, fromOklch, deltaE, accentPair, presetConfig, previewPatch, type UiConfig } from '../../../server/src/ui-config/index.ts';
const pairs: [string, string, number][] = [
  ['#000000', '#FFFFFF', 21], ['#FFFFFF', '#000000', 21], ['#000000', '#000000', 1], ['#FFFFFF', '#FFFFFF', 1],
  ['#FF0000', '#FFFFFF', 3.99847677], ['#00FF00', '#FFFFFF', 1.37219028], ['#0000FF', '#FFFFFF', 8.59247136], ['#FFFF00', '#FFFFFF', 1.07383923], ['#00FFFF', '#FFFFFF', 1.25388106], ['#FF00FF', '#FFFFFF', 3.13620072],
  ['#FF0000', '#000000', 5.252], ['#00FF00', '#000000', 15.304], ['#0000FF', '#000000', 2.444], ['#777777', '#FFFFFF', 4.47808945], ['#777777', '#000000', 4.68949989], ['#767676', '#FFFFFF', 4.54222496], ['#808080', '#FFFFFF', 3.94943965], ['#123456', '#FFFFFF', 12.71730408], ['#3043AB', '#FFFFFF', 8.34461695], ['#0F766E', '#FFFFFF', 5.47325008], ['#FFFFFF', '#1D2A3B', 14.51698586], ['#B5C1FF', '#1D2A3B', 8.32081629],
];
test('WCAG contrast matches 22 independently calculated reference pairs', () => {
  for (const [a, b, expected] of pairs) assert.ok(Math.abs(contrastRatio(a, b) - expected) < 1e-7, `${a} ${b}`);
});
test('all eight built-in presets pass all contrast pairs in both modes', () => {
  for (const preset of REGISTRY.presets) assert.deepEqual(checkAccessibility(presetConfig(preset.id)), [], preset.id);
});
test('default users get zero CSS variables and default seeds round trip exactly', () => {
  for (const mode of ['light', 'dark'] as const) {
    assert.deepEqual(effectiveTokens(DEFAULT_CONFIG, mode), {});
    const palette = derive(DEFAULT_SEEDS[mode], mode);
    for (const [id, value] of Object.entries(DEFAULT_SEEDS[mode])) assert.equal(palette[id as keyof typeof palette], value);
    assert.deepEqual(checkAccessibility(DEFAULT_CONFIG), []);
  }
});
test('derived default colors stay within delta E 8 of actual shipped CSS tokens', () => {
  const css = fs.readFileSync('web/src/styles/tokens.css', 'utf8');
  const [light, dark] = css.split(":root[data-theme='dark']");
  const parse = (text: string) => {
    const raw = Object.fromEntries([...text.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map(([, key, value]) => [key, value]));
    const pane = raw['--color-bg-pane'] ?? '#FFFFFF';
    return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
      if (/^#[a-f0-9]{6}$/i.test(value)) return [[key, value.toUpperCase()]];
      if (!/^rgb\(/.test(value)) return [];
      const channels = value.match(/[\d.]+/g)!.map(Number), alpha = channels.length === 4 ? channels[3] / (value.includes('%') ? 100 : 1) : 1;
      const hex = '#' + channels.slice(0, 3).map((n, i) => Math.round(n * alpha + parseInt(pane.slice(1 + 2 * i, 3 + 2 * i), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('').toUpperCase();
      return [[key, hex]];
    }));
  };
  let checks = 0;
  for (const mode of ['light', 'dark'] as const) {
    const shipped = { ...parse(light), ...(mode === 'dark' ? parse(dark) : {}) }, palette = derive(DEFAULT_SEEDS[mode], mode);
    for (const token of TOKENS) for (const variable of token.cssVars) { assert.ok(shipped[variable], `Missing baseline for ${variable}`); assert.ok(deltaE(palette[token.id], shipped[variable]) <= 8, `${mode} ${variable}`); checks++; }
  }
  assert.ok(checks >= 50); console.log(`CSS palette: ${checks} actual token comparisons, all delta E <= 8`);
});
test('OKLCH round trips saturated neutral and near-black colors', () => {
  for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#000000', '#FFFFFF', '#123456', '#010101', '#FF00FF', '#0F766E']) assert.equal(fromOklch(toOklch(hex)), hex);
});
test('500-color accent sweep preserves a passing shade and passes both modes', () => {
  let seed = 0xabc123;
  for (let i = 0; i < 500; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const color = '#' + (seed & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase(), pair = accentPair(color);
    const doc = structuredClone(DEFAULT_CONFIG); doc.theme.colors.light.primary = pair.light; doc.theme.colors.dark.primary = pair.dark;
    assert.deepEqual(checkAccessibility(doc), [], `${color}: ${JSON.stringify(pair)}`);
    for (const mode of ['light', 'dark'] as const) {
      if (contrastRatio(color, DEFAULT_SEEDS[mode].pane) >= 3) assert.equal(pair[mode], color);
      const original = toOklch(color), result = toOklch(pair[mode]);
      if (original[1] > .04 && result[1] > .04) assert.ok(Math.abs(Math.atan2(Math.sin(original[2] - result[2]), Math.cos(original[2] - result[2]))) < .1);
    }
  }
  console.log('Accent sweep: 500 colors, 1000 mode palettes, 0 violations');
});
test('low contrast is blocked with a ratio minimum hint and suggested shade', () => {
  const result = previewPatch(DEFAULT_CONFIG, [{ op: 'add', path: '/theme/colors/light/primary', value: '#FFFFFF' }], { ctx: {} });
  assert.equal(result.ok, false); if (result.ok) return;
  assert.equal(result.errors[0].code, 'accessibility'); assert.equal(result.errors[0].ratio, 1); assert.equal(result.errors[0].minimum, 3); assert.match(result.errors[0].suggested!, /^#[0-9A-F]{6}$/); assert.ok(result.errors[0].hint);
});
test('autofix is a minimal lightness change passes and reports each adjustment', () => {
  for (const hex of ['#FFFFFF', '#EEEEEE', '#A5F3FC', '#FDE68A']) {
    const result = previewPatch(DEFAULT_CONFIG, [{ op: 'add', path: '/theme/colors/light/primary', value: hex }], { ctx: {}, autofix: true });
    assert.equal(result.ok, true); if (!result.ok) continue;
    assert.deepEqual(checkAccessibility(result.result), []); assert.ok(result.warnings.length); assert.ok(result.summary.some(s => s.startsWith('Adjusted color')));
    const fixed = result.result.theme.colors.light.primary!, [L, C, h] = toOklch(hex), distance = Math.abs(toOklch(fixed)[0] - L);
    for (let delta = 0; delta < Math.max(0, distance - .002); delta += .001) {
      assert.ok(contrastRatio(fromOklch([L - delta, C, h]), '#FFFFFF') < 3);
      assert.ok(contrastRatio(fromOklch([L + delta, C, h]), '#FFFFFF') < 3);
    }
  }
});
test('advanced overrides cannot bypass text focus status or high-contrast guardrails', () => {
  const cases: [string, string][] = [['ink', '#FFFFFF'], ['text2', '#FFFFFF'], ['text3', '#FFFFFF'], ['onPrimary', '#3043AB'], ['focus', '#FFFFFF'], ['successText', '#ECF4EE'], ['warnText', '#FCF0DA'], ['dangerText', '#FCEDEE']];
  for (const [id, hex] of cases) {
    const doc: UiConfig = structuredClone(DEFAULT_CONFIG);
    (id === 'ink' ? doc.theme.colors.light : doc.theme.overrides.light as Record<string, string>)[id] = hex;
    assert.ok(checkAccessibility(doc).length, id);
  }
  const doc = presetConfig('contrast'); doc.theme.overrides.light.border = '#FFFFFF'; assert.ok(checkAccessibility(doc).some(e => e.path.endsWith('/border')));
});
test('color derivation keeps custom seeds exact while computed text meets floors', () => {
  const doc = structuredClone(DEFAULT_CONFIG); doc.theme.colors.light = { pane: '#FFF7ED', primary: '#0F766E', ink: '#111827' };
  assert.deepEqual(checkAccessibility(doc), []);
  const palette = effectivePalette(doc, 'light'); for (const [id, value] of Object.entries(doc.theme.colors.light)) assert.equal(palette[id as keyof typeof palette], value);
  assert.notEqual(palette.focus, '#3043AB'); assert.notEqual(palette.active, '#EDEFFA');
});
test('100-operation validation stays inside the 20 ms p95 budget', () => {
  const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'replace' as const, path: '/theme/mode', value: i % 2 ? 'dark' : 'light' }));
  const timings = [];
  for (let i = 0; i < 60; i++) { const start = performance.now(); assert.ok(previewPatch(DEFAULT_CONFIG, ops, { ctx: {} }).ok); if (i >= 10) timings.push(performance.now() - start); }
  timings.sort((a, b) => a - b); const p95 = timings[Math.floor(timings.length * .95)]; console.log(`Patch performance: 100 operations p95 ${p95.toFixed(2)} ms`); assert.ok(p95 < 20);
});
test('autofix can repair ink after backgrounds cross from light to dark', () => {
  const result = previewPatch(DEFAULT_CONFIG, [
    { op: 'add', path: '/theme/colors/light/pane', value: '#000000' },
    { op: 'add', path: '/theme/colors/light/sidebar', value: '#000000' },
  ], { ctx: {}, autofix: true });
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
  assert.deepEqual(checkAccessibility(result.result), []);
  assert.equal(result.result.theme.colors.light.pane, '#000000');
  assert.equal(result.result.theme.colors.light.sidebar, '#000000');
});
