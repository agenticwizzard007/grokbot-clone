export type ColorMode = 'light' | 'dark';
export type CssVar = `--${string}`;
export const SEED_IDS = ['primary', 'pane', 'sidebar', 'ink', 'success', 'warn', 'danger', 'bubbleUser'] as const;
export type SeedId = typeof SEED_IDS[number];
export const DERIVED_IDS = ['text2', 'text3', 'iconSecondary', 'border', 'borderSubtle', 'borderStrong', 'hover', 'active', 'subtle', 'elevated', 'elevatedHover', 'primaryHover', 'focus', 'onPrimary', 'bubbleAgent', 'successBg', 'successText', 'warnBg', 'warnText', 'dangerBg', 'dangerText', 'dangerHover'] as const;
export type DerivedId = typeof DERIVED_IDS[number];
export type TokenId = SeedId | DerivedId;
export interface TokenDef { id: TokenId; label: string; kind: 'seed' | 'derived'; cssVars: CssVar[]; type: 'color'; dependsOn?: SeedId[]; contrast?: { against: TokenId; min: number; role: 'text' | 'ui' | 'large' }[] }
export const DEFAULT_SEEDS: Record<ColorMode, Record<SeedId, string>> = {
  light: { primary: '#3043AB', pane: '#FFFFFF', sidebar: '#FBFAF7', ink: '#18202A', success: '#27804F', warn: '#DA830E', danger: '#E72E3B', bubbleUser: '#EDEFFA' },
  dark: { primary: '#B5C1FF', pane: '#1D2A3B', sidebar: '#17222F', ink: '#FFFFFF', success: '#3CC384', warn: '#C8770C', danger: '#F05A64', bubbleUser: '#3043AB' },
};
export const DEFAULT_DERIVED: Record<ColorMode, Record<DerivedId, string>> = {
  light: { text2: '#525B5E', text3: '#697176', iconSecondary: '#525B5E', border: '#DCDEE0', borderSubtle: '#EBECEE', borderStrong: '#C8C9CC', hover: '#EEF0F2', active: '#EDEFFA', subtle: '#F5F6F7', elevated: '#FFFFFF', elevatedHover: '#F4F5FB', primaryHover: '#29398C', focus: '#3043AB', onPrimary: '#FFFFFF', bubbleAgent: '#FBFAF7', successBg: '#ECF4EE', successText: '#216342', warnBg: '#FCF0DA', warnText: '#9A5B08', dangerBg: '#FCEDEE', dangerText: '#A1353D', dangerHover: '#C82532' },
  dark: { text2: '#C4CBD5', text3: '#AFB9C6', iconSecondary: '#C4CBD5', border: '#3A4859', borderSubtle: '#2B394B', borderStrong: '#56606D', hover: '#283A50', active: '#30415E', subtle: '#223144', elevated: '#253348', elevatedHover: '#2B3B51', primaryHover: '#C2CBFA', focus: '#B5C1FF', onPrimary: '#17222F', bubbleAgent: '#243347', successBg: '#173A2E', successText: '#9AD3B4', warnBg: '#3A3020', warnText: '#F0B45A', dangerBg: '#3D2229', dangerText: '#FF9AA1', dangerHover: '#F73643' },
};
const seeds: [SeedId, string, CssVar[]][] = [
  ['primary', 'Primary color', ['--color-primary']], ['pane', 'Pane color', ['--color-bg-pane']], ['sidebar', 'Sidebar color', ['--color-bg-sidebar']], ['ink', 'Text color', ['--color-text-primary', '--color-ink']],
  ['success', 'Success color', ['--color-success']], ['warn', 'Warning color', ['--color-warn']], ['danger', 'Danger color', ['--color-danger']], ['bubbleUser', 'User bubble', ['--color-bubble-user']],
];
const derived: [DerivedId, string, CssVar[], SeedId[]][] = [
  ['text2', 'Secondary text', ['--color-text-secondary'], ['ink', 'pane']], ['text3', 'Tertiary text', ['--color-text-tertiary'], ['ink', 'pane']], ['iconSecondary', 'Secondary icons', ['--color-icon-secondary'], ['ink', 'pane']],
  ['border', 'Border', ['--color-border-secondary'], ['pane']], ['borderSubtle', 'Subtle border', ['--color-border-tertiary'], ['pane']], ['borderStrong', 'Strong border', ['--color-border-primary'], ['pane']],
  ['hover', 'Hover background', ['--color-bg-hover'], ['pane']], ['active', 'Active background', ['--color-bg-active', '--color-bg-active-solid'], ['primary', 'pane']], ['subtle', 'Subtle background', ['--color-bg-subtle', '--color-bg-tertiary'], ['pane']],
  ['elevated', 'Elevated background', ['--color-bg-elevated'], ['pane']], ['elevatedHover', 'Elevated hover', ['--color-bg-elevated-hover'], ['pane']], ['primaryHover', 'Primary hover', ['--color-bg-primary-hover'], ['primary']],
  ['focus', 'Focus ring', ['--color-border-focus'], ['primary']], ['onPrimary', 'Text on primary', ['--color-on-primary'], ['primary']], ['bubbleAgent', 'Agent bubble', ['--color-bubble-agent'], ['pane']],
  ['successBg', 'Success background', ['--color-success-bg'], ['success', 'pane']], ['successText', 'Success text', ['--color-success-text'], ['success']], ['warnBg', 'Warning background', ['--color-warn-bg'], ['warn', 'pane']], ['warnText', 'Warning text', ['--color-warn-text'], ['warn']],
  ['dangerBg', 'Danger background', ['--color-danger-bg'], ['danger', 'pane']], ['dangerText', 'Danger text', ['--color-danger-text'], ['danger']], ['dangerHover', 'Danger hover', ['--color-danger-hover'], ['danger']],
];
export const TOKENS: TokenDef[] = [
  ...seeds.map(([id, label, cssVars]): TokenDef => ({ id, label, cssVars, kind: 'seed', type: 'color' })),
  ...derived.map(([id, label, cssVars, dependsOn]): TokenDef => ({ id, label, cssVars, dependsOn, kind: 'derived', type: 'color' })),
];
for (const token of TOKENS) {
  if (['ink', 'text2', 'text3'].includes(token.id)) token.contrast = (['pane', 'sidebar', 'elevated', 'bubbleAgent'] as TokenId[]).map(against => ({ against, min: token.id === 'text3' ? 3 : 4.5, role: token.id === 'text3' ? 'large' : 'text' }));
  if (token.id === 'primary' || token.id === 'focus') token.contrast = [{ against: 'pane', min: 3, role: 'ui' }];
  if (token.id === 'onPrimary') token.contrast = [{ against: 'primary', min: 4.5, role: 'text' }];
  if (['successText', 'warnText', 'dangerText'].includes(token.id)) token.contrast = [{ against: token.id.replace('Text', 'Bg') as TokenId, min: 4.5, role: 'text' }];
}
