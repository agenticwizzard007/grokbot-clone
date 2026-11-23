import type { McpServerInput, McpServerView, User } from '@shared/types';
import { ApiError } from './api';
import { expireSession, requireActiveSession, revalidateSession } from './session';

export interface AccountSession {
  id: string;
  current: boolean;
  device?: string | null;
  created_at: number | string;
  last_seen_at: number | string | null;
  expires_at: number | string;
}

export type PrivateCredentialProvider = 'direct' | 'voice';
interface PrivateCredentialStatus {
  provider: PrivateCredentialProvider;
  hint: string | null;
  connected: 0 | 1;
}

async function request<Response>(method: string, path: string, { body, signal }: { body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  requireActiveSession();
  const response = await fetch(`/api${path}`, {
    method, signal, credentials: 'include', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  requireActiveSession();
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    if (response.status === 401 && detail?.code !== 'reauth_required') void revalidateSession();
    throw new ApiError(response.status, detail?.error || response.statusText || 'Request failed.', detail?.code);
  }
  const result = await response.json() as Response;
  requireActiveSession();
  return result;
}

export async function verifyAccessAccount(expectedId: string, signal?: AbortSignal) {
  const { user } = await request<{ user: User | null }>('GET', '/auth/me', { signal });
  if (!user) expireSession(expectedId);
  if (!user || user.id !== expectedId) {
    throw new ApiError(409, 'This browser is no longer signed in to that account. Reload and review Account settings.', 'account_changed');
  }
}

const mcpPath = (id: string) => `/mcp/servers/${encodeURIComponent(id)}`;

export const accessApi = {
  sessions: (signal?: AbortSignal) => request<{ sessions: AccountSession[] }>('GET', '/auth/sessions', { signal }),
  revokeSession: (id: string) => request<{ ok: true; revokedCurrent: boolean }>('DELETE', `/auth/sessions/${encodeURIComponent(id)}`),
  createMcpServer: (body: McpServerInput) => request<{ server: McpServerView }>('POST', '/mcp/servers', { body }),
  updateMcpServer: (id: string, body: Partial<McpServerInput>) => request<{ server: McpServerView }>('PATCH', mcpPath(id), { body }),
  authorizeMcpServer: (id: string) => request<{ redirectUrl: string }>('POST', `${mcpPath(id)}/oauth`),
  credentials: (signal?: AbortSignal) => request<{ keys: PrivateCredentialStatus[] }>('GET', '/providers/private-keys', { signal }),
  saveCredential: (provider: PrivateCredentialProvider, key: string) => request<{ keys: PrivateCredentialStatus[] }>('PUT', `/providers/private-keys/${provider}`, { body: { key } }),
  removeCredential: (provider: PrivateCredentialProvider) => request<{ ok: true }>('DELETE', `/providers/private-keys/${provider}`, { body: {} }),
  selectPrivateModels: () => request<{ ok: true }>('POST', '/providers/private-keys/direct/select', { body: {} }),
};
