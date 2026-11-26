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
  provider: CliProvider;
  runtime: 'server' | 'bridge';
  toolsOffered: number;
  trigger?: 'approval_decision' | null;
  lastTool: string | null;
  result: 'running' | 'completed' | 'pending_approval' | 'allowed' | 'rejected_by_cli' | 'denied' | 'error' | 'cancelled' | 'no_tool_call';
  errorCode: string | null;
}

export interface CliStatus {
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
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) cachedStatus = null;
});

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
  revoke: async (): Promise<void> => { await request('DELETE', '/pair'); },
  reset: (expectedUserId: string): Promise<CliStatus> => jsonRequest('POST', '/reset', { expectedUserId }),
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
    const status = await Promise.race([
      jsonRequest<CliStatus>(refresh ? 'POST' : 'GET', refresh ? '/refresh' : '', undefined,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Status unavailable. Retry.')); }, 3500);
      }),
    ]);
    if (signal?.aborted) throw new DOMException('Status request cancelled', 'AbortError');
    if (useStore.getState().user?.id !== accountId) throw new ApiError(409, 'Your account changed. Reload this page before changing a connection.', 'account_changed');
    // A malformed response must never become the next view's initial snapshot.
    if (status.providers?.claude && status.providers.codex) cachedStatus = status;
    return status;
  } finally { clearTimeout(timer!); }
}
