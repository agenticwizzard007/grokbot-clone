import { ApiError } from './api';

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

async function request(method: string, path = '', body?: unknown, signal?: AbortSignal, keepalive = false): Promise<Response> {
  const response = await fetch(`/api/cli${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    keepalive,
  });
  if (!response.ok) {
    let message = response.statusText || 'Subscription request failed.';
    try { message = ((await response.json()) as { error?: string }).error || message; } catch { /* Not a JSON error. */ }
    throw new ApiError(response.status, message);
  }
  return response;
}

export const cliApi = {
  status: async (signal?: AbortSignal): Promise<CliStatus> => (await request('GET', '', undefined, signal)).json(),
  pair: async (): Promise<{ command: string }> => (await request('POST', '/pair')).json(),
  select: async (provider: CliProvider | null): Promise<void> => { await request('PUT', '', { provider }); },
  refresh: async (): Promise<CliStatus> => (await request('POST', '/refresh')).json(),
  revoke: async (): Promise<void> => { await request('DELETE', '/pair'); },
  startLogin: async (provider: CliProvider, cols: number, rows: number): Promise<LoginSession> => (await request('POST', '/login', { provider, cols, rows })).json(),
  login: async (id: string, cursor: number, signal?: AbortSignal): Promise<LoginSession> => (await request('GET', `/login/${encodeURIComponent(id)}?cursor=${cursor}`, undefined, signal)).json(),
  loginInput: async (id: string, data: string, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/input`, { data }, signal); },
  resizeLogin: async (id: string, cols: number, rows: number, signal?: AbortSignal): Promise<void> => { await request('POST', `/login/${encodeURIComponent(id)}/resize`, { cols, rows }, signal); },
  cancelLogin: async (id: string): Promise<void> => { await request('DELETE', `/login/${encodeURIComponent(id)}`, undefined, undefined, true); },
};
