export * from './apple-verifier.js';
import { appleClientSecret, AppleError } from './apple-verifier.js';
import { db } from '../db.js';
import { sealSecret, unsealSecret } from '../settings.js';
import { openPrivate, sealPrivate } from '../security/secrets.js';
import { isTenant } from '../deployment.js';
const ISSUER = 'https://appleid.apple.com';

// Subjects are Apple's stable identifiers. Email (including a private relay) is not an identity key.
// Credentials remain encrypted server-side solely for revocation when deleting the account.
db.exec(`CREATE TABLE IF NOT EXISTS apple_identities (
  subject TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS apple_refresh_tokens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY(user_id, client_id)
);`);

export function saveAppleRefreshToken(userId: string, clientId: string, token: string) {
  db.prepare('INSERT OR REPLACE INTO apple_refresh_tokens(user_id,client_id,token) VALUES (?,?,?)').run(userId, clientId, isTenant ? sealPrivate(userId, `apple:${clientId}`, token) : sealSecret(token));
}

export async function revokeAppleAccess(userId: string) {
  const tokens = db.prepare('SELECT client_id, token FROM apple_refresh_tokens WHERE user_id=?').all(userId) as { client_id: string; token: string }[];
  for (const row of tokens) {
    const token = row.token.startsWith('private1:') ? openPrivate<string>(userId, `apple:${row.client_id}`, row.token) : isTenant ? null : unsealSecret(row.token);
    if (!token) throw new AppleError('apple_revoke_failed');
    const body = new URLSearchParams({ client_id: row.client_id, client_secret: await appleClientSecret(row.client_id), token, token_type_hint: 'refresh_token' });
    const result = await fetch(`${ISSUER}/auth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!result.ok) throw new AppleError('apple_revoke_failed');
    db.prepare('DELETE FROM apple_refresh_tokens WHERE user_id=? AND client_id=?').run(userId, row.client_id);
  }
}
