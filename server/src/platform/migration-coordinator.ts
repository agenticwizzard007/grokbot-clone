import { Directory, opaqueToken } from './directory.js';
import type {PoolClient} from 'pg';

const digest = (s: string) => /^[a-f0-9]{64}$/.test(s);
export interface SourceCheckpoint { tenant: string; checkpoint: string; fence: string; writersStopped: boolean; filesFrozen: boolean }
export interface TargetCheckpoint { tenant: string; checkpoint: string; machine: string; volume: string; generation: string }
/** These are trusted operational adapters, not tenant/browser input. All effects must
 * persist operation IDs, reject older fences, and check directory authorization at
 * the point of effect. stop must fence pending starts as well as running writers.
 * No production adapter is enabled until this contract passes staging qualification. */
export interface MigrationSource {
  freeze(tenant: string, operation: string, fence: string): Promise<SourceCheckpoint>;
  inspect(tenant: string, operation: string): Promise<SourceCheckpoint | null>;
  frozen(tenant: string, sourceFence: string): Promise<boolean>;
  restore(tenant: string, operation: string, checkpoint: TargetCheckpoint, fence: string): Promise<{ checkpoint: string; writersStopped: boolean }>;
  resume(tenant: string, operation: string, checkpoint: string, fence: string): Promise<void>;
  resumeState(tenant: string, operation: string): Promise<{ state: 'active' | 'stopped' | 'uncertain'; checkpoint?: string }>;
  stop(tenant: string, operation: string, fence: string): Promise<boolean>;
}
export interface MigrationTarget {
  verify(tenant: string, packageHash: string, sourceCheckpoint: string): Promise<boolean>;
  activate(tenant: string, operation: string, fence: string): Promise<TargetCheckpoint>;
  inspect(tenant: string, operation: string): Promise<{ state: 'absent' | 'active' | 'uncertain'; checkpoint?: TargetCheckpoint }>;
  freeze(tenant: string, operation: string, fence: string): Promise<TargetCheckpoint & { writersStopped: boolean }>;
  stop(tenant: string, operation: string, fence: string): Promise<boolean>;
}
/** Durable orchestration only. Requires qualified source/target adapters; it never
 * guesses whether an interrupted external action succeeded or silently retries it. */
export class MigrationCoordinator {
  constructor(private directory: Directory, private source: MigrationSource, private target: MigrationTarget, private revoke: (tenant: string) => void) {}

  /** Reserve the immutable operation before freezing. The package must be built
   * from that held checkpoint, not an earlier snapshot of a still-live source. */
  async beginExport(tenant: string) {
    await this.directory.transaction(async c => {
      const owner = (await c.query("SELECT * FROM tenants WHERE id=$1 AND state='pending' FOR UPDATE", [tenant])).rows[0];
      if (!owner || !(await c.query('SELECT 1 FROM identities WHERE tenant_id=$1', [tenant])).rowCount) throw new Error('A verified immutable identity and inactive destination are required.');
      const current = (await c.query('SELECT phase FROM migration_runs WHERE tenant_id=$1', [tenant])).rows[0];
      if (current && !['reserved', 'source_freezing', 'exporting'].includes(current.phase)) throw new Error('Migration already exists or requires reconciliation.');
      // Even an expired provisioning lease can have an outstanding Fly request.
      // Import must be reserved before any generic provisioner has touched it.
      const jobs = (await c.query('SELECT * FROM lifecycle_jobs WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows;
      if (owner.fly_app || owner.machine_id || owner.volume_id || jobs.some(j => j.attempts > 0 || j.state !== 'queued' && !(current && j.state === 'cancelled'))) throw new Error('Provisioning has started; reconcile infrastructure before migration.');
      if (!current) {
        await c.query("INSERT INTO migration_runs(tenant_id,id,phase) VALUES($1,$2,'reserved')", [tenant, opaqueToken()]);
        await c.query("UPDATE lifecycle_jobs SET state='cancelled',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND operation='create'", [tenant]);
      }
    });
    const { row, guard, update, close } = await this.claim(tenant);
    let effects = false;
    try {
      if (!['reserved', 'source_freezing', 'exporting'].includes(row.phase)) throw new Error('Migration export requires reconciliation.');
      effects = true;
      await guard();
      let frozen = await this.source.inspect(tenant, row.id);
      if (!frozen) {
        if (row.phase !== 'reserved') throw new Error('Source freeze outcome is uncertain.');
        await update('source_freezing', 'legacy');
        frozen = await this.source.freeze(tenant, row.id, String(row.fence));
      }
      this.validSource(tenant, frozen);
      if (row.source_checkpoint && (row.source_checkpoint !== frozen.checkpoint || row.source_fence !== frozen.fence)) throw new Error('Source checkpoint changed during export.');
      if (!await this.source.frozen(tenant, frozen.fence)) throw new Error('Source is not held for export.');
      await update('exporting', 'none', { source_checkpoint: frozen.checkpoint, source_fence: frozen.fence, error_code: null });
      return { tenant, operation: row.id as string, checkpoint: frozen.checkpoint, sourceFence: frozen.fence };
    } catch (error) {
      if (effects) await this.contain(tenant, row);
      throw error;
    } finally { await close(); }
  }

  async prepare(tenant: string, packageHash: string, sourceCheckpoint: string) {
    if (!digest(packageHash) || !digest(sourceCheckpoint)) throw new Error('Verified package/checkpoint digests required.');
    const { row, guard, update, close } = await this.claim(tenant);
    let effects = false;
    try {
      if (row.phase !== 'exporting' || row.source_checkpoint !== sourceCheckpoint) throw new Error('Freeze and export the exact source checkpoint before preparing cutover.');
      effects = true;
      const frozen = await this.source.inspect(tenant, row.id);
      this.validSource(tenant, frozen);
      if (frozen.checkpoint !== sourceCheckpoint || frozen.fence !== row.source_fence || !await this.source.frozen(tenant, frozen.fence)) throw new Error('Source checkpoint changed during export.');
      if (!await this.target.verify(tenant, packageHash, sourceCheckpoint)) throw new Error('Migration package is not verified.');
      await guard();
      if (!await this.source.frozen(tenant, frozen.fence)) throw new Error('Source resumed while verifying its package.');
      await update('prepared', 'none', { package_hash: packageHash, error_code: null });
    } catch (error) {
      if (effects) await this.contain(tenant, row);
      throw error;
    } finally { await close(); }
  }

  private async claim(tenant: string) {
    const lease = opaqueToken();
    const row = await this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      return (await client.query(`UPDATE migration_runs m SET lease_owner=$2,lease_until=clock_timestamp()+interval '2 minutes',fence=fence+1 FROM tenants t
      WHERE m.tenant_id=$1 AND t.id=m.tenant_id AND t.state NOT IN ('deleting','deleted','failed')
      AND (m.lease_until IS NULL OR m.lease_until<clock_timestamp()) RETURNING m.*`, [tenant, lease])).rows[0];
    });
    if (!row) throw new Error('Migration is absent, revoked or already leased.');
    const fenced = async<T>(action:(client:PoolClient)=>Promise<T>)=>this.directory.transaction(async client=>{
      // Transfer, cutover and deletion all lock tenant before migration. Read
      // authorization/time after waits, rather than a stale statement snapshot.
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      await client.query('SELECT id FROM migration_runs WHERE tenant_id=$1 FOR UPDATE',[tenant]);
      const changed = await client.query(`UPDATE migration_runs m SET lease_until=clock_timestamp()+interval '2 minutes' FROM tenants t
        WHERE m.tenant_id=$1 AND m.lease_owner=$2 AND m.fence=$3 AND m.lease_until>clock_timestamp() AND t.id=m.tenant_id AND t.state NOT IN ('deleting','deleted','failed') RETURNING m.id`, [tenant, lease, row.fence]);
      if (!changed.rowCount) throw new Error('Migration lease or account revoked.');
      return action(client);
    });
    const guard = () => fenced(async()=>{});
    let heartbeatBusy=false;
    const heartbeat = setInterval(() => {if(heartbeatBusy)return;heartbeatBusy=true;void guard().catch(() => {}).finally(()=>{heartbeatBusy=false;});}, 20000).unref();
    const update = async (phase: string, writer: string, fields: Record<string, unknown> = {}) => {
      const allowed = new Set(['source_fence', 'source_checkpoint', 'package_hash', 'target_checkpoint', 'target_generation', 'target_machine', 'target_volume', 'error_code']);
      if (Object.keys(fields).some(k => !allowed.has(k))) throw new Error('Invalid migration metadata.');
      const names = Object.keys(fields);
      await fenced(async client=>{await client.query(`UPDATE migration_runs SET phase=$2,writer=$3,updated_at=clock_timestamp()${names.map((name, i) => `,${name}=$${i + 4}`).join('')}
        WHERE tenant_id=$1`, [tenant, phase, writer, ...Object.values(fields)]);});
    };
    const close = async () => {
      clearInterval(heartbeat);
      await this.directory.pool.query('UPDATE migration_runs SET lease_until=NULL WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3', [tenant, lease, row.fence]);
    };
    return { row, guard, update, close, fenced };
  }

  private validTarget(tenant: string, target: TargetCheckpoint | undefined): asserts target is TargetCheckpoint {
    if (!target || target.tenant !== tenant || !digest(target.checkpoint) || !/^[A-Za-z0-9_-]{1,120}$/.test(target.machine) || !/^[A-Za-z0-9_-]{1,120}$/.test(target.volume) || !/^[1-9]\d*$/.test(target.generation)) throw new Error('Invalid target activation receipt.');
  }
  private validSource(tenant: string, source: SourceCheckpoint | null): asserts source is SourceCheckpoint {
    if (!source || source.tenant !== tenant || !digest(source.checkpoint) || typeof source.fence !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(source.fence) || source.writersStopped !== true || source.filesFrozen !== true) throw new Error('Source writers and files are not proven frozen.');
  }

  private async contain(tenant: string, row: any) {
    // Block directory routing immediately. If a newer worker owns this migration,
    // only its fence may mutate directory state; adapters enforce the same rule.
    let metadataError:unknown;
    try{await this.directory.transaction(async c => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      const current = await c.query('SELECT 1 FROM migration_runs WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3 FOR UPDATE', [tenant, row.lease_owner, row.fence]);
      if (!current.rowCount) return;
      await c.query("UPDATE tenants SET state='suspended',generation=generation+1 WHERE id=$1 AND state NOT IN ('deleting','deleted')", [tenant]);
      await c.query("UPDATE migration_runs SET phase='reconciliation',writer='unknown',error_code='containment_pending',updated_at=now() WHERE tenant_id=$1", [tenant]);
    });}catch(error){metadataError=error;}
    this.revoke(tenant);
    const stopped = await Promise.allSettled([
      this.target.stop(tenant, `${row.id}:contain`, String(row.fence)),
      this.source.stop(tenant, `${row.id}:contain`, String(row.fence)),
    ]);
    const proven = stopped.every(r => r.status === 'fulfilled' && r.value === true);
    await this.directory.pool.query(`UPDATE migration_runs SET writer=$4,error_code=$5 WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3`, [tenant, row.lease_owner, row.fence, proven ? 'none' : 'unknown', proven ? 'migration_requires_reconciliation' : 'containment_requires_retry']);
    if(metadataError)throw new Error('Migration containment metadata requires reconciliation.');
  }

  async cutover(tenant: string) {
    const { row, guard, update, close, fenced } = await this.claim(tenant);
    let effects = false;
    try {
      if (row.phase === 'active') return;
      if (!['prepared', 'frozen', 'activating'].includes(row.phase) || !digest(row.package_hash ?? '') || !digest(row.source_checkpoint ?? '')) throw new Error('Migration phase requires reconciliation.');
      effects = true;
      await guard();
      const frozen = await this.source.inspect(tenant, row.id);
      this.validSource(tenant, frozen);
      if (frozen.checkpoint !== row.source_checkpoint || frozen.fence !== row.source_fence) throw new Error('The frozen source differs from the verified package.');
      await update('frozen', 'none', { source_fence: frozen.fence, error_code: null });
      if (!await this.target.verify(tenant, row.package_hash, frozen.checkpoint) || !await this.source.frozen(tenant, frozen.fence)) throw new Error('Source/package authorization changed.');
      await guard();
      const inspected = await this.target.inspect(tenant, row.id);
      if (inspected.state === 'uncertain' || (row.phase === 'activating' && inspected.state === 'absent')) throw new Error('Target activation outcome requires reconciliation.');
      await update('activating', 'none');
      const target = inspected.state === 'active' ? inspected.checkpoint : await this.target.activate(tenant, row.id, String(row.fence));
      this.validTarget(tenant, target);
      await guard();
      if (!await this.source.frozen(tenant, frozen.fence)) throw new Error('Source resumed unexpectedly.');
      await fenced(async c => {
        const owner = (await c.query("SELECT generation,state FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed') FOR UPDATE", [tenant])).rows[0];
        if (!owner || String(owner.generation) !== target.generation) throw new Error('Target runtime generation changed.');
        await c.query("UPDATE tenants SET machine_id=$2,volume_id=$3,state='active' WHERE id=$1", [tenant, target.machine, target.volume]);
        await c.query("UPDATE migration_runs SET phase='active',writer='tenant',target_checkpoint=$2,target_machine=$3,target_volume=$4,target_generation=$5,error_code=NULL,updated_at=now() WHERE tenant_id=$1", [tenant, target.checkpoint, target.machine, target.volume, target.generation]);
      });
      this.revoke(tenant);
    } catch (error) {
      if (effects) await this.contain(tenant, row);
      throw error;
    } finally { await close(); }
  }

  async rollback(tenant: string) {
    const { row, guard, update, close, fenced } = await this.claim(tenant);
    let effects = false;
    try {
      if (row.phase === 'rolled_back') return;
      if (!['active', 'rollback_pending', 'rollback_restoring', 'rollback_resuming'].includes(row.phase)) throw new Error('Migration cannot roll back from this phase.');
      effects = true;
      const operation = `${row.id}:rollback`;
      // A resumed source must never be overwritten with a stale checkpoint after
      // a crash between resume and the final metadata write.
      if (row.phase === 'rollback_resuming') {
        const source = await this.source.resumeState(tenant, operation);
        if (source.state !== 'active' || source.checkpoint !== row.target_checkpoint || !await this.target.stop(tenant, operation, String(row.fence))) throw new Error('Rollback resume outcome requires reconciliation.');
        await update('rolled_back', 'legacy', { error_code: null });
        return;
      }
      await update('rollback_pending', 'tenant');
      const target = await this.target.freeze(tenant, operation, String(row.fence));
      this.validTarget(tenant, target);
      if (!target.writersStopped || target.machine !== row.target_machine || target.volume !== row.target_volume || target.generation !== String(row.target_generation)) throw new Error('Target writer is not proven stopped.');
      await guard();
      await fenced(async c => {
        if (!(await c.query("UPDATE tenants SET state='suspended',generation=generation+1 WHERE id=$1 AND state NOT IN ('deleting','deleted','failed') RETURNING id", [tenant])).rowCount) throw new Error('Account revoked.');
        await c.query("UPDATE migration_runs SET phase='rollback_restoring',writer='none',target_checkpoint=$2 WHERE tenant_id=$1", [tenant, target.checkpoint]);
      });
      this.revoke(tenant);
      // An interrupted restore is safe only through an idempotent, fenced adapter.
      const installed = await this.source.restore(tenant, operation, target, String(row.fence));
      if (!installed.writersStopped || installed.checkpoint !== target.checkpoint) throw new Error('Rollback requires a reconciled checkpoint.');
      await update('rollback_resuming', 'none');
      await guard();
      await this.source.resume(tenant, operation, installed.checkpoint, String(row.fence));
      const resumed = await this.source.resumeState(tenant, operation);
      if (resumed.state !== 'active' || resumed.checkpoint !== installed.checkpoint) throw new Error('Rollback resume outcome requires reconciliation.');
      await update('rolled_back', 'legacy', { error_code: null });
    } catch (error) {
      if (effects) await this.contain(tenant, row);
      throw error;
    } finally { await close(); }
  }
}
