// Composer dictation records a bounded capture, then transcribes it through the server's STT proxy.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { voiceApi } from './api';
import { micErrorMessage, openMic } from './audio';

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing';
export interface DictationOptions { contextKey: string; enabled: boolean }

const HOLD_MS = 350;
const MAX_MS = 120_000;

interface Capture {
  contextKey: string;
  onText: (text: string) => void;
  onError: (msg: string) => void;
  language?: string;
  abort: AbortController;
  stream?: MediaStream;
  mr?: MediaRecorder;
  chunks: Blob[];
  downAt: number;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
  toggleMode: boolean;
}

function pickMime(): string | undefined {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

function stopTracks(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => {
    try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
  });
}

function releaseTracks(r: Capture) {
  stopTracks(r.stream);
  r.stream = undefined;
}

function dispose(r: Capture) {
  clearTimeout(r.timer);
  r.abort.abort();
  if (r.mr) {
    r.mr.ondataavailable = r.mr.onstop = r.mr.onerror = null;
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* Tracks still need releasing. */ }
  }
  releaseTracks(r);
  r.chunks = [];
}

export function useDictation(
  onText: (text: string) => void,
  onError: (msg: string) => void,
  language?: string,
  options?: DictationOptions,
) {
  const [state, setState] = useState<DictationState>('idle');
  const active = useRef<Capture | null>(null);
  const mounted = useRef(false);
  const contextKey = options?.contextKey ?? '';
  const enabled = options?.enabled ?? true;
  const latest = useRef({ onText, onError, language, contextKey, enabled });
  latest.current = { onText, onError, language, contextKey, enabled };

  const isCurrent = useCallback((r: Capture) => mounted.current && active.current === r
    && !r.abort.signal.aborted && latest.current.enabled && latest.current.contextKey === r.contextKey, []);

  const complete = useCallback((r: Capture) => {
    if (active.current !== r) return;
    // Invalidate before stopping/aborting: browser events and callbacks may run synchronously.
    active.current = null;
    dispose(r);
    if (mounted.current) setState('idle');
  }, []);

  const cancel = useCallback(() => {
    if (active.current) complete(active.current);
  }, [complete]);

  const fail = useCallback((r: Capture, message: string) => {
    const report = isCurrent(r);
    complete(r);
    if (report) r.onError(message);
  }, [complete, isCurrent]);

  const stop = useCallback(() => {
    const r = active.current;
    if (!r || r.stopping) return;
    // A permission prompt cannot be stopped into a transcript.
    if (!r.mr || !isCurrent(r)) { complete(r); return; }
    r.stopping = true;
    clearTimeout(r.timer);
    try {
      r.mr.stop();
    } catch (e) {
      fail(r, micErrorMessage(e));
    } finally {
      releaseTracks(r);
    }
  }, [complete, fail, isCurrent]);

  const start = useCallback(async () => {
    if (!mounted.current || !latest.current.enabled || active.current) return;
    if (typeof MediaRecorder === 'undefined') { latest.current.onError('Dictation isn’t supported in this browser.'); return; }
    const r: Capture = {
      ...latest.current, abort: new AbortController(), chunks: [], downAt: Date.now(), startedAt: 0,
      stopping: false, toggleMode: false,
    };
    active.current = r;
    setState('starting');
    try {
      const stream = await openMic();
      // getUserMedia has no AbortSignal; release a late permission grant immediately.
      if (!isCurrent(r)) { stopTracks(stream); return; }
      r.stream = stream;
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      r.mr = mr;
      mr.ondataavailable = (e) => { if (isCurrent(r) && e.data.size) r.chunks.push(e.data); };
      mr.onerror = (e) => fail(r, micErrorMessage((e as Event & { error?: DOMException }).error ?? new Error('Recording failed')));
      mr.onstop = async () => {
        clearTimeout(r.timer);
        releaseTracks(r);
        if (!isCurrent(r)) return;
        r.stopping = true;
        if (!r.chunks.length || Date.now() - r.startedAt < 250) { complete(r); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(new Blob(r.chunks, { type: mr.mimeType || mime || 'audio/webm' }), r.language, r.abort.signal);
          if (!isCurrent(r)) return;
          complete(r);
          // MF-058: silence (or nothing intelligible) still gets feedback.
          if (text && text.trim()) r.onText(text);
          else r.onError('Didn’t catch anything. Try again.');
        } catch (e) {
          fail(r, (e as Error).message || 'Transcription failed');
        }
      };
      mr.start(250);
      if (!isCurrent(r)) return;
      r.startedAt = Date.now();
      r.timer = setTimeout(stop, MAX_MS);
      setState('recording');
    } catch (e) {
      fail(r, micErrorMessage(e));
    }
  }, [complete, fail, isCurrent, stop]);

  // Retained for callers that use press-and-hold or tap-to-toggle dictation.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (active.current?.toggleMode) stop();
    else void start();
  }, [start, stop]);

  const onPointerUp = useCallback(() => {
    const r = active.current;
    if (!r || r.toggleMode) return;
    if (!r.mr || Date.now() - r.downAt < HOLD_MS) r.toggleMode = true;
    else stop();
  }, [stop]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (active.current) stop();
    else void start();
  }, [start, stop]);

  // Layout cleanup invalidates even A -> B -> A and disabled -> enabled transitions.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useLayoutEffect(() => { cancel(); }, [contextKey, enabled, cancel]);

  useEffect(() => {
    if (state === 'idle') return;
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state, cancel]);

  return { state, starting: state === 'starting', start, stop, cancel, onPointerDown, onPointerUp, onKeyDown };
}
