import { db } from '../db.js';
import { transactionWithEffects } from '../lib/commit-effects.js';
import { projectHandoffEvent } from './rooms.js';

/** A projection and its acknowledgement commit together, including row/task SSE. */
export function projectCommittedHandoffEvent(userId: string, seq: number) {
  if (!db.open || db.inTransaction) return;
  try {
    transactionWithEffects(() => {
      if (!db.prepare(`SELECT 1 FROM handoff_events e WHERE e.seq=? AND e.user_id=?
        AND NOT EXISTS (SELECT 1 FROM handoff_event_projections p WHERE p.event_seq=e.seq)`).get(seq, userId)) return;
      projectHandoffEvent(userId, seq);
      db.prepare('INSERT INTO handoff_event_projections(event_seq) VALUES(?)').run(seq);
    });
  } catch {
    console.error(`[handoff] event ${seq} projection failed; deferred for recovery`);
  }
}

/** Includes historical events and terminal runs. Failed events stay eligible. */
export function recoverHandoffProjections(userId?: string) {
  if (!db.open || db.inTransaction) return;
  let after = 0;
  for (;;) {
    const events = db.prepare(`SELECT e.seq,e.user_id FROM handoff_events e WHERE e.seq>?
      ${userId ? 'AND e.user_id=?' : ''}
      AND NOT EXISTS (SELECT 1 FROM handoff_event_projections p WHERE p.event_seq=e.seq)
      ORDER BY e.seq LIMIT 200`).all(after, ...(userId ? [userId] : [])) as { seq: number; user_id: string }[];
    if (!events.length) return;
    for (const event of events) projectCommittedHandoffEvent(event.user_id, event.seq);
    after = events[events.length - 1].seq;
  }
}
