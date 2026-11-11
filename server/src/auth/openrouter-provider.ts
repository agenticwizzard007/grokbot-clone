import { env } from '../env.js';
const now = () => Date.now();
export class OpenRouterError extends Error {
  constructor(public code: string) { super(code); }
}
export const OPENROUTER_ERRORS: Record<string, string> = {
  openrouter_session: 'This OpenRouter sign-in expired or does not match this browser. Please start again.',
  openrouter_denied: 'OpenRouter authorization was cancelled. You can try again.',
  openrouter_unavailable: 'Could not reach OpenRouter. Please try again shortly.',
  openrouter_invalid: 'OpenRouter could not verify this authorization. Please try again.',
  openrouter_identity: 'OpenRouter did not return an account ID. Sign in another way, then add your key in Settings → API keys.',
  openrouter_link_signin: 'Sign in to your existing Swarm account before connecting OpenRouter.',
  openrouter_already_linked: 'This OpenRouter account is already linked to another Swarm account, or your Swarm account has a different OpenRouter account linked.',
  openrouter_key: 'OpenRouter rejected this key. Check that it is active and has not expired.',
  openrouter_management: 'Use an inference API key. Management keys cannot run models.',
  openrouter_busy: 'Too many connection attempts. Please try again shortly.',
};

export function validOpenRouterKey(value: unknown): value is string {
  return typeof value === 'string' && /^sk-or-v1-[A-Za-z0-9_-]{16,256}$/.test(value);
}

/** Never forward upstream bodies/errors: they can echo credentials. */
async function request(path: string, init: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${env.openrouterBaseUrl.replace(/\/$/, '')}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { throw new OpenRouterError('openrouter_unavailable'); }
  if (!response.ok) throw new OpenRouterError(response.status === 429 || response.status >= 500 ? 'openrouter_unavailable' : path === '/key' ? 'openrouter_key' : 'openrouter_invalid');
  try { return await response.json(); } catch { throw new OpenRouterError('openrouter_invalid'); }
}

export async function verifyPersonalOpenRouterKey(key: string) {
  if (!validOpenRouterKey(key)) throw new OpenRouterError('openrouter_key');
  const body = await request('/key', { headers: { Authorization: `Bearer ${key}` } });
  if (!body?.data || typeof body.data !== 'object' || typeof body.data.label !== 'string') throw new OpenRouterError('openrouter_invalid');
  if (body.data.is_management_key || body.data.is_provisioning_key) throw new OpenRouterError('openrouter_management');
  if (body.data.expires_at && (!Number.isFinite(Date.parse(body.data.expires_at)) || Date.parse(body.data.expires_at) <= now())) throw new OpenRouterError('openrouter_key');
}

export async function exchangeOpenRouterCode(code: string, verifier: string): Promise<{ key: string; subject: string }> {
  const result = await request('/auth/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!validOpenRouterKey(result?.key)) throw new OpenRouterError('openrouter_invalid');
  // Only the authenticated OAuth exchange establishes identity. A pasted key,
  // its label, and creator_user_id (which may refer to a teammate) never do.
  if (typeof result.user_id !== 'string' || !result.user_id.trim() || result.user_id.length > 256) throw new OpenRouterError('openrouter_identity');
  await verifyPersonalOpenRouterKey(result.key);
  return { key: result.key, subject: result.user_id };
}
