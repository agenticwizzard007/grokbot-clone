import { db } from './db.js';
import { readSuggestionSnapshot } from './suggestion-snapshot.js';

export function storedSuggestions(raw: string | null | undefined) {
  if (!raw || raw.length > 4000) return;
  try { return readSuggestionSnapshot(JSON.parse(raw)); } catch { return; }
}

export function saveSuggestions(userId: string, botId: string, value: unknown): boolean {
  const snapshot = readSuggestionSnapshot(value);
  if (!snapshot) return false;
  // The Bot owns its snapshot, so deletion also deletes it. Recheck ownership
  // after asynchronous providers settle, and reject out-of-order refreshes.
  return db.transaction(() => {
    const bot = db.prepare('SELECT suggestions_snapshot FROM bots WHERE id=? AND user_id=?').get(botId, userId) as { suggestions_snapshot: string | null } | undefined;
    if (!bot || (storedSuggestions(bot.suggestions_snapshot)?.computedAt ?? -1) > snapshot.computedAt) return false;
    db.prepare('UPDATE bots SET suggestions_snapshot=? WHERE id=? AND user_id=?').run(JSON.stringify(snapshot), botId, userId);
    return true;
  })();
}
