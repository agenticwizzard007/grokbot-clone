import { useCallback, useEffect, useRef, useState } from 'react';
import { agentWidgetResultSchema, type AgentWidgetSnapshot, type UiWidgetEvent, type WidgetAction } from '@shared/ui-config';
import { useStore } from '../../store';
import { widgetRoute } from './model';
const cache = new Map<string, AgentWidgetSnapshot>();
export function useAgentWidget(dashboardId: string, widgetId: string) {
  const account = useStore(state => state.user?.id), key = JSON.stringify([account, dashboardId, widgetId]);
  const [snapshot, setSnapshot] = useState<AgentWidgetSnapshot | undefined>(() => cache.get(key));
  const [error, setError] = useState(''), [loading, setLoading] = useState(!snapshot), [running, setRunning] = useState(false);
  const visible = useRef(true);
  const alive = useRef(false), sequence = useRef(0), runLock = useRef(false), controllers = useRef(new Set<AbortController>());
  const request = useCallback(async (kind: 'result' | 'run' | 'action', body?: unknown) => {
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(widgetRoute(kind, dashboardId, widgetId), { method: kind === 'result' ? 'GET' : 'POST', credentials: 'include', signal: controller.signal,
        ...(kind !== 'result' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) });
      if (!response.ok) throw new Error(response.status === 429 ? 'Run limit reached. Try again later.' : 'Could not update this widget. Try again.');
      return await response.json();
    } finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }, [dashboardId, widgetId]);
  const accept = useCallback((next: AgentWidgetSnapshot) => {
    if (next.dashboardId !== dashboardId || next.widgetId !== widgetId || !['empty', 'running', 'ready', 'error'].includes(next.state)) throw new Error('Could not read the answer. Try again.');
    if (next.doc) { const parsed = agentWidgetResultSchema.safeParse(next.doc); if (!parsed.success) throw new Error('Could not read the answer. Try again.'); next = { ...next, doc: parsed.data }; }
    if (alive.current && useStore.getState().user?.id === account) { cache.set(key, next); setSnapshot(next); }
  }, [account, key, dashboardId, widgetId]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try { const next = await request('result'); if (version === sequence.current) { accept(next); if (alive.current) setError(''); } }
    catch (e) { if (alive.current && version === sequence.current) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Could not load this widget. Try again.'); }
    finally { if (alive.current) setLoading(false); }
  }, [request, accept]);
  useEffect(() => {
    alive.current = true; setSnapshot(cache.get(key)); setError(''); setLoading(!cache.has(key));
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
    const timer = setInterval(() => { if (!document.hidden && visible.current && !runLock.current) void refresh(); }, snapshot?.state === 'running' ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [snapshot?.state, refresh]);
  const run = async () => {
    if (runLock.current || snapshot?.state === 'running') return;
    runLock.current = true; sequence.current++; setRunning(true); setError('');
    try { accept(await request('run')); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not run this widget. Try again.'); }
    finally { runLock.current = false; if (alive.current) setRunning(false); }
  };
  const action = async (action: WidgetAction, confirm?: boolean) => { await request('action', { action, ...(confirm ? { confirm: true } : {}) }); };
  return { snapshot, loading, error, run, refresh, action, running: running || snapshot?.state === 'running' };
}
