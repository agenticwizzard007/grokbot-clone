import { DEFAULT_CONFIG, type UiConfig } from './schema.js';
import { COMPONENTS } from './registry-components.js';
import { NAV } from './registry-nav.js';
import { SHORTCUTS } from './registry-shortcuts.js';
import { TOKENS, DEFAULT_SEEDS, DEFAULT_DERIVED } from './registry-tokens.js';
import { FONTS } from './registry-fonts.js';
import { PRESETS } from './presets.js';
import { WIDGETS } from './registry-widgets.js';
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = Object.keys(a), y = Object.keys(b);
  return x.length === y.length && x.every(k => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const labels: Record<string, string> = { system: 'System', light: 'Light', dark: 'Dark', default: 'Default', large: 'Large', xlarge: 'Extra large', compact: 'Compact', comfortable: 'Comfortable', sharp: 'Sharp', round: 'Round', reduced: 'Reduced', normal: 'Normal', high: 'High', narrow: 'Narrow', wide: 'Wide', bots: 'Bots', tasks: 'Tasks', same: 'Same as UI', instrument: 'Instrument Sans' };
const label = (value: string) => labels[value] ?? FONTS.find(f => f.id === value)?.label ?? 'Custom';
export function summarize(before: UiConfig, after: UiConfig): string[] {
  const lines: string[] = [];
  const change = (title: string, a: string, b: string) => { if (a !== b) lines.push(`${title}: ${label(a)} to ${label(b)}`); };
  if (before.preset !== after.preset) lines.push(`Preset: ${PRESETS.find(p => p.id === after.preset)?.label ?? 'Saved preset'}`);
  change('Theme', before.theme.mode, after.theme.mode);
  for (const mode of ['light', 'dark'] as const) for (const token of TOKENS) {
    const group = token.kind === 'seed' ? 'colors' : 'overrides';
    const oldMap = before.theme[group][mode] as Record<string, string>, newMap = after.theme[group][mode] as Record<string, string>;
    const defaults: Record<string, string> = { ...DEFAULT_SEEDS[mode], ...DEFAULT_DERIVED[mode] };
    if (oldMap[token.id] !== newMap[token.id]) lines.push(`${token.label}: ${oldMap[token.id] ?? defaults[token.id]} to ${newMap[token.id] ?? defaults[token.id]}`);
  }
  change('UI font', before.theme.font.ui, after.theme.font.ui); change('Heading font', before.theme.font.heading, after.theme.font.heading);
  change('Text size', before.theme.font.scale, after.theme.font.scale);
  for (const key of ['density', 'radius', 'motion', 'contrast'] as const) change(({ density: 'Density', radius: 'Corners', motion: 'Motion', contrast: 'Contrast' })[key], before.theme[key], after.theme[key]);
  for (const component of COMPONENTS) {
    const previous = before.components[component.id] ?? component.default, next = after.components[component.id] ?? component.default;
    if (previous !== next) lines.push(`${next === 'hide' ? 'Hid' : next === 'collapsed' ? 'Collapsed' : 'Showed'} ${component.label}`);
  }
  if (!equal(before.layout.home, after.layout.home)) lines.push(`Home: ${after.layout.home.kind === 'dashboard' ? after.dashboards.find(d => after.layout.home.kind === 'dashboard' && d.id === after.layout.home.dashboardId)!.name : label(after.layout.home.kind)}`);
  if (!equal(before.layout.phoneTabs, after.layout.phoneTabs)) lines.push('Reordered phone tabs');
  if (!equal(before.layout.sidebar.order, after.layout.sidebar.order)) lines.push('Reordered sidebar items');
  for (const nav of NAV) if (before.layout.sidebar.hidden.includes(nav.id) !== after.layout.sidebar.hidden.includes(nav.id)) lines.push(`${after.layout.sidebar.hidden.includes(nav.id) ? 'Hid' : 'Showed'} ${nav.label} in the sidebar`);
  change('Sidebar width', before.layout.sidebar.width, after.layout.sidebar.width); change('Chat width', before.layout.chat.width, after.layout.chat.width);
  if (before.layout.sidebar.collapsed !== after.layout.sidebar.collapsed) lines.push(after.layout.sidebar.collapsed === null ? 'Sidebar collapse: Automatic' : after.layout.sidebar.collapsed ? 'Collapsed sidebar' : 'Expanded sidebar');
  if (!equal(before.layout.pinned, after.layout.pinned)) lines.push('Updated pinned items');
  for (const shortcut of SHORTCUTS) if (before.keybindings[shortcut.id] !== after.keybindings[shortcut.id]) lines.push(`${after.keybindings[shortcut.id] === null ? 'Unbound' : 'Updated shortcut for'} ${shortcut.label}`);
  const removed = before.dashboards.filter(d => !after.dashboards.some(n => n.id === d.id));
  if (removed.length) lines.push(`Removes ${removed.length} dashboard${removed.length === 1 ? '' : 's'}`);
  for (const dashboard of after.dashboards) {
    const previous = before.dashboards.find(d => d.id === dashboard.id);
    if (!previous) { lines.push(`Added dashboard ${dashboard.name} with ${dashboard.widgets.length} widget${dashboard.widgets.length === 1 ? '' : 's'}`); continue; }
    if (previous.name !== dashboard.name) lines.push(`Renamed dashboard ${previous.name} to ${dashboard.name}`);
    if (previous.icon !== dashboard.icon || previous.description !== dashboard.description) lines.push(`Updated dashboard ${dashboard.name}`);
    for (const widget of dashboard.widgets) {
      const old = previous.widgets.find(w => w.id === widget.id), title = widget.title || WIDGETS.find(w => w.id === widget.type)!.label;
      if (!old) lines.push(`Added ${title} to ${dashboard.name}`);
      else if (!equal(old, widget)) lines.push(`Updated ${title} in ${dashboard.name}`);
    }
    for (const widget of previous.widgets) if (!dashboard.widgets.some(w => w.id === widget.id)) lines.push(`Removed ${widget.title || WIDGETS.find(w => w.id === widget.type)!.label} from ${dashboard.name}`);
    const commonBefore = previous.widgets.filter(w => dashboard.widgets.some(n => n.id === w.id)).map(w => w.id), commonAfter = dashboard.widgets.filter(w => previous.widgets.some(n => n.id === w.id)).map(w => w.id);
    if (!equal(commonBefore, commonAfter)) lines.push(`Reordered widgets in ${dashboard.name}`);
  }
  if (!equal(before.device, after.device) && !equal(after.device, DEFAULT_CONFIG.device)) lines.push('Updated phone appearance');
  else if (!equal(before.device, after.device)) lines.push('Reset phone appearance');
  return lines;
}
