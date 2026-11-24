import './lib/legacy-storage'; // before reading saved preferences
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { backToList, enterChatPane, useStore } from './store';
import { botSlug, routeBot, linkedWork, workHash, type WorkRoute } from './lib/userRoutes';

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
  workRoute: WorkRoute;
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
  setWorkRoute(route: WorkRoute): void;
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
  if (/^#settings\/?$/.test(window.location.hash)) return 'general';
  const raw = window.location.hash.replace(/^#(settings\/)?/, '');
  const h = (SECTION_ALIASES[raw] ?? raw) as AppSection;
  return SECTIONS_LINKABLE.includes(h) ? h : null;
};

/** Settings links resolve after the account's Bots load. Legacy ID links are canonicalized. */
const BOT_SETTINGS_TABS: BotSettingsTab[] = ['general', 'skills', 'memories', 'routines', 'analytics', 'learning'];
export const botSettingsHash = (botId: string, tab: BotSettingsTab) => {
  const bot = useStore.getState().bots.find(bot => bot.id === botId) ?? { id: botId, name: 'Bot' };
  return `#bot/${encodeURIComponent(botSlug(bot))}/settings/${tab}`;
};
const botSettingsLink = (): { reference: string; tab: BotSettingsTab } | null => {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#bot\/([^/]{1,128})\/settings(?:\/([a-z]+))?$/);
  if (!match) return null;
  let reference: string;
  try { reference = decodeURIComponent(match[1]); } catch { return null; }
  const tab = (match[2] ?? 'general') as BotSettingsTab;
  return reference && BOT_SETTINGS_TABS.includes(tab) ? { reference, tab } : null;
};
/** Settings hash navigation is handled here, including the unsaved-draft guard. */
export const hasSettingsLink = () => !!(linkedSection() || botSettingsLink());
const linkedBotSettings = (): { botId: string; tab: BotSettingsTab } | null => {
  const link = botSettingsLink();
  const bot = link && routeBot(link.reference, useStore.getState().bots);
  return bot && link ? { botId: bot.id, tab: link.tab } : null;
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
// Only an explicit link may uncover Settings when its Bot becomes available.
let pendingBotSettingsLink = !initialAppSection && botSettingsLink() ? window.location.hash : null;

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
  view: typeof window !== 'undefined' && linkedWork(window.location.hash) ? 'tasks' : 'chat',
  workRoute: (typeof window !== 'undefined' && linkedWork(window.location.hash)) || { tab: 'Tasks' },
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => {
    pendingBotSettingsLink = null;
    const open = () => {
      if (get().appSettings) get().closeAppSettings();
      // Keep a real list entry behind phone settings, including a reloaded deep link.
      const store = useStore.getState();
      const restoring = store.mobile && store.mobilePane === 'list' && linkedBotSettings()
        && history.state?.swarmPane === 'chat' && history.state.swarmDoc === performance.timeOrigin;
      if (restoring) store.set({ mobilePane: 'chat' });
      else {
        if (store.mobile && store.mobilePane === 'list' && linkedBotSettings()) replaceHash('');
        enterChatPane();
      }
      // Every tab change replaces the URL, so one Settings visit leaves one history entry.
      replaceHash(botSettingsHash(botId, tab));
      set({ botSettings: { botId, tab } });
    };
    // Tabs of the same Bot keep the General draft; another Bot's settings would drop it.
    if (get().botSettings && get().botSettings?.botId !== botId) get().requestLeaveBotSettings(open);
    else open();
  },
  closeBotSettings: () => { pendingBotSettingsLink = null; get().requestLeaveBotSettings(() => {
    get().discardBotSettings();
    if (useStore.getState().mobile) { set({ view: 'chat' }); backToList(); }
  }); },
  discardBotSettings: () => {
    pendingBotSettingsLink = null;
    if (get().botSettings && !get().appSettings) replaceHash(get().view === 'tasks' ? workHash(get().workRoute) : '');
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
    pendingBotSettingsLink = null;
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
    pendingBotSettingsLink = null;
    const state = get();
    const open = () => {
      // Default entry points also name the visible section, including on phones.
      replaceHash(`#settings/${section ?? 'general'}`);
      set({ botSettings: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null,
        appSettings: section ?? 'general', appSettingsHome: !section, subscriptionProvider: section === 'subscriptions' ? subscriptionProvider ?? null : null });
    };
    // A hash link may have changed the URL before the draft guard runs. Keep it on
    // the Bot page until Discard completes the switch to app Settings.
    if (!state.requestLeaveBotSettings(open) && state.botSettings) replaceHash(botSettingsHash(state.botSettings.botId, state.botSettings.tab));
  },
  closeAppSettings: () => {
    pendingBotSettingsLink = null;
    // Back on an open Bot settings page, the URL names that page again.
    const bot = get().botSettings;
    if (bot) replaceHash(botSettingsHash(bot.botId, bot.tab));
    else if (get().view === 'tasks') replaceHash(workHash(get().workRoute));
    else if (linkedSection()) replaceHash('');
    set({ appSettings: null, appSettingsHome: false, subscriptionProvider: null });
  },
  clearResume: () => set({ resume: null }),
  setView: (view) => {
    pendingBotSettingsLink = null;
    if (view === 'tasks') enterChatPane(); // phones: Tasks replaces the list, like a chat
    set({ view });
    if (!get().appSettings && !get().botSettings) {
      if (view === 'tasks') replaceHash(workHash(get().workRoute));
      else if (linkedWork(window.location.hash)) replaceHash('');
    }
  },
  setWorkRoute: (workRoute) => {
    pendingBotSettingsLink = null;
    const bot = workRoute.botSlug && routeBot(workRoute.botSlug, useStore.getState().bots);
    const route = bot ? { ...workRoute, botSlug: botSlug(bot) } : workRoute;
    set({ workRoute: route });
    if (get().view === 'tasks' && !get().appSettings && !get().botSettings) replaceHash(workHash(route));
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
const restoreLinkedPage = () => {
  pendingBotSettingsLink = null;
  const section = linkedSection();
  if (section) { useConfigUI.getState().openAppSettings(section); return; }
  const bot = linkedBotSettings();
  const ui = useConfigUI.getState();
  const guarded = (next: () => void) => {
    if (!ui.requestLeaveBotSettings(next) && ui.botSettings) replaceHash(botSettingsHash(ui.botSettings.botId, ui.botSettings.tab));
  };
  if (bot) {
    // A deep link must uncover its destination, including any unsaved-draft guard.
    const open = () => ui.openBotSettings(bot.botId, bot.tab);
    if (ui.botSettings && ui.botSettings.botId !== bot.botId) guarded(open);
    else open();
    return;
  }
  if (botSettingsLink()) { pendingBotSettingsLink = window.location.hash; return; }
  const work = linkedWork(window.location.hash);
  if (work) { guarded(() => {
    ui.closeAppSettings(); ui.discardBotSettings();
    // Back/Forward and address-bar hashes already created the destination entry.
    // Mark the phone pane directly so setView does not push over Forward history.
    if (useStore.getState().mobile) useStore.getState().set({ mobilePane: 'chat' });
    ui.setWorkRoute(work); ui.setView('tasks');
  }); return; }
  if (!window.location.hash) guarded(() => {
    ui.closeAppSettings(); ui.discardBotSettings(); ui.setView('chat');
  });
};
window.addEventListener('hashchange', restoreLinkedPage);
useStore.subscribe((state, previous) => {
  if (previous.user && state.user?.id !== previous.user.id) {
    pendingBotSettingsLink = null;
    if (linkedWork(window.location.hash) || /^#bot\//.test(window.location.hash)) replaceHash('');
    useConfigUI.setState({ workRoute: { tab: 'Tasks' }, view: 'chat', botSettings: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null });
    return;
  }
  if (state.bots !== previous.bots) {
    const bot = linkedBotSettings();
    if (bot && pendingBotSettingsLink === window.location.hash) restoreLinkedPage();
    else if (bot && useConfigUI.getState().botSettings?.botId === bot.botId) useConfigUI.getState().openBotSettings(bot.botId, bot.tab);
    const work = linkedWork(window.location.hash);
    if (work) useConfigUI.getState().setWorkRoute(work);
  }
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

// Explicit conversation navigation below restores chat. Loading the saved selection
// must not dismiss a Goals or Reports deep link during startup.

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
