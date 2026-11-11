import { db, now } from '../db.js';
import { heldLegacyOwners, legacyWorkHeld, withLegacyWork } from '../security/legacy-work.js';

/**
 * Durable inbox for webhook events. An event is saved before the webhook
 * is acknowledged, deduplicated by its id, handled in the background in arrival order, retried with backoff on
 * failure (3 attempts), and replayed at boot if the server stopped mid-way. Deliveries are at least once; the id
 * makes them effectively once.
 */

type Handler = (payload: any) => Promise<void>;
const handlers = new Map<string, Handler>();
const MAX_ATTEMPTS = 3;
let running: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;
const eligible = `NOT EXISTS (SELECT 1 FROM users u WHERE u.phone=swarm_legacy_inbox_phone(messaging_inbox.source,messaging_inbox.payload)
  AND u.id IN (SELECT value FROM json_each(?)))`;

export function registerInboxHandler(source: string, fn: Handler) { handlers.set(source, fn); }

/** Save an event. Returns false if it was already received (a redelivery). */
export function accept(source: string, id: string, payload: unknown): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO messaging_inbox(id,source,payload,status,next_at,created_at) VALUES (?,?,?,?,?,?)')
    .run(`${source}:${id}`, source, JSON.stringify(payload), 'pending', now(), now());
  if (r.changes) kick();
  return r.changes > 0;
}

/** Process pending events now (and keep going until none are due). */
export function kick(): Promise<void> {
  if (running) return running;
  running = (async () => {
    // Yield first: if nothing is due, the body would otherwise finish (and clear `running`) before this
    // assignment completes, leaving a settled promise stuck in `running` and the inbox never processed again.
    await null;
    try {
      for (;;) {
        const ev = db.prepare(`SELECT * FROM messaging_inbox WHERE status='pending' AND next_at<=? AND ${eligible} ORDER BY created_at, rowid LIMIT 1`).get(now(), JSON.stringify(heldLegacyOwners())) as any;
        if (!ev) break;
        const owners = db.prepare('SELECT id FROM users WHERE phone=swarm_legacy_inbox_phone(?,?)').all(ev.source, ev.payload) as { id: string }[];
        const owner = owners[0]?.id;
        const fn = handlers.get(ev.source);
        if (!fn) { db.prepare("UPDATE messaging_inbox SET status='failed', error='no handler' WHERE id=?").run(ev.id); continue; }
        try {
          if (owners.length > 1) throw new Error('Inbox account ownership is ambiguous.');
          await withLegacyWork(owner, () => fn(JSON.parse(ev.payload)));
          db.prepare("UPDATE messaging_inbox SET status='done', attempts=attempts+1, error=NULL WHERE id=?").run(ev.id);
        } catch (e) {
          if (legacyWorkHeld(owner)) continue;
          const attempts = ev.attempts + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          db.prepare('UPDATE messaging_inbox SET status=?, attempts=?, next_at=?, error=? WHERE id=?')
            .run(failed ? 'failed' : 'pending', attempts, now() + 2000 * 4 ** (attempts - 1), String((e as Error).message ?? e).slice(0, 500), ev.id);
          console.warn(`[inbox] ${ev.id} ${failed ? 'failed' : 'will retry'}: ${(e as Error).message}`);
        }
      }
    } finally {
      running = null;
      schedule();
    }
  })();
  return running;
}

function schedule() {
  if (timer) clearTimeout(timer);
  const held = JSON.stringify(heldLegacyOwners());
  const next = db.prepare(`SELECT MIN(next_at) t FROM messaging_inbox WHERE status='pending' AND ${eligible}`).get(held) as { t: number | null };
  if (next?.t) timer = setTimeout(() => { timer = null; void kick(); }, Math.max(50, next.t - now())).unref();
  // Keep a week of history for dedupe; older handled events go.
  db.prepare(`DELETE FROM messaging_inbox WHERE status IN ('done','failed') AND created_at<? AND ${eligible}`).run(now() - 7 * 86_400_000, held);
}

/** Wait until nothing is due (tests). */
export async function settle() { while (running) await running; }

/** Replay anything left pending by a restart. */
export function resumeInbox() {
  const n = (db.prepare("SELECT COUNT(*) n FROM messaging_inbox WHERE status='pending'").get() as any).n;
  if (n) console.log(`[inbox] replaying ${n} pending event(s)`);
  void kick();
}

export const inboxStats = () => db.prepare('SELECT status, COUNT(*) n FROM messaging_inbox GROUP BY status').all() as { status: string; n: number }[];
