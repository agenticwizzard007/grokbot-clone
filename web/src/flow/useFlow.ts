import { useCallback, useEffect, useState } from 'react';
import type { FlowModel } from '@shared/flow/model-types';
import { useStore } from '../store';
import { useVersion } from '../configStore';
import { flowApi } from './api';

// One shared subscription for mounted flow surfaces; disposed when none are visible.
const listeners = new Set<(botId?: string) => void>();
let source: EventSource | undefined;
function subscribe(listener: (botId?: string) => void) {
  listeners.add(listener);
  if (!source) {
    source = new EventSource('/api/events', { withCredentials: true });
    source.onmessage = message => { try {
      const event = JSON.parse(message.data);
      if (['flow','routines','setup','memories','bot','connections','messaging','output','handoff','loop','native','hello'].includes(event.type)) for (const fn of listeners) fn(event.botId ?? event.bot?.id);
    } catch { /* The server may close an incomplete event. */ } };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { source?.close(); source = undefined; } };
}
export function useFlow(botId: string) {
  const account = useStore(s => s.user?.id), version = useVersion(`flow:${botId}`);
  const [state, setState] = useState<{ key: string; model?: FlowModel; error?: string; disabled?: boolean }>({ key: '' });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(v => v + 1), []);
  const key = `${account}:${botId}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe(id => { if (!id || id === botId) { clearTimeout(timer); timer = setTimeout(reload, 100); } });
    const focus = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { stop(); clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [botId, account, reload]);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    flowApi.get(botId, controller.signal).then(model => { if (!controller.signal.aborted && useStore.getState().user?.id === account) setState({ key, model }); }).catch(error => {
      if (!controller.signal.aborted && useStore.getState().user?.id === account) setState(previous => ({ key, model: previous.key === key ? previous.model : undefined, error: error.message, disabled: error.code === 'disabled' }));
    });
    return () => controller.abort();
  }, [key, account, botId, revision, version]);
  return { ...(state.key === key ? state : {}), loading: state.key !== key, reload };
}
