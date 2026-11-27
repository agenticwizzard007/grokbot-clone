import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { sourceKey, widgetSource, type Widget, type WidgetData, type WidgetState } from './model';

const cache = new Map<string, { data: WidgetData; receivedAt: number }>();
let account: string | undefined;
export function useWidgetData(widgets: Widget[]) {
  const userId = useStore(state => state.user?.id);
  const [states, setStates] = useState<Record<string, WidgetState>>({});
  const nodes = useRef(new Map<string, HTMLElement>());
  const actions = useRef<{ observe(id: string, node: HTMLElement | null): void; refresh(id?: string): void }>();
  const signature = JSON.stringify(widgets.map(widget => [widget.id, widgetSource(widget), widget.refreshSec]));
  useEffect(() => {
    if (account !== userId) { cache.clear(); account = userId; }
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined, stream: EventSource | undefined, reconnect = false;
    let retryAt = 0, active = false;
    const visible = new Set<string>(), dirty = new Set<string>(), fresh = new Set<string>();
    const live = new Map<string, string>(), attemptedAt = new Map<string, number>();
    const lastAttempt = (widget: Widget) => Math.max(cache.get(cacheKey(widget))?.receivedAt ?? 0, attemptedAt.get(sourceKey(widget)) ?? 0);
    const current = () => !stopped && account === userId && useStore.getState().user?.id === userId;
    const cacheKey = (widget: Widget) => `${userId}:${sourceKey(widget)}`;
    setStates(Object.fromEntries(widgets.map(widget => {
      const hit = cache.get(cacheKey(widget));
      return [widget.id, !widget.source ? { status: 'ready' } : hit ? { status: 'ready', data: hit.data } : { status: 'loading' }];
    })));
    const mark = (predicate: (widget: Widget) => boolean, force = false) => {
      for (const widget of widgets) if (widget.source && predicate(widget)) { dirty.add(widget.id); if (force) fresh.add(widget.id); }
      schedule();
    };
    function schedule() {
      if (stopped || !userId || document.visibilityState === 'hidden' || timer || active) return;
      timer = setTimeout(() => { timer = undefined; void flush(); }, Math.max(40, retryAt - Date.now()));
    }
    function connect() {
      if (stream || !userId || document.visibilityState === 'hidden' || !visible.size) return;
      // One connection for the visible dashboard, shared by all widgets. The app's
      // existing event handler does not publish every routine or roster event.
      stream = new EventSource('/api/events', { withCredentials: true });
      stream.onopen = () => { if (reconnect) mark(() => true, true); reconnect = true; };
      stream.onmessage = event => {
        try {
          const value = JSON.parse(event.data);
          const type = value.type;
          if (type === 'live') {
            const key = JSON.stringify([!!value.state.isRunning, value.state.awaiting]);
            if (live.get(value.state.botId) === key) return;
            live.set(value.state.botId, key);
          }
          const groups: Record<string, string[]> = { tasks: ['tasks.', 'bots.status'], roster: ['bots.', 'tasks.', 'needsYou.'], bot: ['bots.'], routines: ['routines.'], live: ['bots.status', 'runs.', 'needsYou.', 'usage.'], rows: ['needsYou.'], setup: ['needsYou.'] };
          if (groups[type]) mark(widget => groups[type].some(prefix => widget.source!.id.startsWith(prefix)), true);
        } catch { /* Ignore malformed or unrelated events. */ }
      };
    }
    function planPoll() {
      clearTimeout(poll);
      if (stopped || document.visibilityState === 'hidden') return;
      let due = Infinity;
      for (const widget of widgets) if (widget.source && visible.has(widget.id) && widget.refreshSec !== 0) {
        const interval = Math.max(30, widget.refreshSec ?? 60) * 1000;
        due = Math.min(due, (lastAttempt(widget) || Date.now()) + interval);
      }
      if (Number.isFinite(due)) poll = setTimeout(() => {
        for (const widget of widgets) if (widget.source && visible.has(widget.id) && widget.refreshSec !== 0 && Date.now() - lastAttempt(widget) >= Math.max(30, widget.refreshSec ?? 60) * 1000) dirty.add(widget.id);
        schedule();
      }, Math.max(100, due - Date.now()));
    }
    async function flush() {
      if (!current() || document.visibilityState === 'hidden') return;
      connect();
      const requested = widgets.filter(widget => widget.source && visible.has(widget.id) && dirty.has(widget.id));
      if (!requested.length) { planPoll(); return; }
      active = true; controller = new AbortController();
      const groups = new Map<string, Widget[]>();
      for (const widget of requested) { dirty.delete(widget.id); const key = sourceKey(widget); attemptedAt.set(key, Date.now()); groups.set(key, [...groups.get(key) ?? [], widget]); }
      const entries = [...groups.values()];
      const force = requested.reduce((needed, widget) => fresh.delete(widget.id) || needed, false);
      setStates(previous => ({ ...previous, ...Object.fromEntries(requested.map(widget => [widget.id, previous[widget.id]?.data ? { ...previous[widget.id], refreshing: true } : { status: 'loading' }])) }));
      try {
        const response = await fetch('/api/ui/data', { method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(force ? { 'Cache-Control': 'no-cache' } : {}) },
          body: JSON.stringify({ requests: entries.slice(0, 24).map(([widget], n) => ({ key: `w${n}`, source: widget.source!.id, params: widgetSource(widget)!.params })) }) });
        if (response.status === 429) retryAt = Date.now() + Math.max(1, Number(response.headers.get('retry-after')) || 60) * 1000;
        if (!response.ok) throw new Error('Could not load data.');
        const body = await response.json(); if (!current()) return;
        const updates: Record<string, WidgetState> = {};
        entries.forEach((group, n) => {
          const result = body.results?.[`w${n}`] as WidgetData | undefined;
          if (result?.ok) {
            if (cache.size >= 256) cache.delete(cache.keys().next().value!);
            cache.set(cacheKey(group[0]), { data: result, receivedAt: Date.now() });
          }
          for (const widget of group) updates[widget.id] = result?.ok ? { status: 'ready', data: result } : { status: 'error', error: 'Data is unavailable.', data: cache.get(cacheKey(widget))?.data };
        });
        setStates(previous => ({ ...previous, ...updates }));
      } catch (error) {
        if (!current() || controller.signal.aborted) return;
        setStates(previous => ({ ...previous, ...Object.fromEntries(requested.map(widget => [widget.id, { status: 'error', data: previous[widget.id]?.data, error: 'Could not load data.' }])) }));
      } finally {
        active = false;
        if (current()) { if ([...dirty].some(id => visible.has(id))) schedule(); else planPoll(); }
      }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.widgetId!;
        if (entry.isIntersecting && widgets.some(widget => widget.id === id && widget.source)) { visible.add(id); dirty.add(id); } else visible.delete(id);
      }
      schedule();
    });
    const observe = (id: string, node: HTMLElement | null) => {
      const previous = nodes.current.get(id); if (previous) observer.unobserve(previous);
      if (node) { nodes.current.set(id, node); observer.observe(node); } else { nodes.current.delete(id); visible.delete(id); }
    };
    for (const node of nodes.current.values()) observer.observe(node);
    actions.current = { observe, refresh: id => mark(widget => !id || widget.id === id, true) };
    const visibility = () => {
      if (document.visibilityState === 'hidden') { clearTimeout(timer); timer = undefined; clearTimeout(poll); controller?.abort(); stream?.close(); stream = undefined; }
      else { mark(() => true, true); connect(); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; clearTimeout(timer); clearTimeout(poll); observer.disconnect(); controller?.abort(); stream?.close(); document.removeEventListener('visibilitychange', visibility); actions.current = undefined; };
  }, [signature, userId]);
  const observe = useCallback((id: string, node: HTMLElement | null) => {
    if (actions.current) actions.current.observe(id, node); else if (node) nodes.current.set(id, node); else nodes.current.delete(id);
  }, []);
  const refresh = useCallback((id?: string) => actions.current?.refresh(id), []);
  return { states: account === userId ? states : {}, observe, refresh };
}
