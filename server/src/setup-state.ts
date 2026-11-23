import { db, now } from './db.js';

/** Shared by roster serialization and the turn/setup readers. */
export function setupOnboarding(botId: string) {
  const row = db.prepare('SELECT onboarding_status, revision, confirmed_at FROM bot_setups WHERE bot_id=?').get(botId) as {
    onboarding_status: 'interviewing' | 'review' | 'active'; revision: number; confirmed_at: number | null;
  } | undefined;
  if (!row) return null;
  // Both explicit restart and draft editing clear confirmed_at. A retained
  // confirmation is activation evidence; brief completeness alone never is.
  if (row.confirmed_at !== null && row.onboarding_status !== 'active') {
    db.prepare("UPDATE bot_setups SET onboarding_status='active', revision=revision+1, updated_at=? WHERE bot_id=? AND revision=? AND confirmed_at IS NOT NULL").run(now(), botId, row.revision);
    row.onboarding_status = 'active';
    row.revision++;
  }
  return { status: row.onboarding_status, revision: row.revision, confirmedAt: row.confirmed_at };
}
