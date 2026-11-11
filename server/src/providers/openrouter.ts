import { openPrivate, sealPrivate } from '../security/secrets.js';
import { isTenant, assertTenant } from '../deployment.js';
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

export { OpenRouterError, OPENROUTER_ERRORS, validOpenRouterKey, verifyPersonalOpenRouterKey, exchangeOpenRouterCode } from '../auth/openrouter-provider.js';
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
  assertTenant(userId);
  const key = encrypted && (encrypted.startsWith('private1:') ? openPrivate<string>(userId, 'provider:openrouter', encrypted) : isTenant ? null : unsealSecret(encrypted));
  if (!key) throw new Error('Reconnect OpenRouter in Settings → API keys. Your personal key is missing or could not be decrypted.');
  return key;
}

export function saveOpenRouterKey(userId: string, key: string, source: 'oauth' | 'manual') {
  db.prepare(`INSERT INTO provider_connections(user_id,provider,encrypted_key,key_hint,key_hash,source,updated_at)
    VALUES (?,'openrouter',?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET
    encrypted_key=excluded.encrypted_key,key_hint=excluded.key_hint,key_hash=excluded.key_hash,source=excluded.source,updated_at=excluded.updated_at`)
    .run(userId, sealPrivate(userId, 'provider:openrouter', key), `…${key.slice(-4)}`, crypto.createHash('sha256').update(key).digest('hex'), source, now());
}
