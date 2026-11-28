import { useEffect } from 'react';
import { create } from 'zustand';
import type { PlanUsageSummary } from '@shared/plan-usage-types';
import { api } from './api';
import { useStore } from '../store';

type State = { account?: string; summary: PlanUsageSummary | null; loading: boolean; error: boolean };
const usage = create<State>(() => ({ summary: null, loading: false, error: false }));
let consumers = 0, queued = false;
let request: AbortController | undefined;

/** Coalesce invalidations, including a charge arriving while a read is in flight. */
export async function refreshPlanUsage() {
  const account = useStore.getState().user?.id;
  if (!account || !consumers) return;
  if (request) { queued = true; return; }
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  usage.setState({ account, loading: true });
  const current = () => request === controller && useStore.getState().user?.id === account;
  try {
    const summary = await api.usageSummary(controller.signal);
    if (!summary.plan || !summary.ownKeys) throw new Error('Usage unavailable');
    if (current()) usage.setState({ summary, error: false });
  } catch {
    if (current()) usage.setState({ error: true });
  } finally {
    clearTimeout(timeout);
    if (request === controller) {
      request = undefined;
      usage.setState({ loading: false });
      if (queued) { queued = false; void refreshPlanUsage(); }
    }
  }
}

function subscribe() {
  const reset = () => {
    request?.abort(); request = undefined; queued = false;
    usage.setState({ account: useStore.getState().user?.id, summary: null, loading: false, error: false });
    void refreshPlanUsage();
  };
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) reset();
    else if (state.connectionsVersion !== previous.connectionsVersion || Object.entries(state.live).some(([id, live]) => previous.live[id]?.isRunning && !live.isRunning)) void refreshPlanUsage();
  });
  const event = (event: Event) => {
    if (['usage', 'reconnect', 'synopses'].includes((event as CustomEvent).detail?.type)) void refreshPlanUsage();
  };
  const visible = () => { if (document.visibilityState === 'visible') void refreshPlanUsage(); };
  window.addEventListener('swarm:event', event);
  window.addEventListener('focus', visible);
  document.addEventListener('visibilitychange', visible);
  // Re-read at calendar resets and CLI observation expiry, even without a run.
  const timer = setInterval(visible, 30_000);
  reset();
  return () => {
    unsubscribe(); clearInterval(timer);
    window.removeEventListener('swarm:event', event);
    window.removeEventListener('focus', visible);
    document.removeEventListener('visibilitychange', visible);
    request?.abort(); request = undefined; queued = false;
    usage.setState({ summary: null, loading: false, error: false });
  };
}
let unsubscribe: (() => void) | undefined;
export function usePlanUsage() {
  const account = useStore(s => s.user?.id);
  const state = usage();
  useEffect(() => {
    if (++consumers === 1) unsubscribe = subscribe();
    return () => { if (--consumers === 0) { unsubscribe?.(); unsubscribe = undefined; } };
  }, []);
  return { summary: state.account === account ? state.summary : null, error: state.account === account && state.error, loading: state.loading, refresh: refreshPlanUsage };
}
