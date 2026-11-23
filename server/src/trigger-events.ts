import { createHash } from 'node:crypto';
import { db, now } from './db.js';
import { checkRoutineRun } from './routine-limits.js';
import { bindRoutineJob, reserveRoutineRun } from './deliverables/runs.js';
import { legacyWorkHeld } from './security/legacy-work.js';
import { appendRow } from './store.js';

db.exec(`CREATE TABLE IF NOT EXISTS routine_event_receipts (
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL, slug TEXT NOT NULL, payload TEXT NOT NULL,
  received_at INTEGER NOT NULL, job_id TEXT,
  PRIMARY KEY(routine_id,receipt_id)
);
CREATE INDEX IF NOT EXISTS routine_event_pending ON routine_event_receipts(routine_id,received_at)
  WHERE job_id IS NULL;`);

type Enqueue = (botId: string, trigger: any) => string | void;
interface Receipt { receipt_id: string; slug: string; payload: string }

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Retention is synchronous so a tenant inbox can commit its acknowledgement in the same transaction. */
export function retainTriggerEvent(data: any, deliveryId?: string) {
  const ids = [data?.id, data?.metadata?.id, data?.metadata?.nanoId].filter(id => typeof id === 'string' && id);
  if (!ids.length) return;
  // id/uuid in the SDK payload identify the subscription, not an individual event.
  // Tenant delivery IDs preserve even identical payloads from distinct webhooks.
  // Legacy realtime payloads without an event ID can only deduplicate by content.
  const sourceId = data.eventId ?? data.event_id ?? data.log_id ?? data.metadata?.log_id;
  const receiptId = deliveryId ? `delivery:${deliveryId}` : sourceId ? `provider:${sourceId}`
    : `content:${createHash('sha256').update(canonical(data)).digest('hex')}`;
  db.transaction(() => {
    const routines = db.prepare(`SELECT r.id,r.schedule,b.user_id FROM routines r JOIN bots b ON b.id=r.bot_id
      WHERE r.trigger_id IN (${ids.map(() => '?').join(',')}) AND r.enabled=1`).all(...ids) as { id: string; schedule: string; user_id: string }[];
    for (const r of routines) {
      if (legacyWorkHeld(r.user_id)) throw new Error('This account is being migrated.');
      db.prepare(`INSERT OR IGNORE INTO routine_event_receipts(routine_id,receipt_id,slug,payload,received_at)
        VALUES(?,?,?,?,?)`).run(r.id, receiptId, data.triggerSlug ?? r.schedule.slice(6), JSON.stringify(data.payload ?? data.originalPayload ?? {}), now());
    }
  })();
}

/** Admit one bounded batch per eligible routine. Failed admission leaves every receipt pending. */
export function drainTriggerEvents(enqueue: Enqueue) {
  if (!db.open || db.inTransaction) return;
  const pending = db.prepare(`SELECT r.id FROM routines r JOIN routine_event_receipts e ON e.routine_id=r.id
    WHERE r.enabled=1 AND e.job_id IS NULL GROUP BY r.id ORDER BY MIN(e.received_at),r.id`).all() as { id: string }[];
  for (const { id } of pending) {
    try {
      db.transaction(() => {
        const r = db.prepare('SELECT r.*,b.user_id FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND r.enabled=1').get(id) as any;
        if (!r || legacyWorkHeld(r.user_id)) return;
        // Also cover jobs accepted by older versions before execution records existed.
        if (db.prepare(`SELECT 1 FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running')
          AND json_extract(trigger,'$.routineId')=? LIMIT 1`).get(r.bot_id, id)) return;
        const receipts = db.prepare(`SELECT receipt_id,slug,payload FROM routine_event_receipts
          WHERE routine_id=? AND job_id IS NULL ORDER BY received_at,rowid LIMIT 50`).all(id) as Receipt[];
        if (!receipts.length) return;
        // Bound batches without truncating any individual payload. Excess events stay pending.
        const batch: Receipt[] = [];
        let bytes = 0;
        for (const receipt of receipts) {
          const size = Buffer.byteLength(receipt.payload);
          if (batch.length && bytes + size > 128 * 1024) break;
          batch.push(receipt); bytes += size;
        }
        const reserved = reserveRoutineRun({ userId: r.user_id, botId: r.bot_id, routineId: id,
          name: r.name, kind: 'event', fireKey: `event:${batch[0].receipt_id}` });
        if (!reserved.created) throw new Error('Event batch already reserved.');
        const check = checkRoutineRun(r, 'event');
        if (!check.ok) throw new Error(check.reason);
        const prompt = r.prompt + batch.map(e => `\n\n[Event: ${e.slug}]\n${e.payload}`).join('');
        const jobId = enqueue(r.bot_id, { type: 'routine', routineId: id, routineRunId: reserved.run.id, name: r.name, prompt });
        if (!jobId) throw new Error('Event admission requires a durable job receipt.');
        bindRoutineJob(r.user_id, reserved.run.id, jobId);
        for (const receipt of batch) db.prepare('UPDATE routine_event_receipts SET job_id=? WHERE routine_id=? AND receipt_id=?')
          .run(jobId, id, receipt.receipt_id);
        db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), id);
        appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Routine triggered: ${r.name}`, ref: id });
      })();
    } catch {
      // Limits, full queues and transient failures defer this routine, not the rest of the inbox.
    }
  }
}
