import { create } from 'zustand';
import type { Bot, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@shared/types';
import { api } from './lib/api';

export type ModalKind = 'create' | 'search' | 'apps' | 'group' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  /** Google sign-in needs Composio on the server. */
  googleLogin: boolean;
  authChecked: boolean;

  bots: Bot[];
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
const LS_DETAILS = 'swarm.detailsOpen';

/** Same breakpoints as styles/mobile.css. */
export const PHONE_QUERY = '(max-width: 760px)';
/** Phones and tablets: the details panel covers the chat instead of taking a column. */
const OVERLAY_QUERY = '(max-width: 1100px)';
const matches = (q: string) => typeof window !== 'undefined' && window.matchMedia?.(q).matches === true;
const IS_PHONE = () => matches(PHONE_QUERY);
const DETAILS_OVERLAY = () => matches(OVERLAY_QUERY);
const LS_SIDEBAR = 'swarm.sidebarCollapsed';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  googleLogin: true,
  authChecked: false,
  bots: [],
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  connectionsVersion: 0,
  sseConnected: false,
  // Where the details panel covers the chat (phones, tablets) it starts closed, whatever the desktop preference.
  detailsOpen: !DETAILS_OVERLAY() && lsGet(LS_DETAILS) !== '0',
  sidebarCollapsed: lsGet(LS_SIDEBAR) === '1',
  mobile: IS_PHONE(),
  mobilePane: 'list',
  modal: null,
  viewerOpen: false,

  async checkAuth() {
    try {
      const { user, devLogin, googleLogin } = await api.me();
      set({ user, devLogin, googleLogin: googleLogin !== false, authChecked: true });
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  async loadBots() {
    const { bots, live } = await api.bots();
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, live: liveMap });
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId, { open: false });
    }
  },

  selectBot(id, opts = {}) {
    if (opts.open !== false) enterChatPane();
    set({ selectedBotId: id });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    const bot = get().bots.find((b) => b.id === id);
    if (bot?.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const { generation, rows } = await api.rows(id);
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    const prev = get().transcripts[id];
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const { computer } = await api.computer();
    set({ computer });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
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
    switch (ev.type) {
      case 'hello':
      case 'ping':
        return;
      case 'rows':
        s.upsertRows(ev.botId, ev.generation, ev.rows);
        return;
      case 'cleared':
        set((st) => ({ transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } } }));
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

  setModal(modal) { set({ modal }); },

  set(p) {
    // The phone/tablet details overlay is transient; don't let it change the desktop preference.
    if (p.detailsOpen !== undefined && !DETAILS_OVERLAY()) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    set(p);
  },
}));

/** Phones: opening a chat (or Tasks) is a navigation, so the system back gesture returns to the list. */
export function enterChatPane() {
  const st = useStore.getState();
  if (!st.mobile || st.mobilePane === 'chat') return;
  history.pushState({ swarmPane: 'chat' }, '');
  st.set({ mobilePane: 'chat' });
}

/** Phones: leave a chat (or Tasks) for the Bot list, as the system back gesture would. */
export function backToList() {
  const st = useStore.getState();
  if (history.state?.swarmPane === 'chat') history.back();
  else st.set({ mobilePane: 'list', detailsOpen: false });
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
