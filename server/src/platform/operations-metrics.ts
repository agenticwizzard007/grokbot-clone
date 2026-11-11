import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Directory } from './directory.js';

type Service = 'platform' | 'provisioner';
export interface OperationsState {
  ready: boolean;
  tickFailures?: number;
  retentionFailures?: number;
  retentionLastSuccess?: number;
  oldestTickSeconds?: number;
}
export interface MetricsConfig { tokenFile: string; port: number }

/** Observe concurrent work without queuing, cancelling or changing its lease. */
export class OperationsActivity {
  private starts = new Map<symbol, number>();
  constructor(private now: () => number = () => performance.now()) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    const id = Symbol(); this.starts.set(id, this.now());
    try { return await work(); } finally { this.starts.delete(id); }
  }
  oldestSeconds() {
    const now = this.now();
    return Math.max(0, ...Array.from(this.starts.values(), start => (now - start) / 1000));
  }
}

/** Explicit opt-in; never bind to a public or tenant-accessible interface. */
export function operationsMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig | undefined {
  const tokenFile = env.OPERATIONS_METRICS_TOKEN_FILE;
  if (!tokenFile) {
    if (env.OPERATIONS_METRICS_PORT) throw new Error('Metrics port requires a private token file.');
    return undefined;
  }
  const port = Number(env.OPERATIONS_METRICS_PORT ?? 9464);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid metrics port.');
  return { tokenFile, port };
}

/** Load once at startup; rotation requires restarting the collector service. */
function loadTokenDigest(file: string) {
  let fd: number | undefined;
  try {
    if (!file.startsWith('/')) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 257 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.uid !== process.geteuid?.()) throw new Error();
    const bytes = fs.readFileSync(fd);
    try {
      if (!/^[A-Za-z0-9_-]{32,256}\n?$/.test(bytes.toString('utf8'))) throw new Error();
      return createHash('sha256').update(bytes.subarray(0, bytes.at(-1) === 10 ? -1 : undefined)).digest();
    } finally { bytes.fill(0); }
  } catch { throw new Error('Metrics require an owned private regular token file.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Fixed fields and aggregate counts only: never emit tenant, job, session,
// provider, path, payload, error text or arbitrary database values as labels.
const gauges: Record<string, string> = {
  active_tenants: 'Number of active tenants.',
  unready_hosts: 'Active tenants without current acknowledged running host readiness.',
  stale_backup_reporters: 'Active tenants without a current-generation backup report within three minutes.',
  overdue_database_backups: 'Active tenants without both a recent host snapshot timestamp and complete current-volume database or environment backup within five minutes.',
  overdue_environment_backups: 'Active tenants without both a recent host snapshot timestamp and complete current-volume environment backup within twenty-four hours.',
  backup_retries: 'Current-generation active tenant backup reporters requiring retry.',
  backup_upload_failures: 'Unfinished backup uploads with a recorded failure.',
  backup_cleanup_failures: 'Backups awaiting deletion with a recorded cleanup failure.',
  overdue_volume_cleanup: 'Retired volumes still present five minutes after their retention deadline.',
  lifecycle_failures: 'Unfinished lifecycle jobs with a recorded error.',
  overdue_lifecycle_queue: 'Actionable queued or failed lifecycle jobs at least five minutes past retry time.',
  expired_lifecycle_leases: 'Running lifecycle jobs without an unexpired lease.',
  overdue_environment_operations: 'Unfinished restore or update operations older than thirty minutes.',
  environment_failures: 'Unfinished restore or update operations with a recorded error.',
  migration_reconciliation: 'Migrations in reconciliation or with an unknown writer.',
  overdue_migrations: 'Unfinished migrations without a phase update for thirty minutes.',
  uncertain_infrastructure_actions: 'Unobserved infrastructure actions older than ten minutes.',
  overdue_host_checkpoints: 'Unfinished held-host checkpoints older than thirty minutes.',
  uncertain_provider_dispatches: 'Provider dispatches with an uncertain outcome requiring reconciliation.',
};

/** One read-only snapshot, bounded execution, no mutation or provider calls. */
export async function collectOperationsMetrics(directory: Directory): Promise<Record<string, number>> {
  const client = await directory.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await client.query(
      "WITH RECURSIVE active AS (SELECT id,generation,machine_id,volume_id FROM tenants WHERE state='active')," +
      // Only a completed image update that preserved this exact volume can
      // carry backup evidence across generations. Restores never grant lineage.
      " lineage(tenant_id,generation,volume_id) AS (SELECT id,generation,volume_id FROM active UNION" +
      " SELECT l.tenant_id,o.source_generation,o.source_volume FROM lineage l JOIN environment_operations o" +
      " ON o.tenant_id=l.tenant_id AND o.target_generation=l.generation AND o.kind='update' AND o.phase='completed'" +
      " AND o.target_volume=l.volume_id AND o.source_volume=l.volume_id AND o.source_generation<o.target_generation), backup_health AS (" +
      "SELECT t.id,s.reported_at,s.last_database_at,s.last_environment_at,s.error_code," +
      " EXISTS(SELECT 1 FROM backups b WHERE b.tenant_id=t.id AND b.generation IN (SELECT generation FROM lineage WHERE tenant_id=t.id) AND b.state='complete'" +
      " AND b.created_at>now()-interval '5 minutes') AS database_confirmed," +
      " EXISTS(SELECT 1 FROM backups b WHERE b.tenant_id=t.id AND b.generation IN (SELECT generation FROM lineage WHERE tenant_id=t.id) AND b.state='complete'" +
      " AND b.scope='environment' AND b.created_at>now()-interval '24 hours') AS environment_confirmed" +
      " FROM active t LEFT JOIN backup_status s ON s.tenant_id=t.id AND s.generation=t.generation)" +
      " SELECT (SELECT count(*) FROM active) AS active_tenants," +
      " (SELECT count(*) FROM active t WHERE NOT EXISTS(SELECT 1 FROM host_policies p WHERE p.tenant_id=t.id" +
      " AND p.generation=t.generation AND p.machine_id=t.machine_id AND p.desired='run' AND p.observed='running'" +
      " AND p.acknowledged_revision=p.revision AND p.error_code IS NULL AND p.reported_at>now()-interval '4 minutes')) AS unready_hosts," +
      " (SELECT count(*) FROM backup_health WHERE reported_at IS NULL OR reported_at<=now()-interval '3 minutes') AS stale_backup_reporters," +
      " (SELECT count(*) FROM backup_health WHERE last_database_at IS NULL OR last_database_at<=now()-interval '5 minutes' OR NOT database_confirmed) AS overdue_database_backups," +
      " (SELECT count(*) FROM backup_health WHERE last_environment_at IS NULL OR last_environment_at<=now()-interval '24 hours' OR NOT environment_confirmed) AS overdue_environment_backups," +
      " (SELECT count(*) FROM backup_health WHERE error_code IS NOT NULL) AS backup_retries," +
      " (SELECT count(*) FROM backups WHERE state='uploading' AND error_code IS NOT NULL) AS backup_upload_failures," +
      " (SELECT count(*) FROM backups WHERE state='deleting' AND error_code IS NOT NULL) AS backup_cleanup_failures," +
      " (SELECT count(*) FROM retired_volumes WHERE state!='deleted' AND delete_after<now()-interval '5 minutes') AS overdue_volume_cleanup," +
      " (SELECT count(*) FROM lifecycle_jobs WHERE state IN ('queued','running','failed') AND error_code IS NOT NULL) AS lifecycle_failures," +
      " (SELECT count(*) FROM lifecycle_jobs j JOIN tenants t ON t.id=j.tenant_id" +
      " WHERE j.state IN ('queued','failed') AND j.retry_at<now()-interval '5 minutes'" +
      " AND (j.operation='delete' AND t.state='deleting' OR j.operation!='delete' AND t.state NOT IN ('deleting','deleted','failed'))" +
      " AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM migration_runs m WHERE m.tenant_id=j.tenant_id AND m.phase!='active'))" +
      " AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM environment_operations o WHERE o.tenant_id=j.tenant_id AND o.phase NOT IN ('completed','cancelled')))) AS overdue_lifecycle_queue," +
      " (SELECT count(*) FROM lifecycle_jobs WHERE state='running' AND (lease_until IS NULL OR lease_until<=now())) AS expired_lifecycle_leases," +
      " (SELECT count(*) FROM environment_operations WHERE phase NOT IN ('completed','cancelled') AND created_at<now()-interval '30 minutes') AS overdue_environment_operations," +
      " (SELECT count(*) FROM environment_operations WHERE phase NOT IN ('completed','cancelled') AND error_code IS NOT NULL) AS environment_failures," +
      " (SELECT count(*) FROM migration_runs WHERE phase='reconciliation' OR writer='unknown') AS migration_reconciliation," +
      " (SELECT count(*) FROM migration_runs m JOIN tenants t ON t.id=m.tenant_id WHERE t.state!='deleted'" +
      " AND m.phase NOT IN ('active','rolled_back','cancelled') AND m.updated_at<now()-interval '30 minutes') AS overdue_migrations," +
      " (SELECT count(*) FROM infrastructure_actions a JOIN tenants t ON t.id=a.tenant_id WHERE a.state='dispatching'" +
      " AND t.state!='deleted' AND a.created_at<now()-interval '10 minutes') AS uncertain_infrastructure_actions," +
      " (SELECT count(*) FROM host_checkpoints q JOIN tenants t ON t.id=q.tenant_id WHERE t.state!='deleted'" +
      " AND q.state IN ('pending','uploading') AND q.created_at<now()-interval '30 minutes') AS overdue_host_checkpoints," +
      " (SELECT count(*) FROM dispatches WHERE state='uncertain') AS uncertain_provider_dispatches");
    const result: Record<string, number> = {};
    for (const field of Object.keys(gauges)) {
      const value = Number(rows[0]?.[field]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid operations aggregate.');
      result[field] = value;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

function metric(name: string, help: string, value: number, kind = 'gauge') {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid operations metric.');
  return '# HELP ' + name + ' ' + help + '\n# TYPE ' + name + ' ' + kind + '\n' + name + ' ' + value + '\n';
}
export function renderOperationsMetrics(values: Record<string, number>, service: Service, state: OperationsState) {
  let result = metric('swarm_operations_collection_success', 'Whether this database snapshot was collected successfully.', 1);
  result += metric('swarm_service_ready', 'Whether this process is ready to serve its role.', Number(state.ready));
  for (const [field, help] of Object.entries(gauges)) result += metric('swarm_operations_' + field, help, values[field]);
  if (service === 'provisioner') {
    result += metric('swarm_provisioner_tick_failures_total', 'Unexpected worker tick failures since this process started.', state.tickFailures ?? 0, 'counter');
    result += metric('swarm_provisioner_retention_failures_total', 'Failed retention tasks since this process started.', state.retentionFailures ?? 0, 'counter');
    result += metric('swarm_provisioner_retention_last_success_seconds', 'Unix timestamp of the last sweep whose top-level retention tasks resolved; zero until one succeeds.', state.retentionLastSuccess ?? 0);
    result += metric('swarm_provisioner_oldest_tick_seconds', 'Elapsed duration of the oldest in-flight worker tick, independent of lease renewal.', state.oldestTickSeconds ?? 0);
  }
  return result;
}

export interface OperationsMetricsOptions {
  config?: MetricsConfig;
  state: () => OperationsState;
  /** Test seam; production always uses the directory snapshot collector. */
  collect?: () => Promise<Record<string, number>>;
}

/** Dedicated loopback listener. A local collector must forward over its own
 * authenticated/TLS channel; this server never listens on a public interface. */
export async function startOperationsMetrics(directory: Directory, service: Service, options: OperationsMetricsOptions) {
  const config = options.config ?? operationsMetricsConfig();
  if (!config) return undefined;
  const digest = loadTokenDigest(config.tokenFile);
  const collect = options.collect ?? (() => collectOperationsMetrics(directory));
  let collecting: Promise<Record<string, number>> | undefined;
  let closing = false;
  const server: Server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const end = (code: number, body: string) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(body); };
    if (request.url !== '/metrics') return end(404, 'Not found.\n');
    if (request.method !== 'GET') return end(405, 'Method not allowed.\n');
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? '');
    if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), digest)) return end(401, 'Metrics authentication required.\n');
    if (request.headers.origin) return end(403, 'Browser requests are not supported.\n');
    if (closing) return end(503, 'Metrics unavailable.\n');
    try {
      collecting ??= collect().finally(() => { collecting = undefined; });
      const values = await collecting;
      if (closing) return end(503, 'Metrics unavailable.\n');
      const body = renderOperationsMetrics(values, service, options.state());
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(body);
    } catch {
      // A failed scrape is never a healthy cached snapshot. Do not serialize
      // database errors, connection strings, tokens or provider responses.
      end(503, 'swarm_operations_collection_success 0\n');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  }).catch(error => { digest.fill(0); server.close(); throw error; });
  return {
    server,
    close: async () => {
      closing = true;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await collecting?.catch(() => {});
      digest.fill(0);
    },
  };
}
