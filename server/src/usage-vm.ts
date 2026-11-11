import { legacyWorkHeld } from './security/legacy-work.js';
import { db, now } from './db.js';
import { env } from './env.js';

/**
 * Computer (VM) usage for the usage monitor. Every minute the meter reads each account's computer
 * (cloud VMs in `vms`, Orgo boxes in `computers`) and adds the elapsed time, by state, to that
 * account's day. Costs are estimates from the provider's published rates (Fly.io Machines bill by the
 * second; nothing reports a per-VM cost back to us), and every rate can be overridden in the env.
 * The meter only reads the computer tables; it never changes a computer.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS vm_usage (
  day TEXT NOT NULL,
  user_id TEXT,
  vm_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  cpus INTEGER,
  memory_mb INTEGER,
  disk_gb REAL,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, vm_key, state)
);
CREATE INDEX IF NOT EXISTS vm_usage_user_day ON vm_usage(user_id, day);
`);

const rate = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== '' && process.env[name] != null ? v : fallback;
};

/** Published prices (USD). Fly.io, iad/ewr, shared CPUs; Orgo pay-as-you-go Medium. */
export const vmRates = () => ({
  hoursPerMonth: 730,
  fly: {
    cpuMonth: rate('VM_PRICE_CPU_MONTH', 2.19), // per shared vCPU, includes 256 MB
    ramGbMonth: rate('VM_PRICE_RAM_GB_MONTH', 6.0), // extra RAM beyond 256 MB per vCPU
    rootfsGbMonth: rate('VM_PRICE_ROOTFS_GB_MONTH', 0.15), // while stopped or suspended
    rootfsGb: rate('VM_ROOTFS_GB', 3),
    volumeGbMonth: rate('VM_PRICE_VOLUME_GB_MONTH', 0.15), // provisioned, whatever the machine's state
  },
  orgo: {
    runningHour: rate('ORGO_PRICE_RUNNING_HOUR', 0.055),
    stoppedHour: rate('ORGO_PRICE_STOPPED_HOUR', 0.0027),
  },
});

export type VmState = 'running' | 'asleep' | 'archived';

interface Machine { key: string; userId: string | null; provider: string; state: VmState; cpus: number | null; memoryMb: number | null; diskGb: number | null }

const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Map a computer's status to how it is billed. Starting, resuming and suspending machines are running. */
export function billedState(status: string): VmState | null {
  if (['running', 'starting', 'resuming', 'creating', 'suspending', 'stopping'].includes(status)) return 'running';
  if (['suspended', 'stopped', 'error'].includes(status)) return 'asleep';
  if (status === 'archived') return 'archived';
  return null; // absent, destroyed: nothing to bill
}

/** Every computer that costs something right now. */
export function currentMachines(): Machine[] {
  const out: Machine[] = [];
  if (tableExists('vms')) {
    for (const v of db.prepare('SELECT * FROM vms').all() as any[]) {
      const state = billedState(String(v.status));
      if (!state) continue;
      if (state === 'archived' && !v.volume_id) continue; // archived without a disk costs nothing
      out.push({ key: `vm:${v.vm_id}`, userId: v.user_id ?? null, provider: `cloudvm-${v.driver ?? 'fly'}`, state, cpus: v.cpus ?? env.vmCpus, memoryMb: v.memory_mb ?? env.vmBaseMemoryMb + env.vmScreenMemoryMb, diskGb: env.vmVolumeGb });
    }
  }
  for (const c of db.prepare("SELECT user_id, orgo_id, status FROM computers WHERE orgo_id IS NOT NULL").all() as any[]) {
    const state = billedState(String(c.status));
    if (!state || state === 'archived') continue;
    out.push({ key: `orgo:${c.orgo_id}`, userId: c.user_id, provider: 'orgo', state, cpus: null, memoryMb: null, diskGb: null });
  }
  return out;
}

/** Estimated cost per second of a machine in its current state. Fake (dev/test) VMs cost nothing. */
export function costPerSecond(m: Machine): number {
  const r = vmRates();
  const sec = r.hoursPerMonth * 3600;
  if (m.provider === 'orgo') return (m.state === 'running' ? r.orgo.runningHour : r.orgo.stoppedHour) / 3600;
  if (m.provider === 'cloudvm-fake') return 0;
  const volume = (m.diskGb ?? 0) * r.fly.volumeGbMonth;
  if (m.state === 'archived') return volume / sec;
  if (m.state === 'asleep') return (r.fly.rootfsGb * r.fly.rootfsGbMonth + volume) / sec;
  const cpus = m.cpus ?? 1;
  const ramGb = (m.memoryMb ?? 256 * cpus) / 1024;
  const compute = cpus * r.fly.cpuMonth + Math.max(0, ramGb - cpus * 0.25) * r.fly.ramGbMonth;
  return (compute + volume) / sec;
}

const upsert = () => db.prepare(`INSERT INTO vm_usage(day,user_id,vm_key,provider,state,seconds,cpus,memory_mb,disk_gb,cost_usd,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(day, vm_key, state) DO UPDATE SET seconds=seconds+excluded.seconds, cost_usd=cost_usd+excluded.cost_usd,
    user_id=excluded.user_id, cpus=excluded.cpus, memory_mb=excluded.memory_mb, disk_gb=excluded.disk_gb, updated_at=excluded.updated_at`);

/** Add `seconds` of each current computer's state to today's totals. */
export function recordVmSeconds(seconds: number, at = now()) {
  if (!(seconds > 0)) return;
  const day = new Date(at).toISOString().slice(0, 10);
  const stmt = upsert();
  db.transaction(() => {
    for (const m of currentMachines()) {
      if (legacyWorkHeld(m.userId)) continue;
      stmt.run(day, m.userId, m.key, m.provider, m.state, seconds, m.cpus, m.memoryMb, m.diskGb, seconds * costPerSecond(m), at);
    }
  })();
}

let timer: NodeJS.Timeout | null = null;

/** Start the meter (once per server; skipped with SWARM_NO_SCHEDULER=1 so test servers sharing a database don't double count). */
export function startVmMeter() {
  if (timer || process.env.SWARM_NO_SCHEDULER === '1') return;
  const every = Math.max(5, rate('USAGE_VM_SAMPLE_SEC', 60)) * 1000;
  let last = now();
  timer = setInterval(() => {
    const t = now();
    // Count at most two intervals, so a sleeping laptop or a paused process doesn't bill the gap.
    const dt = Math.min(t - last, 2 * every) / 1000;
    last = t;
    try { recordVmSeconds(dt, t); } catch (e) { console.warn('[usage] VM meter failed', (e as Error)?.message); }
  }, every);
  timer.unref();
}

// ---------- reporting ----------

export interface ComputerTotals {
  costUsd: number;
  runningHours: number;
  asleepHours: number;
  archivedHours: number;
  /** The account's computer right now (own scope only). */
  now: { provider: string; state: VmState; cpus: number | null; memoryMb: number | null; diskGb: number | null; perHourUsd: number } | null;
}

export function computerTotals(userId: string | null, fromDay: string, toDay: string): ComputerTotals {
  const where = userId ? 'user_id=? AND day>=? AND day<=?' : 'day>=? AND day<=?';
  const args = userId ? [userId, fromDay, toDay] : [fromDay, toDay];
  const r = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) cost,
      COALESCE(SUM(CASE WHEN state='running' THEN seconds END),0) run, COALESCE(SUM(CASE WHEN state='asleep' THEN seconds END),0) sleep,
      COALESCE(SUM(CASE WHEN state='archived' THEN seconds END),0) arch FROM vm_usage WHERE ${where}`).get(...args) as any;
  const mine = userId ? currentMachines().find((m) => m.userId === userId) : undefined;
  return {
    costUsd: r.cost, runningHours: r.run / 3600, asleepHours: r.sleep / 3600, archivedHours: r.arch / 3600,
    now: mine ? { provider: mine.provider, state: mine.state, cpus: mine.cpus, memoryMb: mine.memoryMb, diskGb: mine.diskGb, perHourUsd: costPerSecond(mine) * 3600 } : null,
  };
}

/** Computer cost per day (for the daily chart) and per account (for the owner's view). */
export function computerByDay(userId: string | null, fromDay: string, toDay: string): Map<string, number> {
  const where = userId ? 'user_id=? AND day>=? AND day<=?' : 'day>=? AND day<=?';
  const args = userId ? [userId, fromDay, toDay] : [fromDay, toDay];
  return new Map((db.prepare(`SELECT day, SUM(cost_usd) cost FROM vm_usage WHERE ${where} GROUP BY day`).all(...args) as any[]).map((r) => [r.day, r.cost]));
}

export function computerByUser(fromDay: string, toDay: string): Map<string, { costUsd: number; runningHours: number }> {
  return new Map((db.prepare(`SELECT user_id, SUM(cost_usd) cost, SUM(CASE WHEN state='running' THEN seconds ELSE 0 END) run
    FROM vm_usage WHERE day>=? AND day<=? GROUP BY user_id`).all(fromDay, toDay) as any[]).map((r) => [r.user_id ?? '', { costUsd: r.cost, runningHours: r.run / 3600 }]));
}

export function computerCsvRows(userId: string | null, fromDay: string, toDay: string): any[] {
  return userId
    ? db.prepare('SELECT * FROM vm_usage WHERE user_id=? AND day>=? AND day<=? ORDER BY day, vm_key, state').all(userId, fromDay, toDay)
    : db.prepare('SELECT * FROM vm_usage WHERE day>=? AND day<=? ORDER BY day, vm_key, state').all(fromDay, toDay);
}
