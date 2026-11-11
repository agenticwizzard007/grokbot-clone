import { db, now } from '../db.js';

// Account choice is independent of the server's provider and survives app/server restarts.
db.exec(`CREATE TABLE IF NOT EXISTS local_computer_access (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`);

export function localAccess(userId: string) {
  const row = db.prepare('SELECT enabled, revision FROM local_computer_access WHERE user_id=?').get(userId) as { enabled: number; revision: number } | undefined;
  return { enabled: row?.enabled === 1, revision: row?.revision ?? 0 };
}

export function setLocalAccess(userId: string, enabled: boolean) {
  db.prepare(`INSERT INTO local_computer_access(user_id,enabled,revision,updated_at) VALUES (?,?,1,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,updated_at=excluded.updated_at`)
    .run(userId, Number(enabled), now());
}
