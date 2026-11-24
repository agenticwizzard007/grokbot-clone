import type { ServerEvent } from '@shared/types';
import { useStore } from '../store';
import { createSseWatchdog } from './sseWatchdog';
import { revalidateSession, sessionExpired } from './session';

/**
 * One EventSource for the whole app. Check the session before retrying a failed stream,
 * then reconnect with backoff and resync on reconnect.
 */
export function startEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needsResync = false;

  const resync = () => {
    const st = useStore.getState();
    st.loadBots({ silent: true }).catch(() => {});
    st.loadComputer().catch(() => {});
    const cached = new Set([...Object.keys(st.transcripts), ...Object.keys(st.routines)]);
    if (st.selectedBotId) cached.add(st.selectedBotId);
    for (const id of cached) {
      st.loadRows(id, { resync: true }).catch(() => {});
      st.loadRoutines(id).catch(() => {});
    }
    // Refresh subscribers to invalidations that may have arrived during the gap.
    st.handleEvent({ type: 'connections' });
    st.handleEvent({ type: 'messaging' });
    st.handleEvent({ type: 'synopses' });
    st.handleEvent({ type: 'native', cursor: 0 });
    for (const bot of st.bots) {
      for (const type of ['tasks', 'memories', 'setup'] as const) st.handleEvent({ type, botId: bot.id });
    }
  };

  const open = () => {
    if (stopped || sessionExpired()) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    let openedAt = Date.now();
    let reconnecting = false;
    es = source;
    source.onopen = () => {
      if (stopped || sessionExpired() || es !== source) return;
      watchdog.beat();
      openedAt = Date.now();
      useStore.getState().set({ sseConnected: true });
      if (needsResync) resync();
      needsResync = true;
    };
    source.onmessage = (m) => {
      if (stopped || sessionExpired() || es !== source) return;
      watchdog.beat();
      try {
        const event = JSON.parse(m.data) as ServerEvent;
        // A proxy can accept headers/hello, then immediately reset the stream.
        // Keep backoff until a heartbeat interval of actual delivery has survived.
        if (Date.now() - openedAt >= 10_000) retry = 1000;
        useStore.getState().handleEvent(event);
      } catch (e) { console.warn('bad event', e); }
    };
    source.onerror = async () => {
      if (stopped || sessionExpired() || es !== source || reconnecting) return;
      reconnecting = true;
      needsResync = true;
      useStore.getState().set({ sseConnected: false });
      source.close();
      if (!await revalidateSession()) { stop(); return; }
      if (stopped || es !== source) return;
      es = null;
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 15_000);
    };
  };
  const resume = () => {
    if (stopped || sessionExpired() || document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    es?.close();
    resync();
    open();
  };
  // No event (pings included) for 45 s: the stream is stuck, so reconnect and resync even if hidden.
  const watchdog = createSseWatchdog(() => {
    if (stopped || sessionExpired()) return;
    needsResync = true;
    clearTimeout(timer);
    es?.close(); es = null;
    useStore.getState().set({ sseConnected: false });
    open(); // onopen resyncs rows, Bots and the computer
  });
  watchdog.start();
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('swarm:resume', resume);
  open();
  function stop() {
    stopped = true; clearTimeout(timer); es?.close(); watchdog.stop();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('swarm:resume', resume);
  }
  return stop;
}
