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

export const shortcut = (id: string) => SHORTCUTS.find(s => s.id === id)!;

/** Individual key caps, e.g. Mac ['⇧', '⌘', ','] and elsewhere ['Ctrl', 'Shift', ',']. */
export function shortcutKeys(s: ShortcutKeys, mac = IS_MAC): string[] {
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
  return e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n');
}
