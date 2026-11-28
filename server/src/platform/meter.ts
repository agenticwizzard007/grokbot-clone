import type { PoolClient } from 'pg';
import type { Directory } from './directory.js';
import type { RuntimeIdentity } from './runtime-identity.js';
import { meterDayMs, utcDay, type MeterReport, type MeterAllowance } from '../runtime/meter-contract.js';

export const meterRetentionDays = 400;
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === fields.length && Object.keys(value).every(k => fields.includes(k));
export function validateMeterReport(value: unknown): asserts value is MeterReport {
  if (!exact(value, ['version','tenant','at','days']) || value.version !== 1
    || typeof value.tenant !== 'string' || !/^usr_[A-Za-z0-9_-]{8,100}$/.test(value.tenant)
    || !Number.isSafeInteger(value.at) || Number(value.at) <= 0 || !Array.isArray(value.days)
    || !value.days.length || value.days.length > 32) throw new Error('Invalid meter report.');
  const seen = new Set<string>();
  for (const day of value.days) {
    if (!exact(day, ['day','modelSpendUsd','computerMinutes','voiceMinutes']) || typeof day.day !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(day.day) || !Number.isFinite(Date.parse(day.day)) || utcDay(Date.parse(day.day)) !== day.day
      || seen.has(day.day) || ![day.modelSpendUsd,day.computerMinutes,day.voiceMinutes].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e9)) {
      throw new Error('Invalid daily meter values.');
    }
    seen.add(day.day);
  }
}

export class TenantMeter {
  constructor(readonly directory: Directory, private runtime: RuntimeIdentity) {}
  async accept(token: string, value: unknown) {
    validateMeterReport(value);
    const report = structuredClone(value);
    return this.runtime.authorized(token, async (owner, client) => {
      if (report.tenant !== owner.tenant) throw new Error('Meter tenant mismatch.');
      const now = Number((await client.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
      if (report.at > now || report.at < now - 60_000 || report.days.some(d => d.day > utcDay(now) || d.day < utcDay(now - 62 * meterDayMs))) {
        throw new Error('Stale meter report.');
      }
      const last = (await client.query('SELECT report_at,reported_at FROM tenant_meter_status WHERE tenant_id=$1', [owner.tenant])).rows[0];
      if (last?.report_at && (report.at <= Number(last.report_at) || now - new Date(last.reported_at).getTime() < 15_000)) throw new Error('Replayed or excessive meter report.');
      for (const day of report.days) {
        for (const [metric, quantity, unit, cost] of [
          ['model_spend_usd',day.modelSpendUsd,'USD',day.modelSpendUsd],
          ['computer_minutes',day.computerMinutes,'minutes',null],
          ['voice_minutes',day.voiceMinutes,'minutes',null],
        ]) {
          // A new cumulative snapshot replaces a claim. It never adds it again.
          await client.query(`INSERT INTO tenant_meter(tenant_id,day,metric,quantity,unit,cost_usd,source)
            VALUES($1,$2,$3,$4,$5,$6,'tenant') ON CONFLICT(tenant_id,day,metric,source)
            DO UPDATE SET quantity=excluded.quantity,cost_usd=excluded.cost_usd,updated_at=clock_timestamp()`,
          [owner.tenant,day.day,metric,quantity,unit,cost]);
        }
      }
      await client.query(`INSERT INTO tenant_meter_status(tenant_id,report_at,reported_at) VALUES($1,$2,clock_timestamp())
        ON CONFLICT(tenant_id) DO UPDATE SET report_at=excluded.report_at,reported_at=excluded.reported_at`, [owner.tenant,report.at]);
    });
  }
  async allowance(token: string): Promise<MeterAllowance> {
    return this.runtime.authorized(token, (owner, client) => readMeterAllowance(client, owner.tenant));
  }
}

/** Recurring monthly allowance. Claims for model/AI spend only; never enforced. */
export async function readMeterAllowance(client: PoolClient, tenant: string): Promise<MeterAllowance> {
  const row = (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month,
    (SELECT monthly_usd FROM tenant_allowances WHERE tenant_id=$1) AS allowance,
    (SELECT reported_at FROM tenant_meter_status WHERE tenant_id=$1) AS reported_at,
    (SELECT COALESCE(sum(cost_usd),0) FROM tenant_meter WHERE tenant_id=$1 AND source='tenant' AND metric='model_spend_usd'
      AND day>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date
      AND day<(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 month')::date) AS spend`, [tenant])).rows[0];
  const allowanceUsd = row.allowance === null ? null : Number(row.allowance), spendUsd = Number(row.spend);
  return { month: row.month, allowanceUsd, spendUsd, percentUsed: allowanceUsd === null ? null : spendUsd / allowanceUsd * 100,
    softLimitExceeded: allowanceUsd !== null && spendUsd >= allowanceUsd, source: 'tenant', reportedAt: row.reported_at?.toISOString() ?? null };
}

export async function setMeterAllowance(directory: Directory, tenant: string, usd: number | null) {
  if (usd !== null && (!Number.isFinite(usd) || usd <= 0 || usd > 1e9 || Math.round(usd * 100) / 100 !== usd)) throw new Error('Allowance requires positive USD cents.');
  await directory.transaction(async client => {
    const row = await client.query("SELECT id FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE", [tenant]);
    if (!row.rowCount) throw new Error('Tenant unavailable.');
    if (usd === null) await client.query('DELETE FROM tenant_allowances WHERE tenant_id=$1', [tenant]);
    else await client.query(`INSERT INTO tenant_allowances(tenant_id,monthly_usd) VALUES($1,$2)
      ON CONFLICT(tenant_id) DO UPDATE SET monthly_usd=excluded.monthly_usd,updated_at=clock_timestamp()`, [tenant,usd]);
  });
}

/** Retain replay high-water marks for the account lifetime, not just the ledger window. */
export async function pruneTenantMeter(directory: Directory) {
  await directory.pool.query(`DELETE FROM tenant_meter WHERE day<(clock_timestamp() AT TIME ZONE 'UTC')::date-$1::integer`, [meterRetentionDays]);
  await directory.pool.query(`DELETE FROM tenant_meter_resources WHERE quantity=0 AND at<extract(epoch FROM clock_timestamp()-interval '1 day')*1000`);
}

/** A connection timestamp is history, never proof that a tunnel is still alive. */
export async function noteMeterTunnel(directory: Directory, runtime: RuntimeIdentity, token: string) {
  await runtime.authorized(token, async (owner, client) => {
    await client.query(`INSERT INTO tenant_meter_status(tenant_id,last_tunnel_at) VALUES($1,clock_timestamp())
      ON CONFLICT(tenant_id) DO UPDATE SET last_tunnel_at=excluded.last_tunnel_at`, [owner.tenant]);
  });
}
