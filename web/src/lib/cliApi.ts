import { ApiError } from './api';
import { useStore } from '../store';

export type CliProvider = 'codex' | 'claude';

export interface CliProviderStatus {
  installed: boolean;
  authenticated: boolean;
  subscription: boolean;
  hasSavedState?: boolean;
  error?: string;
}

export interface CliRun {
  startedAt: number;
  provider: CliProvider | 'direct' | 'openrouter';
  runtime: 'server' | 'bridge' | 'api';
  toolsOffered: number;
  trigger?: 'approval_decision' | null;
  lastTool: string | null;
  result: 'running' | 'completed' | 'pending_approval' | 'allowed' | 'rejected_by_cli' | 'denied' | 'error' | 'cancelled' | 'no_tool_call';
  errorCode: string | null;
}

export interface CliStatus {
  apiRuns?: { latest: CliRun | null; lastToolRun: CliRun | null };
  lastRun?: CliRun | null;
  runsByProvider?: Partial<Record<CliProvider, { latest: CliRun | null; lastToolRun: CliRun | null }>>;
  runtime: 'server' | 'bridge';
  serverLoginAvailable: boolean;
  selected: CliProvider | null;
  connected: boolean;
  device: string | null;
  providers: Record<CliProvider, CliProviderStatus>;
  statusUnavailable?: boolean;
  statusChecking?: boolean;
}

let cachedStatus: CliStatus | null = null;
export const getCachedCliStatus = () => cachedStatus;
const statusKey = (accountId: string) => `swarm.plan-status.${accountId}`;
function restoreStatus(accountId: string | undefined): CliStatus | null {
  if (!accountId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(statusKey(accountId)) || 'null');
    if (!value || typeof value.connected !== 'boolean' || !['server', 'bridge'].includes(value.runtime) || ![null, 'codex', 'claude'].includes(value.selected)
      || !['codex', 'claude'].every(provider => ['installed', 'authenticated', 'subscription'].every(field => typeof value.providers?.[provider]?.[field] === 'boolean'))) return null;
    return { ...value, statusChecking: true };
  } catch { return null; }
}
// This module can load lazily after the account has already been established.
cachedStatus = restoreStatus(useStore.getState().user?.id);
const statusListeners = new Set<() => void>();
export const subscribeCliStatus = (listener: () => void) => {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
};
function cacheStatus(status: CliStatus | null) {
  cachedStatus = status;
  statusListeners.forEach(listener => listener());
}
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) cacheStatus(restoreStatus(state.user?.id));
});

function preserveStatus(next: CliStatus): CliStatus {
  const previous = cachedStatus;
  if (!previous || previous.runtime !== next.runtime || !next.statusChecking && !next.statusUnavailable) return next;
  const providers = { ...next.providers };
  for (const provider of ['codex', 'claude'] as const) {
    // Pending snapshots contain empty health, not evidence of a disconnected plan.
    if (!providers[provider].authenticated && !providers[provider].error && previous.providers[provider].subscription) {
      providers[provider] = previous.providers[provider];
    }
  }
  return { ...next, connected: next.connected || previous.connected, providers };
}

function persistStatus(accountId: string | undefined, status: CliStatus) {
  if (!accountId || status.statusChecking || status.statusUnavailable) return;
  try {
    // Store display facts only, never diagnostics, credentials or terminal output.
    const { runtime, serverLoginAvailable, selected, connected } = status;
    const previous = restoreStatus(accountId);
    const providers = Object.fromEntries((['codex', 'claude'] as const).map(provider => {
      const health = status.providers[provider];
      const known = health.error && previous?.runtime === runtime ? previous.providers[provider] : health;
      const { installed, authenticated, subscription, hasSavedState } = known;
      return [provider, { installed, authenticated, subscription, hasSavedState, ...(known.error ? { error: 'Status unavailable. Retry.' } : {}) }];
    }));
    localStorage.setItem(statusKey(accountId), JSON.stringify({ runtime, serverLoginAvailable, selected, connected, device: null, providers }));
  } catch { /* Storage can be unavailable in private browsing. */ }
}

export interface LoginSession {
  id: string;
  provider: CliProvider;
  state: 'running' | 'verifying' | 'connected' | 'failed' | 'cancelled';
  output: string;
  cursor: number;
  reset: boolean;
  error?: string;
  exitCode?: number | null;
}

async function request(method: string, path = '', body?: unknown, signal?: AbortSignal, keepalive = false) {
  // Bind the request itself to the rendered account; another tab can change the cookie.
  const expectedUserId = useStore.getState().user?.id;
  if (!expectedUserId) throw new ApiError(401, 'Sign in before changing a connection.', 'unauthenticated');
  const current = () => {
    if (useStore.getState().user?.id !== expectedUserId) throw new ApiError(409, 'Your account changed. Reload this page before changing a connection.', 'account_changed');
  };
  const intent = `${path.includes('?') ? '&' : '?'}expectedUserId=${encodeURIComponent(expectedUserId)}`;
  const response = await fetch(`/api/cli${path}${intent}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    keepalive,
  });
  current();
  if (!response.ok) {
    let message = response.statusText || 'Subscription request failed.', code: string | undefined;
    try { const body = (await response.json()) as { error?: string; code?: string }; message = body.error || message; code = body.code; } catch { /* Not a JSON error. */ }
    current();
    throw new ApiError(response.status, message, code);
  }
  return { response, current };
}

async function jsonRequest<T>(...args: Parameters<typeof request>): Promise<T> {
  const { response, current } = await request(...args);
  const value = await response.json();
  current();
  return value as T;
}

export const cliApi = {
  status: (signal?: AbortSignal): Promise<CliStatus> => readStatus(false, signal),
  pair: (): Promise<{ command: string }> => jsonRequest('POST', '/pair'),
  select: async (provider: CliProvider | null): Promise<void> => { await request('PUT', '', { provider }); },
  refresh: (signal?: AbortSignal): Promise<CliStatus> => readStatus(true, signal),
  revoke: async (): Promise<void> => {
    const accountId = useStore.getState().user?.id;
    await request('DELETE', '/pair');
    try { if (accountId) localStorage.removeItem(statusKey(accountId)); } catch { /* Optional display cache. */ }
    cacheStatus(null);
  },
  reset: async (expectedUserId: string): Promise<CliStatus> => {
    const status = await jsonRequest<CliStatus>('POST', '/reset', { expectedUserId });
    try { localStorage.removeItem(statusKey(expectedUserId)); } catch { /* Optional display cache. */ }
    cacheStatus(status);
    persistStatus(expectedUserId, status);
    return status;
  },
  verifyAuth: async (expectedUserId: string, signal?: AbortSignal): Promise<void> => { await request('POST', '/reauth', { expectedUserId }, signal); },
  startLogin: (provider: CliProvider, cols: number, rows: number): Promise<LoginSession> => jsonRequest('POST', '/login', { provider, cols, rows }),
  login: (id: string, cursor: number, signal?: AbortSignal): Promise<LoginSession> => jsonRequest('GET', `/login/${encodeURIComponent(id)}?cursor=${cursor}`, undefined, signal),
  loginInput: async (id: string, data: string, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/input`, { data }, signal); },
  resizeLogin: async (id: string, cols: number, rows: number, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/resize`, { cols, rows }, signal); },
  cancelLogin: async (id: string): Promise<void> => { await request('DELETE', `/login/${encodeURIComponent(id)}`, undefined, undefined, true); },
};

async function readStatus(refresh: boolean, signal?: AbortSignal): Promise<CliStatus> {
  const accountId = useStore.getState().user?.id;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    let status = await Promise.race([
      jsonRequest<CliStatus>(refresh ? 'POST' : 'GET', refresh ? '/refresh' : '', undefined,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Status unavailable. Retry.')); }, 3500);
      }),
    ]);
    if (signal?.aborted) throw new DOMException('Status request cancelled', 'AbortError');
    if (useStore.getState().user?.id !== accountId) throw new ApiError(409, 'Your account changed. Reload this page before changing a connection.', 'account_changed');
    // A malformed response must never become the next view's initial snapshot.
    if (!status.providers?.claude || !status.providers.codex) throw new Error('Status unavailable. Retry.');
    status = preserveStatus(status);
    cacheStatus(status);
    persistStatus(accountId, status);
    return status;
  } catch (error) {
    if (!signal?.aborted && useStore.getState().user?.id === accountId) cacheStatus(cachedStatus ? { ...cachedStatus, statusChecking: false, statusUnavailable: true } : null);
    throw error;
  } finally { clearTimeout(timer!); }
}
