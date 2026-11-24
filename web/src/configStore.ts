import './lib/legacy-storage'; // before reading saved preferences
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { APP_SECTIONS, backLabel, backTarget, outsideSurface, navigationActions, parseScreen, resolveScreen, screenHash, ScreenHistory, type Screen, type DetailTab, type SetupTab } from './lib/navigation';
import { readDetailsDefault } from './lib/detailsDefault';
import { botSlug, routeBot, linkedWork, type WorkRoute } from './lib/userRoutes';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';
export type { AppSection, BotSettingsTab } from './lib/navigation';
import type { AppSection, BotSettingsTab } from './lib/navigation';

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
  detailsTab: DetailTab;
  setupTab: SetupTab;
  detailsReports: boolean;
  setDetailsTab(tab: DetailTab, setup?: SetupTab, reports?: boolean): void;
  showSettingsList(): void;
  /** Published with each applied route so mounted controls follow restored history. */
  backLabel: string;
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
const SECTIONS_LINKABLE = [...APP_SECTIONS];
const linkedSection = (): AppSection | null => {
  const screen = typeof window !== 'undefined' ? parseScreen(window.location.hash) : null;
  return screen?.kind === 'settings' ? screen.section ?? 'general' : null;
};
export const botSettingsHash = (botId: string, tab: BotSettingsTab) => screenHash({ kind: 'bot-settings', bot: botReference(botId), tab });
function botReference(id: string) {
  const bot = useStore.getState().bots.find(bot => bot.id === id);
  return bot ? botSlug(bot) : id;
}
export const hasSettingsLink = () => {
  const screen = parseScreen(window.location.hash);
  return screen?.kind === 'settings' || screen?.kind === 'bot-settings';
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
  botSettings: null,
  botSettingsDrafts: {},
  botSettingsDirty: false,
  botSettingsLeave: null,
  botSettingsDiscards: 0,
  appSettings: initialAppSection,
  subscriptionProvider: null,
  resume: resumed,
  appSettingsHome: /^#settings\/?$/.test(window.location.hash),
  view: typeof window !== 'undefined' && linkedWork(window.location.hash) ? 'tasks' : 'chat',
  workRoute: (typeof window !== 'undefined' && linkedWork(window.location.hash)) || { tab: 'Tasks' },
  detailsTab: 'activity', setupTab: 'responsibilities', detailsReports: false,
  setDetailsTab: (tab, setup, reports) => {
    const id = useStore.getState().selectedBotId;
    if (id) navigation.navigate({ kind: 'details', bot: botReference(id), tab, ...(setup && setup !== 'responsibilities' ? { setup } : {}), ...(reports ? { reports } : {}) });
  },
  showSettingsList: () => navigation.navigate({ kind: 'settings' }),
  backLabel: 'Back to Bots',
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => navigation.navigate({ kind: 'bot-settings', bot: botReference(botId), tab }),
  closeBotSettings: () => {
    backFromSurface();
  },
  discardBotSettings: () => {
    set({ botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null });
    if (get().botSettings) get().closeBotSettings();
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
    if (state.appSettings) set({ appSettings: null });
    const store = useStore.getState();
    if (store.modal === 'search' || store.modal === 'apps') {
      if (navigation.screen?.kind === store.modal) store.setModal(null);
      else useStore.setState({ modal: null });
    }
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
    const mobile = useStore.getState().mobile;
    const current = navigation.screen;
    const normalizeGeneral = !mobile && (section ?? 'general') === 'general' && current?.kind === 'settings' && !current.section;
    navigation.navigate({ kind: 'settings', ...(section || !mobile ? { section: section ?? 'general' } : {}) }, normalizeGeneral ? 'replace' : 'push');
    if (get().appSettings === 'subscriptions') set({ subscriptionProvider: subscriptionProvider ?? null });
  },
  closeAppSettings: () => {
    if (get().appSettings) backFromSurface();
  },
  clearResume: () => set({ resume: null }),
  setView: (view) => {
    if (view === 'tasks') navigation.navigate({ kind: 'work', route: get().workRoute });
    else if (view === 'bots') navigation.navigate({ kind: 'bots' });
    else navigation.navigate(defaultScreen());
  },
  setWorkRoute: (workRoute) => {
    const bot = workRoute.botSlug && routeBot(workRoute.botSlug, useStore.getState().bots);
    const route = bot ? { ...workRoute, botSlug: botSlug(bot) } : workRoute;
    if (get().view === 'tasks' && !get().appSettings && !get().botSettings) navigation.navigate({ kind: 'work', route });
    else set({ workRoute: route });
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

function defaultScreen(): Screen {
  const st = useStore.getState();
  return !st.mobile && st.selectedBotId ? { kind: 'chat', bot: botReference(st.selectedBotId) } : { kind: 'bots' };
}
function returnFallback(screen: Screen | null): Screen {
  if (screen?.kind === 'bot-settings' || screen?.kind === 'details') return { kind: 'chat', bot: screen.bot };
  return defaultScreen();
}
export function returnScreen(screen = navigation.screen, trail = navigation.trail): Screen {
  const target = backTarget(trail, returnFallback(screen), other => !screen || outsideSurface(screen, other)).screen;
  const st = useStore.getState();
  // A deleted Bot or a renamed slug in persisted history must describe the
  // screen that applyScreen will actually show when the control is clicked.
  return resolveScreen(target, st.bots, st.botsLoaded) ?? target;
}
export function returnLabel() { return backLabel(returnScreen()); }
export const useReturnLabel = () => useConfigUI(s => s.backLabel);
function backFromSurface() {
  const current = navigation.screen;
  navigation.back(returnFallback(current), other => !current || outsideSurface(current, other));
}
export function backFromWork() { backFromSurface(); }

export let detailsCaller: HTMLElement | null = null;

function applyScreen(requested: Screen, normalize = true, trail = navigation.trail) {
  const screen = resolveScreen(requested, useStore.getState().bots, useStore.getState().botsLoaded);
  if (!screen) return; // the hash is the pending intent; a newer action replaces it
  if ('bot' in requested && screen.kind === 'bots') useConfigUI.setState({ botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null });
  if (normalize && screenHash(screen) !== window.location.hash) { navigation.navigate(screen, 'replace'); return; }
  const st = useStore.getState(), ui = useConfigUI.getState();
  // Recover the underlying chat/details from the entry on reload, as well as while
  // closing Settings. Keep Details mounted while Bot settings covers it.
  const layered = ['settings', 'bot-settings', 'create', 'group', 'search', 'apps'].includes(screen.kind);
  let base = screen;
  if (layered) {
    base = returnScreen(screen, trail);
    if (['settings', 'bot-settings', 'create', 'group', 'search', 'apps'].includes(base.kind)) {
      base = [...trail].reverse().map(parseScreen).find(value => value && ['chat', 'details', 'work', 'bots'].includes(value.kind)) ?? defaultScreen();
    }
    if (screen.kind === 'bot-settings' && (!('bot' in base) || base.bot !== screen.bot)) base = { kind: 'chat', bot: screen.bot };
  }
  const bot = 'bot' in base ? routeBot(base.bot, st.bots) : undefined;
  if (bot && st.selectedBotId !== bot.id) st.selectBot(bot.id, { open: false });
  if (base.kind === 'details' && !st.detailsOpen) detailsCaller = document.activeElement as HTMLElement | null;
  const settingsBot = screen.kind === 'bot-settings' ? routeBot(screen.bot, st.bots) : undefined;
  const keepDraft = settingsBot && settingsBot.id === ui.botSettings?.botId;
  // Search overlays preserve every underlying surface. Only its own state changes.
  if (screen.kind === 'search' || screen.kind === 'apps') {
    const origin = trail.findLastIndex(hash => { const previous = parseScreen(hash); return previous && outsideSurface(screen, previous); });
    applyScreen(returnScreen(screen, trail), false, origin < 0 ? [] : trail.slice(0, origin));
    useStore.setState({ modal: screen.kind, viewerOpen: false });
    return;
  }
  useConfigUI.setState({
    backLabel: backLabel(returnScreen(screen, trail)),
    view: base.kind === 'work' ? 'tasks' : base.kind === 'bots' ? 'bots' : 'chat',
    ...(base.kind === 'work' ? { workRoute: base.route } : {}),
    ...(base.kind === 'details' ? { detailsTab: base.tab, setupTab: base.setup ?? 'responsibilities', detailsReports: !!base.reports } : {}),
    appSettings: screen.kind === 'settings' ? screen.section ?? 'general' : null,
    appSettingsHome: screen.kind === 'settings' && !screen.section,
    subscriptionProvider: screen.kind === 'settings' && screen.section === 'subscriptions' ? ui.subscriptionProvider : null,
    botSettings: settingsBot && screen.kind === 'bot-settings' ? { botId: settingsBot.id, tab: screen.tab } : null,
    ...(!keepDraft ? { botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null } : {}),
  });
  useStore.setState({ modal: screen.kind === 'create' || screen.kind === 'group' ? screen.kind : null,
    detailsOpen: base.kind === 'details', mobilePane: base.kind === 'bots' ? 'list' : 'chat' });
}

export const navigation = new ScreenHistory(window, () => useStore.getState().user?.id ?? '', applyScreen, (screen, proceed) => {
  const ui = useConfigUI.getState();
  const sameBot = screen.kind === 'bot-settings' && routeBot(screen.bot, useStore.getState().bots)?.id === ui.botSettings?.botId;
  const keepsDrafts = sameBot && (screen.tab === ui.botSettings?.tab || Object.keys(ui.botSettingsDrafts).every(id => id === 'general'));
  if (screen.kind === 'search' || screen.kind === 'apps' || keepsDrafts) { proceed(); return true; }
  return ui.requestLeaveBotSettings(proceed);
});
navigationActions.chat = (id, replace) => {
  const st = useStore.getState();
  const bot = botReference(id);
  navigation.navigate(!st.mobile && readDetailsDefault(st.user?.id) ? { kind: 'details', bot, tab: 'activity' } : { kind: 'chat', bot }, replace ? 'replace' : 'push');
};
navigationActions.details = open => {
  const st = useStore.getState();
  if (!st.selectedBotId) return;
  const bot = botReference(st.selectedBotId);
  if (open) navigation.navigate({ kind: 'details', bot, tab: 'activity' });
  else navigation.back({ kind: 'chat', bot }, screen => screen.kind === 'chat' && screen.bot === bot);
};
navigationActions.list = () => navigation.back({ kind: 'bots' }, screen => screen.kind === 'bots');
navigationActions.modal = modal => {
  if (modal === 'create' && useStore.getState().modal === 'group') navigation.back({ kind: 'create' }, screen => screen.kind === 'create');
  else if (modal) navigation.navigate({ kind: modal });
  else if (useStore.getState().modal) {
    backFromSurface();
  }
};
window.addEventListener('popstate', navigation.restore);
window.addEventListener('hashchange', navigation.restore);
let navigationAccount: string | undefined;
useStore.subscribe((state, previous) => {
  if (previous.user && state.user?.id !== previous.user.id) {
    navigation.reset(); navigationAccount = undefined;
    useConfigUI.setState({ workRoute: { tab: 'Tasks' }, view: 'chat', botSettings: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null });
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return;
  }
  if (!state.user || !state.botsLoaded) return;
  if (navigationAccount !== state.user.id) {
    navigationAccount = state.user.id;
    const settings = useConfigUI.getState().appSettings;
    const fallback: Screen = settings ? { kind: 'settings', section: settings } : defaultScreen();
    navigation.initialize(fallback.kind === 'chat' && readDetailsDefault(state.user.id) ? { kind: 'details', bot: fallback.bot, tab: 'activity' } : fallback);
  } else if (state.bots !== previous.bots) {
    const screen = navigation.screen;
    if (screen) applyScreen(screen);
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
export function openConversation(botId: string) { navigationActions.chat?.(botId); }

/** Registers an unsaved Bot settings draft while `dirty` (R2F-004). `label` names its tab in the dialog. */
export function useBotSettingsDraft(id: string, label: string, dirty: boolean) {
  useEffect(() => {
    useConfigUI.getState().setBotSettingsDraft(id, dirty ? label : null);
    return () => useConfigUI.getState().setBotSettingsDraft(id, null);
  }, [id, label, dirty]);
}
