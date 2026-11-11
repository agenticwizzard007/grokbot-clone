import { db, now } from './db.js';
import { archiveVm, destroyVm, driver, ensureVm, resizeVm, suspendVm, vmFor } from './computers/cloudvm.js';
import { getLive } from './store.js';
import { localProvider } from './computers/local.js';
import { newId } from './lib/ids.js';
import { assertLegacyWorkOpen, heldLegacyOwners, legacyWorkHeld, withLegacyWork } from './security/legacy-work.js';

/**
 * Automatic computer setup for cloud VMs (COMPUTER_PROVIDER=cloudvm), with no manual steps:
 *   - a new account gets a 'create' job: its VM is created and booted, and every Bot gets its screen;
 *   - a deleted account gets a 'destroy' job for its VM and disk;
 *   - a new Bot gets a 'resize' job when the VM needs more memory for another screen.
 * Jobs live in the database and are retried with backoff, so a crash or provider hiccup never
 * loses one. A reconcile loop removes VMs the provider has that no account owns.
 * (When we run our own Firecracker hosts, this is the part that moves into Temporal workflows.)
 */

db.exec(`
CREATE TABLE IF NOT EXISTS provision_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  vm_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS provision_jobs_due ON provision_jobs(status, next_at);`);

type Kind = 'create' | 'destroy' | 'resize' | 'archive';

/** Put a new VM to sleep as soon as it's set up (waking takes ~2 s), instead of after the idle timeout. */
const SLEEP_AFTER_SETUP = process.env.VM_SLEEP_AFTER_SETUP !== '0';
/** Archive VMs asleep this long: delete the VM, keep the disk (0 = never). Default 7 days. */
const ARCHIVE_AFTER_MS = Number(process.env.VM_ARCHIVE_AFTER_HOURS ?? 168) * 3600_000;
const ARCHIVE_SWEEP_MS = Number(process.env.VM_ARCHIVE_SWEEP_SEC ?? 3600) * 1000;
interface Job { id: string; kind: Kind; user_id: string | null; vm_id: string | null; status: string; attempts: number }

const MAX_ATTEMPTS = 8;
/** Not a failure: try again later without using up an attempt. */
class Defer extends Error {}
const PARALLEL = Number(process.env.VM_PROVISION_PARALLEL ?? 5);
const running = new Set<string>();

/** Queue work for a user's (or a deleted user's) VM. Duplicate pending jobs are skipped. */
export function enqueueVmJob(kind: Kind, ref: { userId?: string; vmId?: string }) {
  assertLegacyWorkOpen(ref.userId);
  if (ref.vmId) assertLegacyWorkOpen((db.prepare('SELECT user_id FROM vms WHERE vm_id=?').get(ref.vmId) as { user_id: string | null } | undefined)?.user_id);
  const dup = db.prepare("SELECT 1 FROM provision_jobs WHERE kind=? AND status IN ('pending','running') AND COALESCE(user_id,'')=? AND COALESCE(vm_id,'')=?")
    .get(kind, ref.userId ?? '', ref.vmId ?? '');
  if (dup) return;
  db.prepare('INSERT INTO provision_jobs(id,kind,user_id,vm_id,status,next_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(newId('job'), kind, ref.userId ?? null, ref.vmId ?? null, 'pending', now(), now(), now());
  kick();
}

/** Called when an account is deleted: its VM and disk go with it. */
export function enqueueAccountDeletion(userId: string) {
  const vm = vmFor(userId);
  if (vm) enqueueVmJob('destroy', { vmId: vm.vm_id });
}

async function run(job: Job) {
  if (job.kind === 'create') {
    if (!job.user_id || !db.prepare('SELECT 1 FROM users WHERE id=?').get(job.user_id)) return; // account gone meanwhile
    await ensureVm(job.user_id);
    // Give every Bot its screen now, so the first task doesn't wait for one.
    const bots = db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room'").all(job.user_id) as { id: string }[];
    for (const b of bots) {
      const screen = await localProvider.screen(job.user_id, b.id);
      await screen.screenshot();
      // Start the Bot's Chrome and Playwright now, before the VM sleeps: waking restores them ready,
      // so the user's first web task doesn't wait ~15 s for a cold browser start.
      await screen.browser?.('browser_tabs', { action: 'list' }).catch((e) => console.warn(`[provision] browser warm-up for ${b.id}: ${e?.message ?? e}`));
    }
    console.log(`[provision] user=${job.user_id} is ready: VM up, ${bots.length} screen(s)`);
    if (SLEEP_AFTER_SETUP && !(await anyBotBusy(job.user_id))) await suspendVm(job.user_id, 'set up; sleeping until needed');
  } else if (job.kind === 'destroy') {
    if (job.vm_id) await destroyVm(job.vm_id);
  } else if (job.kind === 'archive') {
    if (job.user_id) await archiveVm(job.user_id);
  } else if (job.kind === 'resize') {
    if (!job.user_id || !vmFor(job.user_id)) return;
    if (!vmFor(job.user_id)!.ext_id) return; // archived: the new size applies when its VM is recreated
    // Resizing restarts a running VM (every screen and open tab would be lost), so it waits until the
    // VM is asleep; the new size applies at its next boot. The new Bot's screen works meanwhile.
    const vm = vmFor(job.user_id)!;
    if (!['suspended', 'stopped'].includes(vm.status)) throw new Defer('the computer is in use; resizing when it sleeps');
    await resizeVm(job.user_id);
  }
}

async function runJob(job: Job) {
  const owner = job.user_id ?? (job.vm_id ? (db.prepare('SELECT user_id FROM vms WHERE vm_id=?').get(job.vm_id) as { user_id: string | null } | undefined)?.user_id : null);
  if (legacyWorkHeld(owner)) return;
  return withLegacyWork(owner, () => runAdmittedJob(job, owner));
}

async function runAdmittedJob(job: Job, owner: string | null | undefined) {
  running.add(job.id);
  db.prepare("UPDATE provision_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=?").run(now(), job.id);
  try {
    await run(job);
    db.prepare("UPDATE provision_jobs SET status='done', error=NULL, updated_at=? WHERE id=?").run(now(), job.id);
  } catch (e: any) {
    // The held snapshot keeps the original job state. A provider effect already
    // issued before the hold must be reconciled by the migration adapter.
    if (legacyWorkHeld(owner)) return;
    if (e instanceof Defer) {
      db.prepare("UPDATE provision_jobs SET status='pending', attempts=attempts-1, error=?, next_at=?, updated_at=? WHERE id=?").run(e.message, now() + 60_000, now(), job.id);
      return;
    }
    const attempts = job.attempts + 1;
    const msg = String(e?.message ?? e).slice(0, 500);
    const failed = attempts >= MAX_ATTEMPTS;
    const delay = Math.min(10 * 60_000, 5_000 * 2 ** attempts);
    db.prepare('UPDATE provision_jobs SET status=?, error=?, next_at=?, updated_at=? WHERE id=?').run(failed ? 'failed' : 'pending', msg, now() + delay, now(), job.id);
    console.warn(`[provision] ${job.kind} ${job.user_id ?? job.vm_id} attempt ${attempts} failed${failed ? ' (giving up)' : `; retrying in ${Math.round(delay / 1000)}s`}: ${msg}`);
  } finally {
    running.delete(job.id);
    kick();
  }
}

export function tick() {
  const free = PARALLEL - running.size;
  if (free <= 0) return;
  const due = db.prepare(`SELECT * FROM provision_jobs j WHERE status='pending' AND next_at<=?
    AND COALESCE(j.user_id,(SELECT user_id FROM vms WHERE vm_id=j.vm_id),'') NOT IN (SELECT value FROM json_each(?))
    ORDER BY created_at LIMIT ?`).all(now(), JSON.stringify(heldLegacyOwners()), free + running.size) as Job[];
  for (const job of due) {
    if (running.size >= PARALLEL) break;
    if (running.has(job.id)) continue;
    void runJob(job);
  }
}

async function anyBotBusy(userId: string) {
  const { isBotBusy } = await import('./agent/loop.js');
  const bots = db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[];
  return bots.some((b) => isBotBusy(b.id) || getLive(b.id).isRunning);
}

/** Queue archiving for VMs that have been asleep longer than VM_ARCHIVE_AFTER_HOURS. */
export function sweepLongSleepers() {
  if (!ARCHIVE_AFTER_MS) return 0;
  const due = db.prepare("SELECT user_id FROM vms WHERE user_id IS NOT NULL AND ext_id IS NOT NULL AND status IN ('suspended','stopped') AND updated_at < ?").all(now() - ARCHIVE_AFTER_MS) as { user_id: string }[];
  const admitted = due.filter(v => !legacyWorkHeld(v.user_id));
  for (const v of admitted) enqueueVmJob('archive', { userId: v.user_id });
  return admitted.length;
}

let started = false;
const kick = () => { if (started) setImmediate(tick); };

/** Remove VMs that no account owns (provider side and database side). */
export async function reconcile() {
  const remote = await driver.list();
  const known = new Map((db.prepare('SELECT vm_id, user_id, ext_id FROM vms').all() as { vm_id: string; user_id: string | null; ext_id: string | null }[]).map((r) => [r.vm_id, r]));
  for (const v of remote) {
    const row = v.vmId ? known.get(v.vmId) : undefined;
    // In-flight creation can finish after a hold prevented ext_id bookkeeping.
    // Retain that resource for the source adapter; never treat it as an orphan.
    if (legacyWorkHeld(row?.user_id) || legacyWorkHeld(v.userId)) continue;
    if (!row || row.ext_id !== v.id) {
      console.warn(`[provision] destroying orphan VM ${v.id} (no matching account)`);
      await withLegacyWork(row?.user_id ?? v.userId, () => driver.destroy(v.id)).catch((e) => console.warn(`[provision] orphan ${v.id}: ${e?.message ?? e}`));
    }
  }
  for (const row of known.values()) if (!row.user_id) enqueueVmJob('destroy', { vmId: row.vm_id });
}

/** Start the job worker and the reconcile loop (once per server; skipped with SWARM_NO_SCHEDULER=1). */
export function startProvisioning() {
  if (started || process.env.SWARM_NO_SCHEDULER === '1') return;
  started = true;
  // Jobs that were mid-flight when the server stopped run again (each step is idempotent).
  db.prepare(`UPDATE provision_jobs SET status='pending', next_at=? WHERE status='running'
    AND COALESCE(user_id,(SELECT user_id FROM vms WHERE vms.vm_id=provision_jobs.vm_id),'') NOT IN (SELECT value FROM json_each(?))`).run(now(), JSON.stringify(heldLegacyOwners()));
  if (process.env.VM_PROVISION_EXISTING === '1') {
    const missing = db.prepare('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM vms WHERE user_id IS NOT NULL)').all() as { id: string }[];
    for (const u of missing) if (!legacyWorkHeld(u.id)) enqueueVmJob('create', { userId: u.id });
    if (missing.length) console.log(`[provision] queued VMs for ${missing.length} existing account(s)`);
  }
  setInterval(tick, 2_000).unref();
  if (ARCHIVE_AFTER_MS) {
    setInterval(() => { const n = sweepLongSleepers(); if (n) console.log(`[provision] archiving ${n} long-idle VM(s)`); }, ARCHIVE_SWEEP_MS).unref();
    console.log(`[provision] VMs asleep over ${Math.round((ARCHIVE_AFTER_MS / 3600_000) * 10) / 10} h are archived (VM deleted, disk kept)`);
  }
  const every = Number(process.env.VM_RECONCILE_MIN ?? 10) * 60_000;
  setInterval(() => { reconcile().catch((e) => console.warn('[provision] reconcile failed', e?.message ?? e)); }, every).unref();
  setTimeout(() => { reconcile().catch((e) => console.warn('[provision] reconcile failed', e?.message ?? e)); }, 30_000).unref();
  tick();
  console.log(`[provision] cloud VM setup worker started (driver ${driver.name}, ${PARALLEL} at a time)`);
}

