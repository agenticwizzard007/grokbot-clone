import { SHORTCUTS as ACTIONS, normalizeShortcut, isReservedShortcut } from '@shared/ui-config/registry-shortcuts';
/** Keyboard shortcuts: one list for the handlers' documentation, Settings and every tooltip glyph. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ShortcutKeys { mod?: boolean; alt?: boolean; shift?: boolean; key: string }
export interface Shortcut extends ShortcutKeys { id: string; label: string; scope?: 'app' | 'composer'; web?: boolean }

export const SHORTCUTS: Shortcut[] = [
  { id: 'search', label: 'Search Bots and messages', mod: true, key: 'K' },
  // In the Mac app Cmd+, opens the app's own server settings, so it never reaches the web page.
  { id: 'settings', label: 'Open Settings', mod: true, key: ',', web: true },
  { id: 'new-bot', label: 'Create a Bot', alt: true, shift: true, key: 'N' },
  { id: 'focus', label: 'Focus the message box', mod: true, key: 'I' },
  { id: 'sidebar', label: 'Show or hide the sidebar', mod: true, key: 'B' },
  { id: 'details', label: 'Show or hide Bot details', mod: true, shift: true, key: ',' },
  { id: 'effort', label: 'Change thinking effort (in the message box)', mod: true, shift: true, key: '/', scope: 'composer' },
  { id: 'fast', label: 'Turn Fast mode on or off (in the message box)', mod: true, shift: true, key: 'F', scope: 'composer' },
];

const aliases: Record<string, string> = { 'new-bot': 'newBot', focus: 'focusComposer', sidebar: 'toggleSidebar', details: 'toggleDetails' };
const defaults = SHORTCUTS.map(s => ({ ...s }));
export function effectiveBindings(overrides: Record<string, string | null | undefined> = {}): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const used = new Set<string>();
  // Settings wins any corrupt duplicate, preserving the recovery shortcut.
  for (const action of [...ACTIONS].sort((a, b) => Number(b.required) - Number(a.required))) {
    const raw = Object.hasOwn(overrides, action.id) ? overrides[action.id] : action.default;
    let value = typeof raw === 'string' && !isReservedShortcut(raw) ? normalizeShortcut(raw) : null;
    if (action.required && !value) value = action.default;
    if (value && used.has(value)) value = null;
    if (value) used.add(value);
    result[action.id] = value;
  }
  return result;
}
let effective = effectiveBindings();
function bindingKeys(binding: string | null): ShortcutKeys {
  const parts = binding?.split('+') ?? [];
  return { mod: parts.includes('Mod'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), key: parts.at(-1) ?? '' };
}
export function setShortcutBindings(overrides: Record<string, string | null | undefined>) {
  effective = effectiveBindings(overrides);
  // Keep the public list stable for existing Settings and tooltip consumers.
  for (const original of defaults) Object.assign(SHORTCUTS.find(s => s.id === original.id)!, bindingKeys(effective[aliases[original.id] ?? original.id]));
}
export const shortcut = (id: string) => SHORTCUTS.find(s => s.id === id) ?? { id, label: id, ...bindingKeys(effective[id] ?? null) };
export function shortcutMatches(id: string, event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): boolean {
  const binding = effective[aliases[id] ?? id];
  return bindingMatches(binding, event);
}
export function bindingMatches(binding: string | null | undefined, event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): boolean {
  if (!binding || isReservedShortcut(binding)) return false;
  const keys = bindingKeys(binding);
  if (!!keys.mod !== (IS_MAC ? event.metaKey : event.ctrlKey) || (IS_MAC ? event.ctrlKey : event.metaKey)
    || !!keys.alt !== event.altKey || !!keys.shift !== event.shiftKey) return false;
  const code = /^[A-Z]$/.test(keys.key) ? `Key${keys.key}` : /^[0-9]$/.test(keys.key) ? `Digit${keys.key}`
    : ({ ',': 'Comma', '/': 'Slash', '.': 'Period' } as Record<string, string>)[keys.key];
  return event.key.toUpperCase() === keys.key.toUpperCase() || !!code && event.code === code;
}

/** Individual key caps, e.g. Mac ['⇧', '⌘', ','] and elsewhere ['Ctrl', 'Shift', ',']. */
export function shortcutKeys(s: ShortcutKeys, mac = IS_MAC): string[] {
  if (!s.key) return [];
  const keys: string[] = [];
  if (mac) {
    if (s.alt) keys.push('⌥');
    if (s.shift) keys.push('⇧');
    if (s.mod) keys.push('⌘');
  } else {
    if (s.mod) keys.push('Ctrl');
    if (s.alt) keys.push('Alt');
    if (s.shift) keys.push('Shift');
  }
  keys.push(s.key);
  return keys;
}

/** One string for tooltips and menu hints: Mac '⇧⌘,' and elsewhere 'Ctrl+Shift+,'. */
export function shortcutLabel(s: ShortcutKeys | string, mac = IS_MAC): string {
  const keys = shortcutKeys(typeof s === 'string' ? shortcut(s) : s, mac);
  return mac ? keys.join('') : keys.join('+');
}

/** Alt+Shift+N (Option+Shift+N on Mac). Uses `code` because Option changes `key` on Mac layouts. */
export function isNewBotShortcut(e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'code' | 'key'>): boolean {
  return shortcutMatches('newBot', e);
}
