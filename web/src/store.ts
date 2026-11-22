import './lib/legacy-storage'; // before reading saved preferences
import { create } from 'zustand';
import type { Bot, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@shared/types';
import { api } from './lib/api';
import { noteRowsEvent } from './lib/sseWatchdog';
import { readDetailsDefault } from './lib/detailsDefault';

export type ModalKind = 'create' | 'search' | 'apps' | 'group' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  /** Google sign-in needs Composio on the server. */
  googleLogin: boolean;
  appleLogin: boolean;
  appleLinked: boolean;
  googleLinked: boolean;
  authChecked: boolean;

  bots: Bot[];
  botsLoaded: boolean;
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Bumped on every `connections` event so open views can refetch. */
  connectionsVersion: number;
  sseConnected: boolean;

  detailsOpen: boolean;
  sidebarCollapsed: boolean;
  /** Phone layout (narrow screens): one pane at a time, the Bot list or a chat. */
  mobile: boolean;
  mobilePane: 'list' | 'chat';
  modal: ModalKind;
  viewerOpen: boolean;
  /** Open the viewer straight in Take control (a "solve this on my screen" link: /?screen=<botId>). */
  viewerControl: boolean;

  checkAuth(): Promise<void>;
  loadBots(): Promise<void>;
  /** Select a Bot. `open: false` selects without navigating (phones stay on the list). */
  selectBot(id: string, opts?: { open?: boolean }): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'swarm.selectedBot';
let computerRequest = 0;

type InlineSetup = 'create' | 'group';
type SetupHistory = { page: InlineSetup; depth: 1 | 2; accountId: string; documentStart: number };
const isInlineSetup = (modal: ModalKind): modal is InlineSetup => modal === 'create' || modal === 'group';
let setupTraversal: 'back' | 'close' | undefined;

function setupEntry(accountId: string | undefined): SetupHistory | undefined {
  const entry = history.state?.swarmSetup as SetupHistory | undefined;
  return accountId && entry?.accountId === accountId && entry.documentStart === performance.timeOrigin
    && isInlineSetup(entry.page) && (entry.depth === 1 || entry.depth === 2) ? entry : undefined;
}

/** Same breakpoints as styles/mobile.css. */
export const PHONE_QUERY = '(max-width: 760px)';
const matches = (q: string) => typeof window !== 'undefined' && window.matchMedia?.(q).matches === true;
const IS_PHONE = () => matches(PHONE_QUERY);
const LS_SIDEBAR = 'swarm.sidebarCollapsed';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  googleLogin: true,
  appleLogin: false,
  appleLinked: false,
  googleLinked: false,
  authChecked: false,
  bots: [],
  botsLoaded: false,
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  connectionsVersion: 0,
  sseConnected: false,
  // Setup now owns the main pane; the old side-column preference must not replace the initial chat.
  detailsOpen: false,
  sidebarCollapsed: lsGet(LS_SIDEBAR) === '1',
  mobile: IS_PHONE(),
  mobilePane: 'list',
  modal: null,
  viewerOpen: false,
  viewerControl: false,

  async checkAuth() {
    try {
      const { user, devLogin, googleLogin, googleLinked, appleLogin, appleLinked } = await api.me();
      set({ user, devLogin, googleLogin: googleLogin !== false, appleLogin: !!appleLogin, appleLinked: !!appleLinked, googleLinked: !!googleLinked, authChecked: true });
      syncBrowserTimezone(user);
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  async loadBots() {
    const accountId = get().user?.id;
    if (!accountId) return;
    const firstLoad = !get().botsLoaded;
    const { bots, live } = await api.bots();
    if (get().user?.id !== accountId) return;
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, botsLoaded: true, live: liveMap });
    // A link from a Bot ("solve this on my screen"): open that Bot's screen, ready to take control.
    const linked = new URLSearchParams(location.search).get('screen');
    if (linked && bots.some((b) => b.id === linked)) {
      history.replaceState(null, '', location.pathname);
      get().selectBot(linked);
      set({ viewerOpen: true, viewerControl: true });
      return;
    }
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId, { open: false });
    }
    // R2F-015: the chat restored after a reload follows "Open Bot details with each chat" too (never on phones).
    if (firstLoad && selectedBotId && !get().mobile && readDetailsDefault(accountId)) set({ detailsOpen: true });
  },

  selectBot(id, opts = {}) {
    if (opts.open !== false) enterChatPane();
    // Bot details follow the saved "Open Bot details with each chat" preference (never on phones).
    set({ selectedBotId: id, ...(opts.open !== false ? { detailsOpen: !get().mobile && readDetailsDefault(get().user?.id) } : {}) });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    const bot = get().bots.find((b) => b.id === id);
    if (!t?.loaded || (bot && t.generation < bot.generation)) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    if (bot?.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const accountId = get().user?.id;
    if (!accountId || !get().bots.some(bot => bot.id === id)) return;
    const { generation, rows } = await api.rows(id);
    const state = get();
    const bot = state.bots.find(candidate => candidate.id === id);
    const prev = state.transcripts[id];
    if (state.user?.id !== accountId || !bot || generation < (bot.generation ?? 0) || (prev && generation < prev.generation)) return;
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env?.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const userId = get().user?.id;
    if (!userId) return;
    const request = ++computerRequest;
    const previous = get().computer;
    const { computer } = await api.computer();
    // A delayed snapshot must not replace a newer live event or another account's state.
    if (request === computerRequest && get().user?.id === userId && get().computer === previous) set({ computer });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      const botGeneration = s.bots.find(bot => bot.id === botId)?.generation;
      if (generation < (botGeneration ?? 0) || (prev && generation < prev.generation)) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  handleEvent(ev) {
    const s = get();
    // Time zone changes (PATCH /api/auth/me) refresh synopses; picked up by configStore.ts like the topics below.
    if ((ev as { type: string }).type === 'synopses') { window.dispatchEvent(new CustomEvent('swarm:event', { detail: ev })); return; }
    switch (ev.type) {
      case 'hello':
      case 'ping':
        return;
      case 'rows':
        noteRowsEvent(ev.botId);
        s.upsertRows(ev.botId, ev.generation, ev.rows);
        return;
      case 'cleared':
        set((st) => {
          const botGeneration = st.bots.find(bot => bot.id === ev.botId)?.generation;
          if (ev.generation < (botGeneration ?? 0) || (st.transcripts[ev.botId]?.generation ?? -1) >= ev.generation) return {};
          return { transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } } };
        });
        return;
      case 'live':
        set((st) => ({ live: { ...st.live, [ev.state.botId]: ev.state } }));
        return;
      case 'roster':
        s.loadBots().catch(console.error);
        return;
      case 'bot': {
        const exists = s.bots.some((b) => b.id === ev.bot.id);
        // Opening a bot marks it read; keep the open bot at 0 unread.
        if (ev.bot.id === s.selectedBotId && ev.bot.unread > 0 && document.visibilityState === 'visible') api.markRead(ev.bot.id).catch(() => {});
        set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...st.bots, ev.bot] }));
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'native':
      case 'tasks':
      case 'memories':
      case 'setup':
      case 'messaging':
        // Picked up by configStore.ts (Tasks view, Library/Tasks tabs, bot settings).
        window.dispatchEvent(new CustomEvent('swarm:event', { detail: ev }));
        return;
      case 'connections':
        set((st) => ({ connectionsVersion: st.connectionsVersion + 1 }));
        return;
    }
  },

  setModal(modal) {
    const state = get();
    const accountId = state.user?.id;
    const entry = setupEntry(accountId);
    if (setupTraversal === 'back') return;
    if (isInlineSetup(modal) && state.mobile && accountId && !setupTraversal) {
      if (entry?.page === modal) { set({ modal }); return; }
      if (entry?.page === 'group' && entry.depth === 2 && modal === 'create') { setupTraversal = 'back'; history.back(); return; }
      const setup: SetupHistory = { page: modal, depth: entry?.page === 'create' ? 2 : 1, accountId, documentStart: performance.timeOrigin };
      const next = { ...history.state, swarmSetup: setup };
      if (entry && setup.depth === 1) history.replaceState(next, '');
      else history.pushState(next, '');
    } else if (!isInlineSetup(modal) && isInlineSetup(state.modal) && entry && !setupTraversal) {
      setupTraversal = 'close';
      history.go(-entry.depth);
    }
    set({ modal });
  },

  set(p) {
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    set(p);
  },
}));

/** MF-017: an account without a time zone adopts the browser's, so synopses and check-ins run at local time. */
export function browserTimezone(): string | null {
  try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone && zone !== 'Etc/Unknown' ? zone : null; } catch { return null; }
}
function syncBrowserTimezone(user: User | null) {
  const current = (user as (User & { timezone?: string | null }) | null)?.timezone;
  if (!user || (current !== null && current !== undefined && current !== '')) return;
  // Older servers omit the field entirely; only send when the server reports it as unset.
  if (current === undefined) return;
  const timezone = browserTimezone();
  if (!timezone) return;
  api.updateMe({ timezone }).then(result => {
    const state = useStore.getState();
    if (state.user?.id !== user.id) return;
    state.set({ user: { ...(result?.user ?? state.user), timezone } as User });
  }).catch(() => { /* try again next boot */ });
}

/** Phones: opening a chat (or Tasks) is a navigation, so the system back gesture returns to the list. */
export function enterChatPane() {
  const st = useStore.getState();
  if (!st.mobile || st.mobilePane === 'chat') return;
  // R2F-007: mark the entry as opened from the list, so Back may only walk history when the list is behind it.
  if (setupTraversal !== 'close') history.pushState({ swarmPane: 'chat', swarmFrom: 'list', swarmDoc: performance.timeOrigin }, '');
  st.set({ mobilePane: 'chat' });
}

/** The page shell resets its own view (Tasks, Goals, Reports) when the phone returns to the list. */
const listListeners = new Set<() => void>();
export function onReturnToList(listener: () => void): () => void {
  listListeners.add(listener);
  return () => { listListeners.delete(listener); };
}
export function showPhoneList() {
  useStore.getState().set({ mobilePane: 'list', detailsOpen: false });
  listListeners.forEach(listener => listener());
}

export function restorePhoneSetup() {
  const st = useStore.getState();
  const traversal = setupTraversal;
  setupTraversal = undefined;
  if (traversal === 'close') {
    if (st.mobile && st.mobilePane === 'chat' && history.state?.swarmPane !== 'chat') history.pushState({ swarmPane: 'chat' }, '');
    if (isInlineSetup(st.modal) && st.mobile) st.setModal(st.modal);
    return true;
  }
  if (!st.mobile && !traversal) return false;
  const entry = setupEntry(st.user?.id);
  if (!entry && !isInlineSetup(st.modal)) return false;
  st.set({ modal: entry?.page ?? null, ...(st.mobile ? { mobilePane: history.state?.swarmPane === 'chat' ? 'chat' : 'list' } : {}) });
  return true;
}

/** Phones: leave a chat (or Tasks) for the Bot list, as the system back gesture would. */
export function backToList() {
  const state = history.state as { swarmPane?: string; swarmFrom?: string; swarmDoc?: number; swarmSetup?: unknown } | null;
  // R2F-007: history.back() only when the entry behind this one is known to be the list. Any other entry
  // (Goals, Settings, an older chat) would be shown instead, so otherwise switch panes and drop the marker.
  const listBehind = !setupTraversal && state?.swarmPane === 'chat' && state.swarmFrom === 'list' && state.swarmDoc === performance.timeOrigin && !state.swarmSetup;
  showPhoneList();
  if (listBehind) history.back();
  else if (!setupTraversal && state?.swarmPane === 'chat') history.replaceState({ ...state, swarmPane: undefined, swarmFrom: undefined }, '');
}

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
