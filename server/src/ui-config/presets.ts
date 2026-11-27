import { DEFAULT_CONFIG, type UiConfig } from './schema.js';
import type { PatchOp } from './service.js';
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export interface Preset { id: string; label: string; description: string; config: DeepPartial<Pick<UiConfig, 'theme' | 'layout' | 'components' | 'keybindings'>> }
export const PRESETS: Preset[] = [
  { id: 'swarm', label: 'Swarm', description: 'The original look', config: {} },
  { id: 'midnight', label: 'Midnight', description: 'Dark with indigo', config: { theme: { mode: 'dark', colors: { light: { primary: '#4338CA' }, dark: { primary: '#A5B4FC' } } } } },
  { id: 'paper', label: 'Paper', description: 'Warm and readable', config: { theme: { mode: 'light', font: { ui: 'serif' }, radius: 'round', colors: { light: { pane: '#FFFCF5', sidebar: '#F8F4E9' } } } } },
  { id: 'forest', label: 'Forest', description: 'Teal and green', config: { theme: { colors: { light: { primary: '#0F766E' }, dark: { primary: '#5EEAD4' } } } } },
  { id: 'contrast', label: 'High contrast', description: 'Clear and spacious', config: { theme: { contrast: 'high', font: { scale: 'large' }, density: 'comfortable' } } },
  { id: 'focus', label: 'Focus', description: 'Less visual clutter', config: { theme: { density: 'compact' }, components: { 'sidebar.usage': 'hide', 'chat.runLog': 'collapsed' } } },
  { id: 'calm', label: 'Calm', description: 'Quiet and spacious', config: { theme: { radius: 'round', density: 'comfortable', motion: 'reduced' } } },
  { id: 'colorblind', label: 'Colorblind safe', description: 'Blue orange purple', config: { theme: { colors: { light: { success: '#0072B2', warn: '#D55E00', danger: '#9C4A88' }, dark: { success: '#56B4E9', warn: '#E69F00', danger: '#CC79A7' } } } } },
];
/** Arrays replace, objects merge. Inputs are validated documents or trusted registry data. */
export function mergeConfig<T>(base: T, overlay: DeepPartial<T>): T {
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return structuredClone(overlay) as T;
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeConfig(result[key] ?? {}, value) : structuredClone(value);
  }
  return result as T;
}
/** The document overrides its preset. Selecting a preset also writes its values via presetPatch. */
export function effectiveConfig(doc: UiConfig, phone = false): UiConfig {
  const preset = PRESETS.find(p => p.id === doc.preset);
  const result = mergeConfig<UiConfig>(mergeConfig<UiConfig>(DEFAULT_CONFIG, preset?.config ?? {}), doc);
  if (phone) { result.theme.density = doc.device?.phone?.density ?? result.theme.density; result.theme.font.scale = doc.device?.phone?.scale ?? result.theme.font.scale; if (result.theme.density === 'compact') result.theme.density = 'default'; }
  return result;
}
export function presetConfig(id: string): UiConfig {
  const preset = PRESETS.find(p => p.id === id);
  if (!preset) throw new Error('Unknown preset.');
  return { ...mergeConfig<UiConfig>(DEFAULT_CONFIG, preset.config), preset: id };
}
export function presetPatch(id: string): PatchOp[] {
  const doc = presetConfig(id);
  return (['preset', 'theme', 'layout', 'components', 'keybindings'] as const).map(key => ({ op: 'replace', path: `/${key}`, value: doc[key] }));
}
