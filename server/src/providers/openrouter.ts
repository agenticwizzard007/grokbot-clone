import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { sealSecret, unsealSecret } from '../settings.js';

// Identity and inference credentials have separate lifecycles: removing a key
// must not lock someone out of the account they created with OpenRouter.
db.exec(`
CREATE TABLE IF NOT EXISTS openrouter_identities (
  subject TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider='openrouter'),
  encrypted_key TEXT,
  key_hint TEXT,
  key_hash TEXT,
  source TEXT NOT NULL CHECK(source IN ('oauth','manual')),
  model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,provider)
);`);

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

export interface Connection {
  encrypted_key: string | null;
  key_hint: string | null;
  key_hash: string | null;
  source: 'oauth' | 'manual';
  model: string | null;
  enabled: number;
  updated_at: number;
}
export function openrouterConnection(userId: string | null | undefined): Connection | null {
  return userId ? db.prepare("SELECT * FROM provider_connections WHERE user_id=? AND provider='openrouter'").get(userId) as Connection ?? null : null;
}
export const usesPersonalOpenRouter = (userId: string | null | undefined) => !!openrouterConnection(userId)?.enabled;
export function personalOpenRouterKey(userId: string): string {
  const encrypted = openrouterConnection(userId)?.encrypted_key;
  const key = encrypted && unsealSecret(encrypted);
  if (!key) throw new Error('Reconnect OpenRouter in Settings → API keys. Your personal key is missing or could not be decrypted.');
  return key;
}

export function saveOpenRouterKey(userId: string, key: string, source: 'oauth' | 'manual') {
  db.prepare(`INSERT INTO provider_connections(user_id,provider,encrypted_key,key_hint,key_hash,source,updated_at)
    VALUES (?,'openrouter',?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET
    encrypted_key=excluded.encrypted_key,key_hint=excluded.key_hint,key_hash=excluded.key_hash,source=excluded.source,updated_at=excluded.updated_at`)
    .run(userId, sealSecret(key), `…${key.slice(-4)}`, crypto.createHash('sha256').update(key).digest('hex'), source, now());
}

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
