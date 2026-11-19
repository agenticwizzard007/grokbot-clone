import { useEffect, useState } from 'react';
import type { AgentExchange } from '@shared/coordination-types';
import { exchangeApi } from './agentExchanges';

export function useAgentExchanges(botId: string, generation: number, enabled: boolean, connected: boolean) {
  const identity = `${botId}:${generation}`;
  const [pages, setPages] = useState({ identity, count: 1 });
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ identity, exchanges: [] as AgentExchange[], more: false, loading: false, error: false });
  const count = pages.identity === identity ? pages.count : 1;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (timer !== undefined) return; timer = setTimeout(() => { timer = undefined; setVersion(n => n + 1); }, 200); };
    const onEvent = (event: Event) => { if ((event as CustomEvent).detail?.type === 'native') refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('swarm:event', onEvent);
    document.addEventListener('visibilitychange', visible);
    // Reconcile missed SSE notifications without polling in the background.
    const interval = setInterval(visible, 30_000);
    return () => { clearTimeout(timer); clearInterval(interval); window.removeEventListener('swarm:event', onEvent); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState(old => old.identity === identity ? { ...old, loading: true } : { identity, exchanges: [], more: false, loading: true, error: false });
    void (async () => {
      const exchanges: AgentExchange[] = [];
      let before: number | null = null;
      for (let page = 0; page < count; page++) {
        const result = await exchangeApi.list(botId, generation, before, controller.signal);
        exchanges.push(...result.exchanges);
        before = result.nextBefore;
        if (before === null) break;
      }
      if (!controller.signal.aborted) setState({ identity, exchanges, more: before !== null, loading: false, error: false });
    })().catch(() => {
      if (!controller.signal.aborted) setState(old => ({ ...old, loading: false, error: true }));
    });
    return () => controller.abort();
  }, [identity, botId, generation, enabled, count, version, connected]);
  return {
    ...(state.identity === identity && enabled ? state : { exchanges: [], more: false, loading: false, error: false }),
    loadMore: () => setPages({ identity, count: count + 1 }),
    retry: () => setVersion(n => n + 1),
  };
}
