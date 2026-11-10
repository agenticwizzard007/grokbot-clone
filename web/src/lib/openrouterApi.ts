import { ApiError } from './api';

export interface OpenRouterStatus {
  connected: boolean;
  linked: boolean;
  selected: boolean;
  active: boolean;
  hint: string | null;
  source: 'oauth' | 'manual' | null;
  model: string;
  provider: string;
  defaultModel: string;
  settingsUrl: string;
}

export const OPENROUTER_ERRORS: Record<string, string> = {
  openrouter_session: 'This OpenRouter sign-in expired or does not match this browser. Please start again.',
  openrouter_denied: 'OpenRouter authorization was cancelled. You can try again.',
  openrouter_unavailable: 'Could not reach OpenRouter. Please try again shortly.',
  openrouter_invalid: 'OpenRouter could not verify this authorization. Please try again.',
  openrouter_identity: 'OpenRouter did not return an account ID. Sign in another way, then add your key in Settings → API keys.',
  openrouter_link_signin: 'Sign in to your existing Swarm account before connecting OpenRouter.',
  openrouter_already_linked: 'This OpenRouter account is already linked to another Swarm account, or this account has a different OpenRouter account linked.',
  openrouter_key: 'OpenRouter rejected this key. Check that it is active and has not expired.',
  openrouter_management: 'Use an inference API key. Management keys cannot run models.',
  openrouter_busy: 'Too many connection attempts. Please try again shortly.',
};

async function request(method: string, path = '', body?: unknown, signal?: AbortSignal): Promise<OpenRouterStatus> {
  const response = await fetch(`/api/providers/openrouter${path}`, {
    method, credentials: 'include', signal,
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'Could not update OpenRouter.');
  return data;
}
export const openrouterApi = {
  status: (signal?: AbortSignal) => request('GET', '', undefined, signal),
  saveKey: (key: string) => request('PUT', '/key', { key }),
  update: (value: { enabled?: boolean; model?: string }) => request('PUT', '', value),
  disconnect: () => request('DELETE', '/key', {}),
};
