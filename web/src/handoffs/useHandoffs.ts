import { useCallback, useEffect, useRef, useState } from 'react';
import { displayCoordinationText } from '@shared/lib/redact';

const invalidations = new EventTarget();
/** HO-I forwards handoff/output SSE and reconnect notifications here. No second EventSource. */
export function refreshHandoffs() { invalidations.dispatchEvent(new Event('change')); }

export function useHandoffResource<T>(key: string, read: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const reader = useRef(read); reader.current = read;
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: enabled });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const event = (message: Event) => {
      const type = (message as CustomEvent<{ type?: string }>).detail?.type;
      if (type && ['handoff', 'output', 'reconnect'].includes(type)) retry();
    };
    const resume = () => { if (document.visibilityState !== 'hidden') retry(); };
    invalidations.addEventListener('change', retry);
    window.addEventListener('online', retry);
    window.addEventListener('swarm:event', event);
    window.addEventListener('swarm:resume', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      invalidations.removeEventListener('change', retry); window.removeEventListener('online', retry);
      window.removeEventListener('swarm:event', event); window.removeEventListener('swarm:resume', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [retry]);
  useEffect(() => {
    if (!enabled) { setState({ key, loading: false }); return; }
    const controller = new AbortController();
    setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }));
    reader.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, key, error: errorText(error), loading: false }));
    });
    return () => controller.abort();
  }, [key, enabled, revision]);
  return { ...(state.key === key ? state : { data: undefined, error: undefined, loading: enabled }), retry };
}

/** Display copy is plain text, with machine headers and internal identifiers removed. */
export function handoffText(value: string) {
  return displayCoordinationText(value.replace(/^(?:mock:\s*(?:say\s+)?|(?:system|assistant|provider):\s*)+/gim, '').replace(/^\[handoff [^\]\n]*\]\s*\n?/, ''))
    .replace(/\b(?:out|ho|lp)_[A-Za-z0-9_-]+\b/g, 'item').replace(/[\u2013\u2014]/g, ', ');
}
export function errorText(error: unknown) { return handoffText(error instanceof Error ? error.message : 'Could not load this. Try again.'); }
export const outputHref = (outputId: string, partId?: string) => `#output/${encodeURIComponent(outputId)}${partId ? `?part=${encodeURIComponent(partId)}` : ''}`;
export const handoffHref = (handoffId: string) => `#handoff/${encodeURIComponent(handoffId)}`;
