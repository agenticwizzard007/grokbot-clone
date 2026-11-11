import type Database from 'better-sqlite3';
import { legacyAccountHeld } from '../platform/legacy-database-fence.js';

/** Admission and accounting only: ordinary calls remain fully concurrent. This
 * does not represent subprocess, VM or filesystem quiescence. A source adapter
 * must stop those separately before issuing a migration source checkpoint. */
export class LegacyActivityGate {
  private active = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  constructor(private db: Database.Database) {}
  run<T>(tenant: string | null | undefined, fn: () => T): T {
    if (!tenant) return fn();
    if (legacyAccountHeld(this.db, tenant)) throw new Error('This account is being migrated.');
    this.active.set(tenant, this.count(tenant) + 1);
    const release = () => {
      const remaining = this.count(tenant) - 1;
      if (remaining) this.active.set(tenant, remaining); else this.active.delete(tenant);
      if (!remaining) for (const listener of this.listeners.get(tenant) ?? []) listener();
    };
    try {
      const result = fn();
      if (result && typeof (result as any).then === 'function') return Promise.resolve(result).finally(release) as T;
      release(); return result;
    } catch (error) { release(); throw error; }
  }
  count(tenant: string) { return this.active.get(tenant) ?? 0; }
  async drain(tenant: string, timeoutMs = 10000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !legacyAccountHeld(this.db, tenant)) throw new Error('A durable account hold is required before draining work.');
    if (this.count(tenant)) await new Promise<void>((resolve, reject) => {
      const listeners = this.listeners.get(tenant) ?? new Set<() => void>(); this.listeners.set(tenant, listeners);
      const cleanup = () => { clearTimeout(timer); listeners.delete(done); if (!listeners.size) this.listeners.delete(tenant); };
      const done = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Legacy activities have not stopped; migration remains held.')); }, timeoutMs);
      listeners.add(done);
      if (!this.count(tenant)) done();
    });
    if (!legacyAccountHeld(this.db, tenant)) throw new Error('Legacy migration hold changed while draining.');
    return { tenant, active: 0, boundary: 'tracked-usage-only' as const };
  }
}
