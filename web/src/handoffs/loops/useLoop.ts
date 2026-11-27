import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, loopsApi, type LoopAction, type LoopApi, type LoopBot, type LoopDetail, type LoopEvent } from './api';

export function mergeEvents(before: LoopEvent[], incoming: LoopEvent[]) {
  return [...new Map([...before, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}

export function useLoop(id: string, api: LoopApi = loopsApi) {
  const [state, setState] = useState<{ id: string; detail: LoopDetail | null; events: LoopEvent[]; loading: boolean; error: string }>({ id, detail: null, events: [], loading: true, error: '' });
  const refreshRef = useRef<() => void>(() => {});
  const [pending, setPending] = useState<LoopAction | null>(null);
  const [actionError, setActionError] = useState('');
  const busy = useRef(false);
  const currentId = useRef(id); currentId.current = id;
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false, again = false, cursor = 0;
    let events: LoopEvent[] = [];
    let bots: LoopBot[] | undefined;
    setState({ id, detail: null, events: [], loading: true, error: '' });
    setActionError('');
    const refresh = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      do {
        again = false;
        try {
          // Read events before the snapshot, so an event never outruns its detail.
          let next: number | null | undefined = cursor;
          do {
            const page = await api.events(id, next, controller.signal);
            events = mergeEvents(events, page.events);
            const previous = next;
            next = page.next;
            if (next != null && next <= previous) throw new Error('Could not read the next events. Try again.');
          } while (next != null);
          const [snapshot, agents] = await Promise.all([api.get(id, controller.signal), bots ? Promise.resolve(bots) : api.bots(controller.signal)]);
          bots = agents;
          const detail: LoopDetail = { ...snapshot, bots: snapshot.bots ?? agents, steps: snapshot.steps.map(step => ({ ...step, botName: step.botName ?? agents.find(bot => bot.id === step.botId)?.name })) };
          if (controller.signal.aborted) return;
          cursor = events.at(-1)?.seq ?? 0;
          setState(previous => ({ id, detail: previous.id === id && previous.detail && previous.detail.loop.revision > detail.loop.revision ? previous.detail : detail, events, loading: false, error: '' }));
        } catch (error) {
          if (controller.signal.aborted) return;
          setState(previous => ({ ...previous, loading: false, error: errorText(error) }));
        }
      } while (again && !controller.signal.aborted);
      refreshing = false;
    };
    refreshRef.current = () => { void refresh(); };
    const unsubscribe = api.subscribe(changed => { if (!changed || changed === id) void refresh(); });
    void refresh();
    return () => { controller.abort(); unsubscribe(); refreshRef.current = () => {}; };
  }, [id, api]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const act = useCallback(async (action: LoopAction) => {
    if (busy.current) return;
    busy.current = true; setPending(action); setActionError('');
    try { await api.control(id, action); if (currentId.current === id) refresh(); }
    catch (error) { if (currentId.current === id) setActionError(errorText(error)); }
    finally { busy.current = false; setPending(null); }
  }, [id, api, refresh]);
  const visible = state.id === id ? state : { id, detail: null, events: [], loading: true, error: '' };
  return { ...visible, refresh, act, pending, actionError };
}
