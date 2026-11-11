// Real local collectors, disposable PostgreSQL metadata, no Alertmanager or
// remote-write destination. CI supplies the checksum-pinned Prometheus binary.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { Directory } from '../server/src/platform/directory.js';
import { startOperationsMetrics } from '../server/src/platform/operations-metrics.js';

if (!process.env.PROMETHEUS_BIN?.startsWith('/') || !process.env.TEST_DATABASE_URL) {
  throw new Error('An absolute PROMETHEUS_BIN and disposable TEST_DATABASE_URL are required.');
}
fs.accessSync(process.env.PROMETHEUS_BIN, fs.constants.X_OK);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-collector-'));
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const schema = 'test_' + randomBytes(8).toString('hex');
await admin.query('CREATE SCHEMA ' + schema);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const directory = new Directory(url.href);
const exporters: Awaited<ReturnType<typeof startOperationsMetrics>>[] = [];
const children: ChildProcess[] = [], logFiles: number[] = [];
const ready = [true, true];
let spawnFailed = false;
const template = fs.readFileSync('infra/monitoring/prometheus.example.yml', 'utf8');
async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnFailed || children.some(child => child.exitCode !== null)) throw new Error('A local collector exited before validation.');
    try { if (await check()) return; } catch { /* local collector may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Local collector did not produce the expected sample.');
}
async function sample(port: number, metric: string, instance: string, value: string) {
  const response = await fetch('http://127.0.0.1:' + port + '/api/v1/query?query=' + encodeURIComponent(metric + '{job="swarm-operations"}'), { signal: AbortSignal.timeout(1000) });
  const result = (await response.json() as any).data?.result;
  return result?.length === 1 && result[0].metric.instance === instance && result[0].metric.deployment === 'fixture' && result[0].value[1] === value;
}
try {
  await directory.migrate();
  for (let replica = 0; replica < 2; replica++) {
    const instance = 'fixture-platform-' + (replica + 1);
    const tokenFile = path.join(root, 'token-' + replica);
    fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    exporters.push(await startOperationsMetrics(directory, 'platform', {
      config: { tokenFile, port: 9464 + replica }, state: () => ({ ready: ready[replica] }),
    }));
    // Render the checked-in example with distinct service/collector identities.
    // Deliberately remove all external notification configuration for this test.
    const config = template.split('# Supply the approved Alertmanager destination')[0]
      .replace('scrape_interval: 30s', 'scrape_interval: 1s')
      .replace('evaluation_interval: 30s', 'evaluation_interval: 1s')
      .replace('scrape_timeout: 15s', 'scrape_timeout: 1s')
      .replace('rule_files:\n  - /etc/prometheus/swarm-alerts.yml', 'rule_files: []')
      .replaceAll('deployment: staging', 'deployment: fixture')
      .replaceAll('staging-platform-01', instance)
      .replace('127.0.0.1:9464', '127.0.0.1:' + (9464 + replica))
      .replace('/run/secrets/swarm-metrics-token', JSON.stringify(tokenFile));
    assert.equal(config.includes('alerting:'), false);
    assert.equal(config.includes('remote_write:'), false);
    const configFile = path.join(root, 'collector-' + replica + '.yml');
    fs.writeFileSync(configFile, config, { mode: 0o600 });
    const log = fs.openSync(path.join(root, 'collector-' + replica + '.log'), 'w', 0o600); logFiles.push(log);
    const child = spawn(process.env.PROMETHEUS_BIN, [
      '--config.file=' + configFile, '--web.listen-address=127.0.0.1:' + (9090 + replica),
      '--storage.tsdb.path=' + path.join(root, 'data-' + replica), '--storage.tsdb.retention.time=1h', '--log.level=warn',
    ], { stdio: ['ignore', log, log] });
    child.on('error', () => { spawnFailed = true; }); children.push(child);
  }
  for (let replica = 0; replica < 2; replica++) {
    await until(() => sample(9090 + replica, 'up', 'fixture-platform-' + (replica + 1), '1'));
    await until(() => sample(9090 + replica, 'swarm_service_ready', 'fixture-platform-' + (replica + 1), '1'));
  }
  ready[0] = false;
  await until(() => sample(9090, 'swarm_service_ready', 'fixture-platform-1', '0'));
  assert.equal(await sample(9091, 'swarm_service_ready', 'fixture-platform-2', '1'), true);
  console.log('PASS: two local Prometheus collectors coexist with authenticated exporters, preserve distinct configured instance identities, and observe one unready replica without hiding it behind a healthy replica. No external alert destination was configured.');
} finally {
  await Promise.all(children.map(async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    try { await exited; } finally { clearTimeout(force); }
  }));
  for (const fd of logFiles) fs.closeSync(fd);
  for (const exporter of exporters) await exporter?.close();
  await directory.pool.end();
  await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  fs.rmSync(root, { recursive: true, force: true });
}
