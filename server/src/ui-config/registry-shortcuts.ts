export const SHORTCUT_IDS = ['search', 'settings', 'newBot', 'focusComposer', 'toggleSidebar', 'toggleDetails', 'effort', 'fast', 'goBots', 'goTasks', 'goDashboard1', 'goDashboard2', 'goDashboard3'] as const;
export type ShortcutId = typeof SHORTCUT_IDS[number];
const labels = ['Search', 'Open Settings', 'Create a Bot', 'Focus composer', 'Toggle sidebar', 'Toggle Bot details', 'Thinking effort', 'Fast mode', 'Go to Bots', 'Go to Tasks', 'Open dashboard 1', 'Open dashboard 2', 'Open dashboard 3'];
const defaults = ['Mod+K', 'Mod+,', 'Alt+Shift+N', 'Mod+I', 'Mod+B', 'Mod+Shift+,', 'Mod+Shift+/', 'Mod+Shift+F', null, null, null, null, null];
export const SHORTCUTS = SHORTCUT_IDS.map((id, i) => ({ id, label: labels[i], default: defaults[i], required: id === 'settings', scope: id === 'effort' || id === 'fast' ? 'composer' : 'app' }));
export const RESERVED_SHORTCUTS = ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+R', 'Mod+L', 'F5', 'Alt+F4', 'Tab', 'Escape', 'Enter', 'Space', 'Mod+Alt+0'] as const;
export function normalizeShortcut(raw: string): string | null {
  const parts = raw.split('+'), key = parts.pop();
  if (!key || !/^(?:[a-z0-9,./;\[\]\\'`=-]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right))$/i.test(key)) return null;
  if (new Set(parts).size !== parts.length || parts.some(x => !['Mod', 'Alt', 'Shift'].includes(x)) || !parts.some(x => x === 'Mod' || x === 'Alt')) return null;
  return [...['Mod', 'Alt', 'Shift'].filter(x => parts.includes(x)), key.length === 1 ? key.toUpperCase() : key].join('+');
}
export function isReservedShortcut(binding: string): boolean {
  const normalized = normalizeShortcut(binding);
  // Shift does not make browser tab/window controls safe to override.
  return !normalized || RESERVED_SHORTCUTS.includes(normalized as typeof RESERVED_SHORTCUTS[number]) || /^(?:Mod\+(?:Alt\+)?(?:Shift\+)?[WTNQRL]|Alt\+(?:Shift\+)?F4)$/i.test(normalized);
}
