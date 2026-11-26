import { db } from '../db.js';
import type { CliProviders } from './bridge.js';

// Display-only history. Authorization and generation always use fresh CLI health.
db.exec(`CREATE TABLE IF NOT EXISTS cli_status_history (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  providers TEXT NOT NULL
)`);

export function storedPlanStatus(userId: string): CliProviders | undefined {
  const row = db.prepare('SELECT providers FROM cli_status_history WHERE user_id=?').get(userId) as { providers: string } | undefined;
  if (!row) return;
  try { return JSON.parse(row.providers); } catch { return; }
}

export function savePlanStatus(userId: string, providers: CliProviders) {
  const previous = storedPlanStatus(userId);
  const saved = { ...providers };
  for (const provider of ['codex', 'claude'] as const) {
    // A failed check must not erase the last verified connection.
    if (saved[provider].error && previous?.[provider]) saved[provider] = previous[provider];
  }
  db.prepare('INSERT OR REPLACE INTO cli_status_history(user_id,providers) VALUES (?,?)').run(userId, JSON.stringify(saved));
}

export function clearPlanStatus(userId: string) {
  db.prepare('DELETE FROM cli_status_history WHERE user_id=?').run(userId);
}
