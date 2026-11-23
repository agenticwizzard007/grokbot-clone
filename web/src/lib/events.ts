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
  let everConnected = false;

  const resync = () => {
    const st = useStore.getState();
    st.loadBots().catch(() => {});
    st.loadComputer().catch(() => {});
    if (st.selectedBotId) { st.loadRows(st.selectedBotId).catch(() => {}); st.loadRoutines(st.selectedBotId).catch(() => {}); }
  };

  const open = () => {
    if (stopped || sessionExpired()) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    es = source;
    source.onopen = () => {
      if (stopped || sessionExpired() || es !== source) return;
      watchdog.beat();
      retry = 1000;
      useStore.getState().set({ sseConnected: true });
      if (everConnected) resync();
      everConnected = true;
    };
    source.onmessage = (m) => {
      if (stopped || sessionExpired() || es !== source) return;
      watchdog.beat();
      try { useStore.getState().handleEvent(JSON.parse(m.data) as ServerEvent); } catch (e) { console.warn('bad event', e); }
    };
    source.onerror = async () => {
      if (stopped || sessionExpired() || es !== source) return;
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
    const state = useStore.getState();
    state.set({ connectionsVersion: state.connectionsVersion + 1 });
    open();
  };
  // No event (pings included) for 45 s: the stream is stuck, so reconnect and resync even if hidden.
  const watchdog = createSseWatchdog(() => {
    if (stopped || sessionExpired()) return;
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
