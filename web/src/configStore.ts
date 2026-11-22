import './lib/legacy-storage'; // before reading saved preferences
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { backToList, enterChatPane, useStore } from './store';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines' | 'analytics' | 'learning';
export type AppSection = 'general' | 'keys' | 'usage' | 'computer' | 'messaging' | 'permissions' | 'apps' | 'mcp' | 'account' | 'subscriptions' | 'learning';

/** Where to continue after a sign-in that leaves the page (provider redirects, phone verification). */
export type ResumeAction = 'login' | 'reset' | 'pair' | 'revoke';
export interface ResumeTarget { section: AppSection; provider?: 'codex' | 'claude'; accountId: string; action: ResumeAction; expiresAt: number }

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  /** Unsaved Bot settings drafts by editor id, with the tab label each belongs to (R2F-004). */
  botSettingsDrafts: Record<string, string>;
  /** True while Bot settings is open with an unsaved draft on any tab. */
  botSettingsDirty: boolean;
  /** A navigation waiting on the "Discard unsaved changes?" answer. */
  botSettingsLeave: { next: () => void } | null;
  /** Bumped when the user discards drafts so editors that stay mounted reset. */
  botSettingsDiscards: number;
  appSettings: AppSection | null;
  subscriptionProvider: 'codex' | 'claude' | null;
  /** Consumed once by the section it names, after a sign-in round trip planned with planResume(). */
  resume: ResumeTarget | null;
  /** Settings was opened without a section (e.g. ⌘, or the account menu), so phones start on the section list. */
  appSettingsHome: boolean;
  view: 'chat' | 'tasks' | 'bots';
  theme: Theme;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  /** Leaves Bot settings, asking first when a draft is unsaved. */
  closeBotSettings(): void;
  /** Leaves Bot settings without asking (the Bot is gone or the draft was already handled). */
  discardBotSettings(): void;
  setBotSettingsDraft(id: string, label: string | null): void;
  /** Runs `next` now when nothing is unsaved; otherwise shows the discard dialog and runs it only on Discard. */
  requestLeaveBotSettings(next: () => void): boolean;
  resolveLeaveBotSettings(discard: boolean): void;
  openAppSettings(section?: AppSection, subscriptionProvider?: 'codex' | 'claude'): void;
  closeAppSettings(): void;
  clearResume(): void;
  setView(v: 'chat' | 'tasks' | 'bots'): void;
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

/** R2F-028: /#bot/<id>/settings/<tab> reopens that Bot's settings tab (hash sync only, PD-R2-07 A). */
const BOT_SETTINGS_TABS: BotSettingsTab[] = ['general', 'skills', 'memories', 'routines', 'analytics', 'learning'];
export const botSettingsHash = (botId: string, tab: BotSettingsTab) => `#bot/${encodeURIComponent(botId)}/settings/${tab}`;
const linkedBotSettings = (): { botId: string; tab: BotSettingsTab } | null => {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#bot\/([^/]{1,128})\/settings(?:\/([a-z]+))?$/);
  if (!match) return null;
  let botId: string;
  try { botId = decodeURIComponent(match[1]); } catch { return null; }
  const tab = (match[2] ?? 'general') as BotSettingsTab;
  return botId && BOT_SETTINGS_TABS.includes(tab) ? { botId, tab } : null;
};
const replaceHash = (hash: string) => {
  if (typeof window === 'undefined' || window.location.hash === hash || (!hash && !window.location.hash)) return;
  history.replaceState(history.state, '', window.location.pathname + window.location.search + hash);
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

const initialAppSection = initialSection();

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: initialAppSection ? null : linkedBotSettings(),
  botSettingsDrafts: {},
  botSettingsDirty: false,
  botSettingsLeave: null,
  botSettingsDiscards: 0,
  appSettings: initialAppSection,
  subscriptionProvider: null,
  resume: resumed,
  appSettingsHome: false,
  view: 'chat',
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => {
    const open = () => {
      // Keep a real list entry behind phone settings, including a reloaded deep link.
      if (!get().appSettings) {
        const store = useStore.getState();
        const restoring = store.mobile && store.mobilePane === 'list' && linkedBotSettings()
          && history.state?.swarmPane === 'chat' && history.state.swarmDoc === performance.timeOrigin;
        if (restoring) store.set({ mobilePane: 'chat' });
        else {
          if (store.mobile && store.mobilePane === 'list' && linkedBotSettings()) replaceHash('');
          enterChatPane();
        }
      }
      // Every tab change replaces the URL, so one Settings visit leaves one history entry.
      if (!get().appSettings) replaceHash(botSettingsHash(botId, tab));
      set({ botSettings: { botId, tab } });
    };
    // Tabs of the same Bot keep the General draft; another Bot's settings would drop it.
    if (get().botSettings && get().botSettings?.botId !== botId) get().requestLeaveBotSettings(open);
    else open();
  },
  closeBotSettings: () => { get().requestLeaveBotSettings(() => {
    get().discardBotSettings();
    if (useStore.getState().mobile) { set({ view: 'chat' }); backToList(); }
  }); },
  discardBotSettings: () => {
    if (linkedBotSettings()) replaceHash('');
    set({ botSettings: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null });
  },
  setBotSettingsDraft: (id, label) => {
    const drafts = get().botSettingsDrafts;
    if ((drafts[id] ?? null) === label) return;
    const next = { ...drafts };
    if (label) next[id] = label; else delete next[id];
    set({ botSettingsDrafts: next, botSettingsDirty: Object.keys(next).length > 0 });
  },
  requestLeaveBotSettings: (next) => {
    const state = get();
    if (!state.botSettings || !state.botSettingsDirty) { next(); return true; }
    // Show the question where it can be seen: over Settings, search or the apps dialog it would be hidden.
    if (state.appSettings) state.closeAppSettings();
    const store = useStore.getState();
    if (store.modal === 'search' || store.modal === 'apps') store.setModal(null);
    set({ botSettingsLeave: { next } });
    return false;
  },
  resolveLeaveBotSettings: (discard) => {
    const pending = get().botSettingsLeave;
    if (!discard) { set({ botSettingsLeave: null }); return; }
    set({ botSettingsLeave: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsDiscards: get().botSettingsDiscards + 1 });
    pending?.next();
  },
  openAppSettings: (section, subscriptionProvider) => {
    // Keep the URL on the open section so a reload reopens it (PD-05 hash sync). replaceState fires no hashchange.
    if (section && SECTIONS_LINKABLE.includes(section)) replaceHash(`#settings/${section}`);
    set({ appSettings: section ?? 'general', appSettingsHome: !section, subscriptionProvider: section === 'subscriptions' ? subscriptionProvider ?? null : null });
  },
  closeAppSettings: () => {
    // Back on an open Bot settings page, the URL names that page again.
    const bot = get().botSettings;
    if (bot) replaceHash(botSettingsHash(bot.botId, bot.tab));
    else if (linkedSection()) replaceHash('');
    set({ appSettings: null, appSettingsHome: false, subscriptionProvider: null });
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

// A settings page can cover an open Setup page. Recompute the visible title on cleanup
// so closing either layer cannot restore a title from a page that has already left.
const pageTitles = new Map<symbol, { title: string; layer: number }>();
export function usePageTitle(title: string | null, layer = 0) {
  useEffect(() => {
    if (!title) return;
    const key = Symbol();
    const update = () => {
      const top = [...pageTitles.values()].sort((a, b) => b.layer - a.layer)[0];
      document.title = top?.title ?? 'Swarm';
    };
    pageTitles.set(key, { title, layer }); update();
    return () => { pageTitles.delete(key); update(); };
  }, [title, layer]);
}

// Apply the saved theme as early as possible, and follow the OS while on "system".
window.addEventListener('hashchange', () => {
  const section = linkedSection();
  if (section) { useConfigUI.getState().openAppSettings(section); return; }
  const bot = linkedBotSettings();
  if (bot) useConfigUI.getState().openBotSettings(bot.botId, bot.tab);
});
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('swarm:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); bump('needs-you'); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
  if (ev.type === 'setup') { bump(`setup:${ev.botId}`); bump('needs-you'); }
  if (ev.type === 'messaging') bump('messaging');
  // R2F-017: the server announces account time zone changes; Daily synopses reloads on it.
  if ((ev as { type: string }).type === 'synopses') bump('synopses');
});

// Needs-you (MF-012) also refetches when a card row appears or changes state ('rows' events stay in store.ts).
const cardSignatures = new Map<string, string>();
let needsYouTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.transcripts === prev.transcripts) return;
  let changed = false;
  for (const [botId, transcript] of Object.entries(s.transcripts)) {
    if (prev.transcripts[botId] === transcript) continue;
    let signature = String(transcript.generation);
    for (const row of Object.values(transcript.bySeq)) if (row.kind === 'card') signature += `|${row.seq}:${row.updatedSeq}`;
    if (cardSignatures.get(botId) !== signature) { cardSignatures.set(botId, signature); changed = true; }
  }
  if (!changed) return;
  clearTimeout(needsYouTimer);
  needsYouTimer = setTimeout(() => useConfigUI.getState().bump('needs-you'), 300);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);

/** Canonical navigation from global bot lists/search: close panels from the previous caller. */
export function openConversation(botId: string) {
  useConfigUI.getState().requestLeaveBotSettings(() => {
    const ui = useConfigUI.getState();
    ui.closeAppSettings();
    ui.discardBotSettings();
    ui.setView('chat');
    useStore.getState().setModal(null);
    useStore.getState().selectBot(botId);
  });
}

/** Registers an unsaved Bot settings draft while `dirty` (R2F-004). `label` names its tab in the dialog. */
export function useBotSettingsDraft(id: string, label: string, dirty: boolean) {
  useEffect(() => {
    useConfigUI.getState().setBotSettingsDraft(id, dirty ? label : null);
    return () => useConfigUI.getState().setBotSettingsDraft(id, null);
  }, [id, label, dirty]);
}
