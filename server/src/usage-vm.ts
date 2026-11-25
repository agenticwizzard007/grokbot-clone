import { reportDay, reportDayStart, shiftDay } from './report-days.js';
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

/** Legacy VM metering stores UTC daily aggregates, without individual sample timestamps.
 * For another zone, allocate each recorded day's estimates by its overlap with local days.
 * Keep this explicit in the report: exact intraday running times cannot be recovered.
 */
export function computerCsvRows(userId: string | null, fromDay: string, toDay: string, timezone = 'UTC', at = Date.now()): any[] {
  const from = reportDayStart(fromDay, timezone);
  const to = Math.min(at, reportDayStart(shiftDay(toDay, 1), timezone));
  const utcFrom = reportDay(from, 'UTC'), utcTo = reportDay(Math.max(from, to - 1), 'UTC');
  const rows = (userId
    ? db.prepare('SELECT * FROM vm_usage WHERE user_id=? AND day>=? AND day<=? ORDER BY day, vm_key, state').all(userId, utcFrom, utcTo)
    : db.prepare('SELECT * FROM vm_usage WHERE day>=? AND day<=? ORDER BY day, vm_key, state').all(utcFrom, utcTo)) as any[];
  if (timezone === 'UTC') return rows;
  const days: { day: string; from: number; to: number }[] = [];
  for (let day = fromDay; day <= toDay; day = shiftDay(day, 1)) {
    days.push({ day, from: reportDayStart(day, timezone), to: Math.min(at, reportDayStart(shiftDay(day, 1), timezone)) });
  }
  return rows.flatMap(row => {
    const start = Date.parse(`${row.day}T00:00:00Z`);
    const end = Math.min(start + 86_400_000, at);
    if (end <= start) return [];
    return days.flatMap(day => {
      const overlap = Math.max(0, Math.min(end, day.to) - Math.max(start, day.from));
      const share = overlap / (end - start);
      return share > 0 ? [{ ...row, day: day.day, seconds: row.seconds * share, cost_usd: row.cost_usd * share }] : [];
    });
  });
}

export function computerTotals(userId: string | null, fromDay: string, toDay: string, timezone = 'UTC', at = Date.now()): ComputerTotals {
  const rows = computerCsvRows(userId, fromDay, toDay, timezone, at);
  const mine = userId ? currentMachines().find((m) => m.userId === userId) : undefined;
  const hours = (state: VmState) => rows.filter(row => row.state === state).reduce((sum, row) => sum + row.seconds / 3600, 0);
  return {
    costUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0), runningHours: hours('running'), asleepHours: hours('asleep'), archivedHours: hours('archived'),
    now: mine ? { provider: mine.provider, state: mine.state, cpus: mine.cpus, memoryMb: mine.memoryMb, diskGb: mine.diskGb, perHourUsd: costPerSecond(mine) * 3600 } : null,
  };
}

/** Computer estimates use the same local-day allocation in every report view and export. */
export function computerByDay(userId: string | null, fromDay: string, toDay: string, timezone = 'UTC', at = Date.now()): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of computerCsvRows(userId, fromDay, toDay, timezone, at)) result.set(row.day, (result.get(row.day) ?? 0) + row.cost_usd);
  return result;
}

export function computerByUser(fromDay: string, toDay: string, timezone = 'UTC', at = Date.now()): Map<string, { costUsd: number; runningHours: number }> {
  const result = new Map<string, { costUsd: number; runningHours: number }>();
  for (const row of computerCsvRows(null, fromDay, toDay, timezone, at)) {
    const key = row.user_id ?? '';
    const total = result.get(key) ?? { costUsd: 0, runningHours: 0 };
    total.costUsd += row.cost_usd;
    if (row.state === 'running') total.runningHours += row.seconds / 3600;
    result.set(key, total);
  }
  return result;
}
