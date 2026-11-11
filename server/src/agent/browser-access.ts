import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserResult } from '../computers/types.js';
import { browserBlocker, browserObservation } from './browser-recovery.js';

type AccessStatus = 'cleared' | 'timeout' | 'unrecognized' | 'aborted';
export interface AccessWaitResult { status: AccessStatus; page?: BrowserResult }
const accessBlocker = (page: BrowserResult) => ['login', 'verification', 'captcha'].includes(browserBlocker(page) ?? '');
const readable = (page: BrowserResult) => {
  const { snapshot, url, modal } = browserObservation(page);
  return !page.isError && !modal && /^https?:\/\//.test(url) && !!snapshot.trim()
    && !/\b(?:chrome-error|chromewebdata)\b/.test(url);
};

/** Read-only polling. An aborted/expired wait must not wait for an unresponsive browser RPC. */
async function readWithSignal(read: () => Promise<BrowserResult>, signal: AbortSignal) {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([read(), cancelled]); }
  finally { signal.removeEventListener('abort', stop); }
}

/** A missing/failed observation never counts as successful login. No model calls while waiting. */
export async function waitForBrowserAccess(options: {
  read: () => Promise<BrowserResult>;
  onWaiting: () => void;
  signal?: AbortSignal;
  timeoutMs: number;
  pollMs?: number;
  resumeWhen?: string;
}): Promise<AccessWaitResult> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs)));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let page: BrowserResult | undefined;
  try {
    page = await readWithSignal(options.read, signal);
    const marker = options.resumeWhen?.trim();
    // An unfamiliar login needs an explicit observable completion condition.
    if (!accessBlocker(page) && (!marker || !readable(page) || browserObservation(page).snapshot.includes(marker))) return { status: 'unrecognized', page };
    signal.throwIfAborted();
    options.onWaiting();
    let clearReadings = 0;
    while (!signal.aborted) {
      await delay(options.pollMs ?? 2_000, undefined, { signal });
      try { page = await readWithSignal(options.read, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        clearReadings = 0;
        continue;
      }
      const snapshot = browserObservation(page).snapshot;
      const clear = readable(page) && !browserBlocker(page) && (!marker || snapshot.includes(marker));
      clearReadings = clear ? clearReadings + 1 : 0;
      if (clearReadings >= 2) return { status: 'cleared', page };
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  return { status: options.signal?.aborted ? 'aborted' : 'timeout', page };
}
