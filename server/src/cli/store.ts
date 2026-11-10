import { db, now } from '../db.js';
import { sha256, token } from '../lib/ids.js';

export type CliProvider = 'codex' | 'claude';
export const isCliProvider = (v: unknown): v is CliProvider => v === 'codex' || v === 'claude';

db.exec(`
CREATE TABLE IF NOT EXISTS cli_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude'))
);
CREATE TABLE IF NOT EXISTS cli_pairings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS cli_runtimes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  location TEXT NOT NULL CHECK(location IN ('server','bridge'))
);
`);

export type CliRuntime = 'server' | 'bridge';
/** Existing pairings keep their local runtime; new accounts use a server profile. */
export function cliRuntime(userId: string): CliRuntime {
  const saved = db.prepare('SELECT location FROM cli_runtimes WHERE user_id=?').get(userId) as { location: CliRuntime } | undefined;
  if (saved) return saved.location;
  return db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get(userId) ? 'bridge' : 'server';
}

export function setCliRuntime(userId: string, location: CliRuntime) {
  db.prepare('INSERT OR REPLACE INTO cli_runtimes(user_id,location) VALUES (?,?)').run(userId, location);
}

export function selectedCli(userId: string | null | undefined): CliProvider | null {
  if (!userId) return null;
  return (db.prepare('SELECT provider FROM cli_preferences WHERE user_id=?').get(userId) as { provider: CliProvider } | undefined)?.provider ?? null;
}

export function selectCli(userId: string, provider: CliProvider | null) {
  if (provider) db.prepare('INSERT OR REPLACE INTO cli_preferences(user_id,provider) VALUES (?,?)').run(userId, provider);
  else db.prepare('DELETE FROM cli_preferences WHERE user_id=?').run(userId);
}

export function createCliPairing(userId: string): string {
  const secret = token();
  db.prepare('INSERT OR REPLACE INTO cli_pairings(user_id,token_hash,expires_at) VALUES (?,?,?)').run(userId, sha256(secret), now() + 600_000);
  setCliRuntime(userId, 'bridge');
  return secret;
}

export function authenticateCli(secret: string): string | null {
  if (secret.length > 256) return null;
  const hash = sha256(secret);
  const row = db.prepare('SELECT user_id,expires_at FROM cli_pairings WHERE token_hash=?').get(hash) as { user_id: string; expires_at: number | null } | undefined;
  if (!row || (row.expires_at !== null && row.expires_at < now())) return null;
  db.prepare('UPDATE cli_pairings SET expires_at=NULL WHERE token_hash=?').run(hash);
  return row.user_id;
}

export function revokeCliPairing(userId: string) {
  db.prepare('DELETE FROM cli_pairings WHERE user_id=?').run(userId);
}
