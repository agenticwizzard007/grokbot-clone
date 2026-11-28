import './lib/legacy-storage'; // before reading saved preferences
import { create } from 'zustand';
import type { Bot, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@shared/types';
import { api, INITIAL_ROW_PAGE_SIZE, ROW_PAGE_SIZE } from './lib/api';
import { noteRowsEvent } from './lib/sseWatchdog';
import { readDetailsDefault } from './lib/detailsDefault';
import { requireActiveSession, sessionExpired } from './lib/session';
import { navigationActions } from './lib/navigation';
import { suggestionCache } from './lib/suggestionCache';
import { confirmedApprovals, withKnownStepApproval, type ApprovalDecisions } from './lib/stepApproval';

export type ModalKind = 'create' | 'search' | 'apps' | 'group' | null;

/** A delayed roster or Bot event cannot reopen a setup that was already skipped. */
function withLatestSetup(incoming: Bot, current?: Bot): Bot {
  return (current?.onboarding?.revision ?? 0) > (incoming.onboarding?.revision ?? 0)
    ? { ...incoming, onboarding: current!.onboarding } : incoming;
}

interface Transcript {
  generation: number; bySeq: Record<number, Row>; loaded: boolean;
  loading?: boolean;
  error?: string | null;
  /** Oldest fetched page boundary, independent of rows arriving over SSE. Null means complete. */
  olderCursor?: number | null;
  loadingOlder?: boolean;
  olderError?: string | null;
  /** Server revision of the last fully reconciled snapshot. SSE does not advance it. */
  revision?: number;
}

interface State {
  user: User | null;
  devLogin: boolean;
  /** Google sign-in needs Composio on the server. */
  platform: boolean;
  googleLogin: boolean;
  appleLogin: boolean;
  appleLinked: boolean;
  googleLinked: boolean;
  /** A successful lookup has confirmed the current session or sign-out. */
  authChecked: boolean;
  authChecking: boolean;
  authError: string | null;

  bots: Bot[];
  botsLoaded: boolean;
  botsLoading: boolean;
  botsError: string | null;
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  approvalDecisions: ApprovalDecisions;
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
  loadBots(opts?: { silent?: boolean }): Promise<void>;
  /** Select a Bot. `open: false` selects without navigating (phones stay on the list). */
  selectBot(id: string, opts?: { open?: boolean; replace?: boolean }): void;
  loadRows(id: string, opts?: { resync?: boolean }): Promise<void>;
  loadOlderRows(id: string): Promise<void>;
  ensureRowLoaded(id: string, generation: number, seq: number): Promise<boolean>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  decideApproval(id: string, decision: 'allow' | 'always' | 'deny'): Promise<void>;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'swarm.selectedBot';
let computerRequest = 0;
let accountEpoch = 0;
let rosterRequest = 0;
const rowRequests = new Map<string, number>();
const olderRequests = new Map<string, Promise<void>>();

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
  platform: false,
  googleLogin: true,
  appleLogin: false,
  appleLinked: false,
  googleLinked: false,
  authChecked: false,
  authChecking: false,
  authError: null,
  bots: [],
  botsLoaded: false,
  botsLoading: false,
  botsError: null,
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  approvalDecisions: {},
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
    if (get().authChecking) return;
    set({ authChecking: true });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Session check timed out'));
          controller.abort();
        }, 5000);
      });
      // Race the whole lookup, including its body, even if cancellation is ignored.
      // A late result cannot settle this race again or overwrite a later retry.
      const { user, devLogin, platform, googleLogin, googleLinked, appleLogin, appleLinked } = await Promise.race([api.me(controller.signal), deadline]);
      if (sessionExpired()) return;
      if (user !== null && (!user || typeof user.id !== 'string' || !user.id)) throw new Error('Invalid session response');
      set({ user, devLogin, platform: platform === true, googleLogin: googleLogin !== false, appleLogin: !!appleLogin, appleLinked: !!appleLinked, googleLinked: !!googleLinked, authChecked: true, authError: null });
    } catch {
      if (sessionExpired()) return;
      set({ authChecked: false, authError: "We couldn't check your session. Check your connection and try again." });
    } finally {
      clearTimeout(timer);
      set({ authChecking: false });
    }
  },

  async loadBots(opts = {}) {
    const accountId = get().user?.id;
    if (!accountId) return;
    const epoch = accountEpoch;
    const request = ++rosterRequest;
    const current = () => get().user?.id === accountId && epoch === accountEpoch && request === rosterRequest;
    set({ botsLoading: true });
    try {
      const firstLoad = !get().botsLoaded;
      const { bots, live } = await api.bots();
      requireActiveSession();
      if (!current()) return;
      const liveMap: Record<string, LiveState> = {};
      for (const l of live) {
        const current = get().live[l.botId];
        liveMap[l.botId] = (current?.revision ?? 0) > (l.revision ?? 0) ? current : l;
      }
      const sel = get().selectedBotId;
      const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
      set(state => ({ bots: bots.map(bot => withLatestSetup(bot, state.bots.find(current => current.id === bot.id))), botsLoaded: true, botsError: null, live: liveMap, selectedBotId }));
      // A link from a Bot ("solve this on my screen"): open that Bot's screen, ready to take control.
      const linked = new URLSearchParams(location.search).get('screen');
      if (linked && bots.some((b) => b.id === linked)) {
        history.replaceState(history.state, '', location.pathname + location.hash);
        get().selectBot(linked, { replace: true });
        set({ viewerOpen: true, viewerControl: true });
        return;
      }
      if (selectedBotId !== sel || !get().transcripts[selectedBotId ?? '']) {
        if (get().selectedBotId) get().selectBot(get().selectedBotId!, { open: false });
      }
      // R2F-015: the chat restored after a reload follows "Open Bot details with each chat" too (never on phones).
      if (firstLoad && !location.hash && selectedBotId && !get().mobile && readDetailsDefault(accountId)) set({ detailsOpen: true });
    } catch {
      requireActiveSession();
      if (current() && !opts.silent) set({ botsError: "Couldn't load your Bots. Check your connection and try again." });
    } finally {
      if (current()) set({ botsLoading: false });
    }
  },

  selectBot(id, opts = {}) {
    if (opts.open !== false && navigationActions.chat) { navigationActions.chat(id, opts.replace); return; }
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

  async loadRows(id, opts = {}) {
    const accountId = get().user?.id;
    if (!accountId || !get().bots.some(bot => bot.id === id)) return;
    const epoch = accountEpoch;
    const botGeneration = get().bots.find(bot => bot.id === id)!.generation ?? 0;
    const previous = get().transcripts[id];
    const expectedGeneration = Math.max(botGeneration, previous?.generation ?? 0);
    const request = (rowRequests.get(id) ?? 0) + 1;
    rowRequests.set(id, request);
    const current = () => {
      const state = get();
      return state.user?.id === accountId && epoch === accountEpoch && rowRequests.get(id) === request
        && state.bots.some(bot => bot.id === id);
    };
    set(s => ({ transcripts: { ...s.transcripts, [id]: {
      ...(previous?.generation === expectedGeneration ? previous : { generation: expectedGeneration, bySeq: {}, loaded: false }),
      loading: true,
    } } }));
    try {
      const latest = await api.rows(id);
      const { generation, rows, revision } = latest;
      requireActiveSession();
      if (!current()) return;
      const valid = () => {
        const state = get(), bot = state.bots.find(candidate => candidate.id === id), transcript = state.transcripts[id];
        return current() && bot && generation >= (bot.generation ?? 0) && (!transcript || generation >= transcript.generation);
      };
      if (!valid()) throw new Error('Outdated transcript');
      const prev = get().transcripts[id];
      const paging = prev?.generation === generation ? prev : undefined;
      const bySeq: Record<number, Row> = { ...paging?.bySeq };
      for (const row of rows) if (!bySeq[row.seq] || bySeq[row.seq].updatedSeq <= row.updatedSeq) bySeq[row.seq] = withKnownStepApproval(row, bySeq[row.seq]);
      const olderCursor = paging?.olderCursor !== undefined && Object.keys(paging.bySeq).length > 0 ? paging.olderCursor : latest.olderCursor !== undefined ? latest.olderCursor
        : rows.length === INITIAL_ROW_PAGE_SIZE || rows.length === ROW_PAGE_SIZE ? rows[0].seq : null;
      const reconcile = previous?.loaded && previous.generation === generation;
      // Publish the latest window before any gap recovery. Keep the last complete
      // watermark if recovery fails, so the next reconnect can retry safely.
      set(s => ({ transcripts: { ...s.transcripts, [id]: { ...paging, generation, bySeq, loaded: true, loading: false, error: null,
        olderCursor, revision: reconcile ? previous.revision : revision } } }));
      if (reconcile && revision !== undefined) {
        let after = previous.revision ?? 0;
        const floor = Object.values(previous.bySeq).reduce((min, row) => Math.min(min, row.seq), rows[0]?.seq ?? Infinity);
        while (after < revision && Number.isFinite(floor)) {
          if (!valid()) return;
          const changes = await api.rowChanges(id, after, revision, floor);
          requireActiveSession();
          if (!valid() || changes.generation !== generation) return;
          const transcript = get().transcripts[id];
          const merged = { ...transcript.bySeq };
          for (const row of changes.rows) if (!merged[row.seq] || merged[row.seq].updatedSeq <= row.updatedSeq) merged[row.seq] = withKnownStepApproval(row, merged[row.seq]);
          set(s => ({ transcripts: { ...s.transcripts, [id]: { ...transcript, bySeq: merged } } }));
          if (changes.nextRev === null) break;
          if (changes.nextRev <= after) throw new Error('Invalid revision page');
          after = changes.nextRev;
        }
        if (valid()) set(s => ({ transcripts: { ...s.transcripts, [id]: { ...s.transcripts[id], revision } } }));
      }
      if (import.meta.env?.DEV && new URLSearchParams(location.search).has('fixtures')) {
        import('./dev/fixtures').then((m) => m.injectFixtures());
      }
    } catch {
      // Ordinary load failures remain retryable, but confirmed expiry must reject.
      requireActiveSession();
      if (current() && get().transcripts[id]?.generation === expectedGeneration) set(s => ({ transcripts: { ...s.transcripts, [id]: {
        ...s.transcripts[id], loading: false, ...(!opts.resync ? { error: "Couldn't load messages. Check your connection and try again." } : {}),
      } } }));
    }
  },

  async loadOlderRows(id) {
    const accountId = get().user?.id;
    const previous = get().transcripts[id];
    const cursor = previous?.olderCursor;
    if (!accountId || !previous?.loaded || cursor == null || !get().bots.some(bot => bot.id === id && bot.generation <= previous.generation)) return;
    const generation = previous.generation;
    const key = `${accountId}:${id}:${generation}:${cursor}`;
    const pending = olderRequests.get(key);
    if (pending) return pending;
    const current = () => {
      const state = get(), transcript = state.transcripts[id];
      return state.user?.id === accountId && state.bots.some(bot => bot.id === id && bot.generation <= generation)
        && transcript?.generation === generation && transcript.olderCursor === cursor ? transcript : undefined;
    };
    const update = (patch: Partial<Transcript>) => {
      const transcript = current();
      if (transcript) set(s => ({ transcripts: { ...s.transcripts, [id]: { ...transcript, ...patch } } }));
    };
    update({ loadingOlder: true, olderError: null });
    const request = (async () => {
      try {
        const page = await api.rows(id, cursor);
        requireActiveSession();
        const transcript = current();
        if (!transcript || page.generation !== generation) return;
        const bySeq = { ...transcript.bySeq };
        for (const row of page.rows) {
          if (!bySeq[row.seq] || row.updatedSeq >= bySeq[row.seq].updatedSeq) bySeq[row.seq] = withKnownStepApproval(row, bySeq[row.seq]);
        }
        update({ bySeq, loadingOlder: false, olderCursor: page.olderCursor !== undefined ? page.olderCursor : page.rows.length === ROW_PAGE_SIZE ? page.rows[0].seq : null });
      } catch (error) {
        update({ olderError: "Couldn't load earlier messages. Try again." });
        throw error;
      } finally {
        update({ loadingOlder: false });
        olderRequests.delete(key);
      }
    })();
    olderRequests.set(key, request);
    return request;
  },

  async ensureRowLoaded(id, generation, seq) {
    const accountId = get().user?.id;
    const valid = () => !!accountId && get().user?.id === accountId
      && get().bots.some(bot => bot.id === id && bot.generation === generation);
    if (!valid()) return false;
    if (!get().transcripts[id]?.loaded || get().transcripts[id].generation < generation) await get().loadRows(id);
    while (valid()) {
      const transcript = get().transcripts[id];
      if (!transcript || transcript.generation !== generation) return false;
      if (transcript.bySeq[seq]) return true;
      const cursor = transcript.olderCursor;
      if (cursor == null || cursor <= seq) return false;
      await get().loadOlderRows(id);
      if (get().transcripts[id]?.olderCursor === cursor) return false;
    }
    return false;
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    requireActiveSession();
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const userId = get().user?.id;
    if (!userId) return;
    const request = ++computerRequest;
    const previous = get().computer;
    const { computer } = await api.computer();
    requireActiveSession();
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
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = withKnownStepApproval(r, cur);
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  async decideApproval(id, decision) {
    if (get().approvalDecisions[id]) return;
    const epoch = accountEpoch;
    const status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
    set(s => ({ approvalDecisions: { ...s.approvalDecisions, [id]: { status, pending: true } } }));
    try {
      const result = await api.approve(id, decision);
      if (epoch !== accountEpoch || !get().approvalDecisions[id]?.pending) return;
      set(s => ({ approvalDecisions: { ...s.approvalDecisions, [id]: { status: !result.status || result.status === 'pending' ? status : result.status } } }));
    } catch {
      if (epoch !== accountEpoch || !get().approvalDecisions[id]?.pending) return;
      set(s => {
        const approvalDecisions = { ...s.approvalDecisions };
        delete approvalDecisions[id];
        return { approvalDecisions };
      });
      throw new Error('Could not save your decision. Please try again.');
    }
  },

  handleEvent(ev) {
    const s = get();
    // SSE can outlive the request that produced it. Only the current turn may
    // alter chat state; transcript snapshots remain the source for older rows.
    const runBotId = ev.runBotId ?? (ev.type === 'rows' ? ev.botId : ev.type === 'live' ? ev.state.botId : undefined);
    const current = runBotId ? s.live[runBotId] : undefined;
    if (ev.type === 'live') {
      if ((ev.state.revision ?? 0) < (current?.revision ?? 0)) return;
    } else if (ev.runId && current?.runId && (ev.runId !== current.runId || !current.isRunning)) return;
    // Time zone changes (PATCH /api/auth/me) refresh synopses; picked up by configStore.ts like the topics below.
    if (ev.type === 'synopses') {
      if (ev.timezone && get().user) set({ user: { ...get().user!, timezone: ev.timezone } as User });
      window.dispatchEvent(new CustomEvent('swarm:event', { detail: ev })); return;
    }
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
        set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === ev.bot.id ? withLatestSetup(ev.bot, b) : b)) : [...st.bots, ev.bot] }));
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'usage':
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
    if (navigationActions.modal) { navigationActions.modal(modal); return; }
    // Search replaces the fullscreen viewer so its inert background cannot cover the dialog.
    set({ modal, ...(modal === 'search' ? { viewerOpen: false } : {}) });
  },

  set(p) {
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    if (!Object.hasOwn(p, 'user') && p.detailsOpen !== undefined && p.detailsOpen !== get().detailsOpen && navigationActions.details) {
      const { detailsOpen, ...rest } = p;
      set(rest); navigationActions.details(detailsOpen); return;
    }
    set(p);
  },
}));

// Invalidate reads even when an account is left and then opened again before they settle.
useStore.subscribe((state, previous) => {
  if (state.authChecked && !previous.authChecked && !state.user) suggestionCache.scope(undefined);
  if (state.user?.id === previous.user?.id) return;
  suggestionCache.scope(state.user?.id);
  accountEpoch++;
  rowRequests.clear();
  useStore.setState({
    approvalDecisions: {},
    botsLoading: false, botsError: null,
    ...(state.bots === previous.bots ? { bots: [], botsLoaded: false } : {}),
    ...(state.transcripts === previous.transcripts ? { transcripts: {} } : {}),
    ...(state.live === previous.live ? { live: {} } : {}),
  });
});

// Cards and steps share one decision on click, HTTP confirmation, snapshots and SSE.
useStore.subscribe((state, previous) => {
  if (state.transcripts === previous.transcripts) return;
  const rows = Object.entries(state.transcripts).flatMap(([id, transcript]) => {
    const prior = previous.transcripts[id]?.bySeq;
    return transcript.bySeq === prior ? [] : Object.values(transcript.bySeq).filter(row => row !== prior?.[row.seq]);
  });
  const approvalDecisions = confirmedApprovals(state.approvalDecisions, rows);
  if (approvalDecisions !== state.approvalDecisions) useStore.setState({ approvalDecisions });
});

// Bot payloads arrive before Settings mounts, including in a browser with no storage.
// Hydrate synchronously so the very first panel render can read the server snapshot.
useStore.subscribe((state, previous) => {
  if (!state.user || state.bots === previous.bots) return;
  suggestionCache.scope(state.user.id);
  for (const bot of state.bots) suggestionCache.seed(bot.id, bot.suggestedApps);
  if (state.user.id === previous.user?.id) {
    for (const bot of previous.bots) if (!state.bots.some(current => current.id === bot.id)) suggestionCache.remove(bot.id);
  }
});

/** Browser zone is a suggestion only. Account changes require an explicit selection. */
export function browserTimezone(): string | null {
  try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone && zone !== 'Etc/Unknown' ? zone : null; } catch { return null; }
}
/** Pane changes are presentation only; screen history is shared at every width. */
export function enterChatPane() { useStore.setState({ mobilePane: 'chat' }); }
export function backToList() {
  if (navigationActions.list) navigationActions.list();
  else useStore.setState({ mobilePane: 'list', detailsOpen: false });
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
