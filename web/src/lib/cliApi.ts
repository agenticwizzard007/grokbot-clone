import { ApiError } from './api';
import { useStore } from '../store';

export type CliProvider = 'codex' | 'claude';

export interface CliProviderStatus {
  installed: boolean;
  authenticated: boolean;
  subscription: boolean;
  error?: string;
}

export interface CliStatus {
  runtime: 'server' | 'bridge';
  serverLoginAvailable: boolean;
  selected: CliProvider | null;
  connected: boolean;
  device: string | null;
  providers: Record<CliProvider, CliProviderStatus>;
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
  status: (signal?: AbortSignal): Promise<CliStatus> => jsonRequest('GET', '', undefined, signal),
  pair: (): Promise<{ command: string }> => jsonRequest('POST', '/pair'),
  select: async (provider: CliProvider | null): Promise<void> => { await request('PUT', '', { provider }); },
  refresh: (): Promise<CliStatus> => jsonRequest('POST', '/refresh'),
  revoke: async (): Promise<void> => { await request('DELETE', '/pair'); },
  reset: (expectedUserId: string): Promise<CliStatus> => jsonRequest('POST', '/reset', { expectedUserId }),
  verifyAuth: async (expectedUserId: string, signal?: AbortSignal): Promise<void> => { await request('POST', '/reauth', { expectedUserId }, signal); },
  startLogin: (provider: CliProvider, cols: number, rows: number): Promise<LoginSession> => jsonRequest('POST', '/login', { provider, cols, rows }),
  login: (id: string, cursor: number, signal?: AbortSignal): Promise<LoginSession> => jsonRequest('GET', `/login/${encodeURIComponent(id)}?cursor=${cursor}`, undefined, signal),
  loginInput: async (id: string, data: string, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/input`, { data }, signal); },
  resizeLogin: async (id: string, cols: number, rows: number, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/resize`, { cols, rows }, signal); },
  cancelLogin: async (id: string): Promise<void> => { await request('DELETE', `/login/${encodeURIComponent(id)}`, undefined, undefined, true); },
};
