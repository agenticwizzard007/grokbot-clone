import type { PoolClient } from 'pg';
import type { Directory } from './directory.js';
import type { FlyTenants } from './fly-tenants.js';
import { meterDayMs, utcDay } from '../runtime/meter-contract.js';
import { bindTenantLog, tenantWorkerLog } from './tenant-logs.js';

export interface MeterResource { kind: 'machine' | 'volume'; id: string; state: string; quantity: number }
export const meterObservationGapMs = 300_000;
export const machineMeterState = (state: string) => ['created','starting','started','running','stopping','stopped','suspending','suspended','destroyed'].includes(state) ? state : 'unknown';
export const machineMeterResource = (machine: { id: string; state: string }): MeterResource => ({ kind: 'machine', id: machine.id,
  state: machineMeterState(machine.state), quantity: ['started','running','stopping','suspending'].includes(machine.state) ? 1 : 0 });
export function volumeMeterResource(volume: { id: string; size_gb: number; state?: string }): MeterResource {
  if (!Number.isSafeInteger(volume.size_gb) || volume.size_gb < 1 || volume.size_gb > 10000) throw new Error('Unknown volume size.');
  return { kind: 'volume', id: volume.id, state: volume.state === 'destroyed' ? 'destroyed' : 'present', quantity: volume.state === 'destroyed' ? 0 : volume.size_gb };
}

/** Caller supplies a provider observation, never tenant input. Same tenant lock as lifecycle/revocation.
 * Each cursor and its daily increments commit together, so retries cannot double count an interval.
 * Long gaps and generation changes are unknown time, never extrapolated billable evidence. */
export async function observeMeterResource(client: PoolClient, tenant: string, generation: string, input: MeterResource, at = Date.now()) {
  if (!input.id || input.id.length > 256 || !Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(input.quantity)
    || input.quantity < 0 || input.quantity > (input.kind === 'machine' ? 1 : 10000)) throw new Error('Invalid infrastructure observation.');
  const owner = (await client.query("SELECT generation FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [tenant])).rows[0];
  if (!owner || String(owner.generation) !== generation) return;
  const previous = (await client.query('SELECT * FROM tenant_meter_resources WHERE tenant_id=$1 AND kind=$2 AND resource_id=$3', [tenant,input.kind,input.id])).rows[0];
  if (previous && at <= Number(previous.at)) return;
  if (previous && String(previous.generation) === generation && at - Number(previous.at) <= meterObservationGapMs) {
    for (let start = Number(previous.at); start < at;) {
      const day = utcDay(start), end = Math.min(at, Date.parse(day) + meterDayMs);
      const quantity = Number(previous.quantity) * (end - start) / (input.kind === 'machine' ? 1000 : meterDayMs);
      await client.query(`INSERT INTO tenant_meter(tenant_id,day,metric,quantity,unit,source)
        VALUES($1,$2,$3,$4,$5,'provisioner') ON CONFLICT(tenant_id,day,metric,source)
        DO UPDATE SET quantity=tenant_meter.quantity+excluded.quantity,updated_at=clock_timestamp()`,
      [tenant,day,input.kind === 'machine' ? 'machine_running_seconds' : 'storage_gb_days',quantity,input.kind === 'machine' ? 'seconds' : 'GB-days']);
      start = end;
    }
  }
  await client.query(`INSERT INTO tenant_meter_resources(tenant_id,kind,resource_id,generation,at,quantity,state) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(tenant_id,kind,resource_id) DO UPDATE SET generation=excluded.generation,at=excluded.at,quantity=excluded.quantity,state=excluded.state`,
  [tenant,input.kind,input.id,generation,at,input.quantity,input.state]);
}

/** Bounded read-only provider inspection. No action, create, wake or repair is issued here. */
export class InfrastructureMeter {
  constructor(private directory: Directory, private driver: Pick<FlyTenants,'inventory'>) {}
  async tick() {
    // Durable reservation spreads retries across tenants and prevents overlapping polls.
    const tenant = await this.directory.transaction(async client => {
      const row = (await client.query(`SELECT t.id,t.generation,t.fly_app FROM tenants t LEFT JOIN tenant_meter_status s ON s.tenant_id=t.id
        WHERE t.fly_app IS NOT NULL AND t.state IN ('active','suspended','provisioning')
        AND (s.last_poll_at IS NULL OR s.last_poll_at<clock_timestamp()-interval '60 seconds')
        ORDER BY s.last_poll_at NULLS FIRST,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`)).rows[0];
      if (!row) return null;
      const reserved = (await client.query(`INSERT INTO tenant_meter_status(tenant_id,last_poll_at) VALUES($1,clock_timestamp())
        ON CONFLICT(tenant_id) DO UPDATE SET last_poll_at=excluded.last_poll_at
        RETURNING extract(epoch FROM last_poll_at)*1000 AS at`, [row.id])).rows[0];
      return { ...row, at: Math.floor(Number(reserved.at)) };
    });
    if (!tenant) return 'idle';
    return tenantWorkerLog('meter', async () => {
      bindTenantLog(tenant.id);
      try {
        const operations = (await this.directory.pool.query('SELECT id FROM environment_operations WHERE tenant_id=$1', [tenant.id])).rows.map(r => r.id);
        const inventory = await this.driver.inventory(tenant.fly_app,tenant.id,operations);
        const inputs = [...inventory.machines.map(machineMeterResource),...inventory.volumes.map(volumeMeterResource)];
        await this.directory.transaction(async client => {
          const owner = (await client.query("SELECT generation FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [tenant.id])).rows[0];
          if (!owner || String(owner.generation) !== String(tenant.generation)) return;
          const previous = (await client.query('SELECT kind,resource_id FROM tenant_meter_resources WHERE tenant_id=$1', [tenant.id])).rows;
          for (const resource of previous) if (!inputs.some(v => v.kind === resource.kind && v.id === resource.resource_id)) {
            inputs.push({ kind: resource.kind, id: resource.resource_id, state: 'destroyed', quantity: 0 });
          }
          for (const input of inputs) await observeMeterResource(client,tenant.id,String(tenant.generation),input,tenant.at);
          await client.query(`UPDATE tenant_meter_status SET observed_at=to_timestamp($2::double precision/1000),poll_failed=false
            WHERE tenant_id=$1 AND (observed_at IS NULL OR observed_at<=to_timestamp($2::double precision/1000))`, [tenant.id,tenant.at]);
        });
        return 'completed';
      } catch {
        await this.directory.pool.query(`UPDATE tenant_meter_status SET poll_failed=true WHERE tenant_id=$1
          AND last_poll_at<to_timestamp(($2::double precision+1)/1000)`, [tenant.id,tenant.at]);
        return 'retry';
      }
    });
  }
}
