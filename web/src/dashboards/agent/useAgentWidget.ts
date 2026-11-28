import { useCallback, useEffect, useRef, useState } from 'react';
import { agentWidgetResultSchema, type AgentWidgetSnapshot, type UiWidgetEvent, type WidgetAction } from '@shared/ui-config';
import { useStore } from '../../store';
import { widgetRoute } from './model';
const cache = new Map<string, AgentWidgetSnapshot>();
export function useAgentWidget(dashboardId: string, widgetId: string) {
  const account = useStore(state => state.user?.id), key = JSON.stringify([account, dashboardId, widgetId]);
  const snapshotKey = useRef(key);
  const [snapshot, setSnapshot] = useState<AgentWidgetSnapshot | undefined>(() => cache.get(key));
  const [error, setError] = useState(''), [loading, setLoading] = useState(!snapshot), [running, setRunning] = useState(false);
  const visible = useRef(true);
  const alive = useRef(false), sequence = useRef(0), runLock = useRef(false), controllers = useRef(new Set<AbortController>());
  const awaitingAnswer = useRef(false);
  const request = useCallback(async (kind: 'result' | 'run' | 'action', body?: unknown) => {
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(widgetRoute(kind, dashboardId, widgetId), { method: kind === 'result' ? 'GET' : 'POST', credentials: 'include', signal: controller.signal,
        ...(kind !== 'result' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(typeof failure?.message === 'string' ? failure.message : response.status === 429 ? 'Run limit reached. Try again later.' : 'Could not update this widget. Try again.');
      }
      return await response.json();
    } finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }, [dashboardId, widgetId]);
  const accept = useCallback((next: AgentWidgetSnapshot) => {
    if (next.dashboardId !== dashboardId || next.widgetId !== widgetId || !['empty', 'running', 'ready', 'error'].includes(next.state)) throw new Error('Could not read the answer. Try again.');
    if (next.doc) { const parsed = agentWidgetResultSchema.safeParse(next.doc); if (!parsed.success) throw new Error('Could not read the answer. Try again.'); next = { ...next, doc: parsed.data }; }
    if (alive.current && useStore.getState().user?.id === account) { if (cache.size >= 192 && !cache.has(key)) cache.delete(cache.keys().next().value!); cache.set(key, next); snapshotKey.current = key; setSnapshot(next); }
  }, [account, key, dashboardId, widgetId]);
  const refresh = useCallback(async () => {
    // A completion event can beat the POST response. Read after POST settles so
    // its initial running snapshot cannot overwrite the completed answer.
    if (runLock.current) return;
    const version = ++sequence.current;
    try { const next = await request('result'); if (version === sequence.current) {
      if (awaitingAnswer.current && next.state === 'empty') return;
      accept(next);
      if (alive.current) {
        setError('');
        if (next.state === 'ready' || next.state === 'error') { awaitingAnswer.current = false; setRunning(false); }
      }
    } }
    catch (e) { if (alive.current && version === sequence.current) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Could not load this widget. Try again.'); }
    finally { if (alive.current) setLoading(false); }
  }, [request, accept]);
  useEffect(() => {
    alive.current = true; awaitingAnswer.current = false; runLock.current = false; setRunning(false); snapshotKey.current = key; setSnapshot(cache.get(key)); setError(''); setLoading(!cache.has(key));
    void refresh();
    const event = (event: Event) => { if (document.hidden || !visible.current) return; const detail = (event as CustomEvent<UiWidgetEvent | { type: 'reconnect' }>).detail; if (detail?.type === 'reconnect' || (detail?.type === 'ui_widget' && detail.dashboardId === dashboardId && detail.widgetId === widgetId)) void refresh(); };
    const onVisibility = () => { if (!document.hidden && visible.current) void refresh(); };
    const observer = new IntersectionObserver(entries => { const wasVisible = visible.current; visible.current = entries.some(entry => entry.isIntersecting); if (!wasVisible && visible.current && !document.hidden) void refresh(); });
    const node = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`); if (node) observer.observe(node);
    window.addEventListener('swarm:event', event); window.addEventListener('swarm:widget', event); document.addEventListener('visibilitychange', onVisibility);
    return () => { alive.current = false; sequence.current++; controllers.current.forEach(controller => controller.abort()); observer.disconnect(); window.removeEventListener('swarm:event', event); window.removeEventListener('swarm:widget', event); document.removeEventListener('visibilitychange', onVisibility); };
  }, [key, refresh, dashboardId, widgetId]);
  useEffect(() => {
    // Poll while running, and recover if a scheduled completion's SSE was missed.
    const timer = setInterval(() => { if (!document.hidden && visible.current && !runLock.current) void refresh(); }, running || snapshot?.state === 'running' ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [running, snapshot?.state, refresh]);
  const run = async () => {
    if (runLock.current || snapshot?.state === 'running') return;
    runLock.current = true; awaitingAnswer.current = true; sequence.current++; setRunning(true); setError('');
    try { accept(await request('run')); }
    catch (e) { awaitingAnswer.current = false; if (alive.current) { setRunning(false); setError(e instanceof Error ? e.message : 'Could not run this widget. Try again.'); } }
    finally { runLock.current = false; if (alive.current && awaitingAnswer.current) void refresh(); }
  };
  const action = async (action: WidgetAction, confirm?: boolean) => { await request('action', { action, ...(confirm ? { confirm: true } : {}) }); if (!alive.current || useStore.getState().user?.id !== account) throw new Error('This account is no longer active.'); };
  return { snapshot: snapshotKey.current === key ? snapshot : undefined, loading: snapshotKey.current !== key || loading, error, run, refresh, action, running: running || snapshot?.state === 'running' };
}
