/** Trusted operator CLI only. No provider clients, tenant secrets or schema-owner credentials. */
import { fileURLToPath } from 'node:url';
import { Directory } from './directory.js';
import { setMeterAllowance } from './meter.js';
import { tenantHash } from './tenant-logs.js';

function monthBounds(month: string) {
  if (!/^(?:20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Use month YYYY-MM.');
  const start = `${month}-01`, next = new Date(start); next.setUTCMonth(next.getUTCMonth() + 1);
  return [start,next.toISOString().slice(0,10)];
}
export async function exportTenantMeter(directory: Directory, month: string, tenant?: string) {
  const [start,end] = monthBounds(month);
  return (await directory.pool.query(`SELECT tenant_id,to_char(day,'YYYY-MM-DD') AS day,metric,quantity,unit,cost_usd,source,updated_at
    FROM tenant_meter WHERE day>=$1 AND day<$2 AND ($3::text IS NULL OR tenant_id=$3) ORDER BY tenant_id,day,metric,source`, [start,end,tenant ?? null])).rows
    .map(r => ({ tenant_id: r.tenant_id, day: r.day, metric: r.metric, quantity: Number(r.quantity), unit: r.unit,
      cost_usd: r.cost_usd === null ? null : Number(r.cost_usd), source: r.source, updated_at: r.updated_at.toISOString() }));
}
export async function tenantMeterHealth(directory: Directory, tenant?: string) {
  const rows = (await directory.pool.query(`SELECT t.id,t.state,s.last_tunnel_at,s.reported_at,s.observed_at,s.last_poll_at,s.poll_failed,
    (SELECT r.state FROM tenant_meter_resources r WHERE r.tenant_id=t.id AND r.kind='machine' AND r.resource_id=t.machine_id AND r.generation=t.generation) AS machine_state,
    (SELECT to_timestamp(r.at::double precision/1000) FROM tenant_meter_resources r WHERE r.tenant_id=t.id AND r.kind='machine' AND r.resource_id=t.machine_id AND r.generation=t.generation) AS machine_observed_at,
    (SELECT count(*)::integer FROM lifecycle_jobs j WHERE j.tenant_id=t.id AND j.state='failed') AS lifecycle_job_failures,
    (SELECT COALESCE(sum(j.attempts),0)::integer FROM lifecycle_jobs j WHERE j.tenant_id=t.id AND j.state='failed') AS failed_job_attempts
    FROM tenants t LEFT JOIN tenant_meter_status s ON s.tenant_id=t.id WHERE ($1::text IS NULL OR t.id=$1) ORDER BY t.id`, [tenant ?? null])).rows;
  return rows.map(r => ({ tenant_id: r.id, tenant_hash: tenantHash(r.id), state: r.state,
    last_tunnel_connection: r.last_tunnel_at?.toISOString() ?? null, last_meter_report: r.reported_at?.toISOString() ?? null,
    machine_state: r.machine_state ?? 'unknown', machine_observed_at: r.machine_observed_at?.toISOString() ?? null,
    last_poll_at: r.last_poll_at?.toISOString() ?? null, poll_failed: r.poll_failed ?? false,
    lifecycle_job_failures: r.lifecycle_job_failures, failed_job_attempts: r.failed_job_attempts }));
}
function csv(rows: Record<string,unknown>[], columns: string[]) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return '"' + (/^[=+\-@\t\r\n]/.test(s) ? "'" + s : s).replaceAll('"','""') + '"';
  };
  return columns.join(',') + '\n' + rows.map(row => columns.map(k => cell(row[k])).join(',') + '\n').join('');
}
export async function meterCommand(args: string[], directory: Directory): Promise<string> {
  if (process.env.SWARM_ROLE === 'tenant' || process.env.SWARM_TENANT_ID) throw new Error('Operator command only.');
  const [command,...rest] = args, options: Record<string,string> = {};
  for (let n=0;n<rest.length;n+=2) {
    const key = rest[n];
    if (!/^--[a-z-]+$/.test(key) || !rest[n+1] || rest[n+1].startsWith('--') || Object.hasOwn(options,key.slice(2))) throw new Error('Invalid meter options.');
    options[key.slice(2)] = rest[n+1];
  }
  const allowed = command === 'export' ? ['month','tenant','format'] : command === 'health' ? ['tenant','format'] : command === 'allowance' ? ['tenant','usd'] : [];
  if (Object.keys(options).some(k => !allowed.includes(k)) || options.tenant && !/^usr_[A-Za-z0-9_-]{8,100}$/.test(options.tenant)) throw new Error('Invalid meter options.');
  if (options.format && !['json','csv'].includes(options.format)) throw new Error('Use csv or json.');
  if (command === 'allowance') {
    if (!options.tenant || !/^(none|\d+(\.\d{1,2})?)$/.test(options.usd ?? '')) throw new Error('Use allowance --tenant id --usd amount|none.');
    await setMeterAllowance(directory,options.tenant,options.usd === 'none' ? null : Number(options.usd));
    return JSON.stringify({ tenant_hash: tenantHash(options.tenant), allowanceUsd: options.usd === 'none' ? null : Number(options.usd), enforced: false }) + '\n';
  }
  const rows = command === 'export' ? await exportTenantMeter(directory,options.month ?? '',options.tenant)
    : command === 'health' ? await tenantMeterHealth(directory,options.tenant) : null;
  if (!rows) throw new Error('Use export, health or allowance.');
  if (options.format === 'csv') return csv(rows,command === 'export' ? ['tenant_id','day','metric','quantity','unit','cost_usd','source','updated_at']
    : ['tenant_id','tenant_hash','state','last_tunnel_connection','last_meter_report','machine_state','machine_observed_at','last_poll_at','poll_failed','lifecycle_job_failures','failed_job_attempts']);
  return JSON.stringify(rows,null,2) + '\n';
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let directory: Directory | undefined;
  try { directory = new Directory(); process.stdout.write(await meterCommand(process.argv.slice(2),directory)); }
  catch { console.error('Meter command refused. Check options, directory access and migration.'); process.exitCode = 1; }
  finally { await directory?.pool.end(); }
}
