import './lib/legacy-storage'; // before reading saved preferences
import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { enterChatPane, useStore } from './store';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines' | 'analytics' | 'learning';
export type AppSection = 'general' | 'keys' | 'usage' | 'computer' | 'messaging' | 'permissions' | 'apps' | 'mcp' | 'account' | 'subscriptions' | 'learning';

/** Where to continue after a sign-in that leaves the page (provider redirects, phone verification). */
export type ResumeAction = 'login' | 'reset' | 'pair' | 'revoke';
export interface ResumeTarget { section: AppSection; provider?: 'codex' | 'claude'; accountId: string; action: ResumeAction; expiresAt: number }

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  /** Consumed once by the section it names, after a sign-in round trip planned with planResume(). */
  resume: ResumeTarget | null;
  /** Settings was opened without a section (e.g. ⌘, or the account menu), so phones start on the section list. */
  appSettingsHome: boolean;
  view: 'chat' | 'tasks';
  theme: Theme;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  clearResume(): void;
  setView(v: 'chat' | 'tasks'): void;
  setTheme(t: Theme): void;
  bump(key: string): void;
}

const LS_THEME = 'swarm.theme';
const readTheme = (): Theme => {
  try { const t = localStorage.getItem(LS_THEME); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
};

/** Deep link: /#settings/<section> (e.g. #settings/messaging, or just #messaging) opens Settings there. */
const SECTIONS_LINKABLE: AppSection[] = ['general', 'keys', 'computer', 'messaging', 'permissions', 'apps', 'mcp', 'account', 'subscriptions', 'learning', 'usage'];
/** Old links that now open a different section. */
const SECTION_ALIASES: Record<string, AppSection> = { whatsapp: 'messaging' };
const linkedSection = (): AppSection | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#(settings\/)?/, '');
  const h = (SECTION_ALIASES[raw] ?? raw) as AppSection;
  return SECTIONS_LINKABLE.includes(h) ? h : null;
};

const SS_RESUME = 'swarm.resume';
const SESSION_PROVIDERS = ['codex', 'claude'] as const;
/** Remember where to return once a sign-in that reloads or redirects the page completes. */
export function planResume(target: Omit<ResumeTarget, 'expiresAt'>) {
  try { sessionStorage.setItem(SS_RESUME, JSON.stringify({ ...target, expiresAt: Date.now() + 10 * 60_000 })); } catch { /* ignore */ }
}
export function cancelResume() {
  try { sessionStorage.removeItem(SS_RESUME); } catch { /* ignore */ }
}
const takeResume = (): ResumeTarget | null => {
  try {
    const raw = sessionStorage.getItem(SS_RESUME);
    if (!raw) return null;
    sessionStorage.removeItem(SS_RESUME);
    const parsed = JSON.parse(raw) as Partial<ResumeTarget> | null;
    if (!parsed || !SECTIONS_LINKABLE.includes(parsed.section as AppSection)) return null;
    if (typeof parsed.accountId !== 'string' || !parsed.accountId || parsed.accountId.length > 128) return null;
    if (!['login', 'reset', 'pair', 'revoke'].includes(parsed.action ?? '')) return null;
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() || parsed.expiresAt > Date.now() + 10 * 60_000) return null;
    const provider = SESSION_PROVIDERS.find((p) => p === parsed.provider);
    return { section: parsed.section as AppSection, accountId: parsed.accountId, action: parsed.action as ResumeAction, expiresAt: parsed.expiresAt, ...(provider ? { provider } : {}) };
  } catch { return null; }
};
const resumed = takeResume();
const initialSection = (): AppSection | null => {
  const linked = linkedSection();
  // OpenRouter callbacks link to keys on both success and denial. A planned
  // sign-in returns to its saved destination for verification or retry.
  const code = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('openrouter');
  if (resumed && linked === 'keys' && (code === 'connected' || code?.startsWith('openrouter_'))) {
    window.history?.replaceState(window.history.state, '', window.location.pathname + window.location.search + `#settings/${resumed.section}`);
    return resumed.section;
  }
  return linked ?? resumed?.section ?? null;
};

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: initialSection(),
  resume: resumed,
  appSettingsHome: false,
  view: 'chat',
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section) => set({ appSettings: section ?? 'general', appSettingsHome: !section }),
  closeAppSettings: () => {
    if (linkedSection()) history.replaceState(history.state, '', window.location.pathname + window.location.search);
    set({ appSettings: null, appSettingsHome: false });
  },
  clearResume: () => set({ resume: null }),
  setView: (view) => {
    if (view === 'tasks') enterChatPane(); // phones: Tasks replaces the list, like a chat
    set({ view });
  },
  setTheme: (theme) => {
    try { localStorage.setItem(LS_THEME, theme); } catch { /* ignore */ }
    applyTheme(theme);
    set({ theme });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
window.addEventListener('hashchange', () => {
  const section = linkedSection();
  if (section) useConfigUI.getState().openAppSettings(section);
});
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('swarm:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
  if (ev.type === 'setup') bump(`setup:${ev.botId}`);
  if (ev.type === 'messaging') bump('messaging');
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
