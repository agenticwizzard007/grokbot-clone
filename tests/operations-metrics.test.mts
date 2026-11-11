import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import Database from 'better-sqlite3';
import { Directory } from '../server/src/platform/directory.js';
import { collectOperationsMetrics, operationsMetricsConfig, startOperationsMetrics, OperationsActivity } from '../server/src/platform/operations-metrics.js';
import { SessionNotifications } from '../server/src/platform/session-notifications.js';
import { LifecycleWorker } from '../server/src/platform/lifecycle-worker.js';
import { BackupCatalog } from '../server/src/platform/backups.js';
import { HostBackups } from '../server/src/runtime/backups.js';

test('operations metrics require explicit private configuration', () => {
  assert.equal(operationsMetricsConfig({}), undefined);
  assert.throws(() => operationsMetricsConfig({ OPERATIONS_METRICS_PORT: '9090' }));
  for (const port of ['0', '80', '65536', '9090junk', '-1', '1.5']) {
    assert.throws(() => operationsMetricsConfig({ OPERATIONS_METRICS_TOKEN_FILE: '/private/token', OPERATIONS_METRICS_PORT: port }));
  }
  assert.deepEqual(operationsMetricsConfig({ OPERATIONS_METRICS_TOKEN_FILE: '/private/token' }), { tokenFile: '/private/token', port: 9464 });
});

test('a hung worker remains observable while other work proceeds without queuing', async () => {
  let clock = 0, release!: () => void;
  const activity = new OperationsActivity(() => clock);
  const hanging = activity.run(() => new Promise<void>(resolve => { release = resolve; }));
  clock = 1_900_000;
  assert.equal(activity.oldestSeconds(), 1900);
  assert.equal(await activity.run(async () => 'other work'), 'other work');
  assert.equal(activity.oldestSeconds(), 1900, 'successful work cannot conceal another hung tick');
  release(); await hanging;
  assert.equal(activity.oldestSeconds(), 0);
  clock += 5_000;
  await activity.run(async () => { clock += 2_000; assert.equal(activity.oldestSeconds(), 2); });
  assert.equal(activity.oldestSeconds(), 0, 'a fresh wake tick never inherits an old job creation time');
  await assert.rejects(activity.run(async () => { throw new Error('failed'); }));
  assert.equal(activity.oldestSeconds(), 0);
});

test('metrics token files cannot be shared, linked or permissive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-metrics-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token');
  const start = (file = tokenFile) => startOperationsMetrics({} as Directory, 'platform', {
    config: { tokenFile: file, port: 0 }, state: () => ({ ready: true }),
  });
  await assert.rejects(start('relative-file'), /private regular token file/);
  fs.writeFileSync(tokenFile, 'short', { mode: 0o600 });
  await assert.rejects(start(), /private regular token file/);
  fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url'));
  fs.chmodSync(tokenFile, 0o640);
  await assert.rejects(start(), /private regular token file/);
  fs.chmodSync(tokenFile, 0o600);
  const link = path.join(root, 'link');
  fs.symlinkSync(tokenFile, link);
  await assert.rejects(start(link), /private regular token file/);
  fs.unlinkSync(link); fs.linkSync(tokenFile, link);
  await assert.rejects(start(), /private regular token file/);
  fs.unlinkSync(link);
  const listener = await start();
  assert.equal((listener!.server.address() as AddressInfo).address, '127.0.0.1');
  await listener!.close();
});

const url = process.env.TEST_DATABASE_URL;
test('operations metrics use current directory evidence and authenticated bounded scrapes', { skip: !url }, async t => {
  const schema = 'test_' + randomBytes(8).toString('hex'), admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const target = new URL(url!); target.searchParams.set('options', '-c search_path=' + schema + ',public');
  const directory = new Directory(target.href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-metrics-'));
  t.after(async () => {
    await directory.pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await directory.migrate();
  const tenant = await directory.identity('google', 'metrics-owner', { name: 'DO_NOT_EXPORT_PRIVATE_NAME', email: 'private@example.invalid' });
  const other = await directory.identity('google', 'metrics-suspended', { name: 'Other' });
  await directory.pool.query("UPDATE tenants SET state=CASE WHEN id=$1 THEN 'active' ELSE 'suspended' END,machine_id=id,volume_id='volume_'||id", [tenant]);
  const backup = randomBytes(16).toString('hex');
  await t.test('missing reporters and hosts are unhealthy only for active tenants', async () => {
    const metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.active_tenants, 1);
    for (const field of ['unready_hosts', 'stale_backup_reporters', 'overdue_database_backups', 'overdue_environment_backups']) assert.equal(metrics[field], 1);
  });
  await t.test('fresh reports require confirmed complete backup inventories', async () => {
    await directory.pool.query("INSERT INTO host_policies(tenant_id,generation,machine_id,desired,observed,revision,acknowledged_revision,reported_at) VALUES($1,1,$1,'run','running',1,1,now())", [tenant]);
    await directory.pool.query("INSERT INTO backup_status(tenant_id,generation,last_database_at,last_environment_at) VALUES($1,1,now(),now())", [tenant]);
    let metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.unready_hosts, 0);
    assert.equal(metrics.stale_backup_reporters, 0);
    assert.equal(metrics.overdue_database_backups, 1, 'self-reported timestamps cannot hide a missing completed backup');
    await directory.pool.query("INSERT INTO backups(tenant_id,id,generation,scope,state,expected_parts,expected_bytes,completed_at,expires_at) VALUES($1,$2,1,'environment','complete',2,32,now(),now()+interval '7 days')", [tenant, backup]);
    metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.overdue_database_backups, 0);
    assert.equal(metrics.overdue_environment_backups, 0);
  });
  await t.test('old generation and machine evidence cannot make a replacement healthy', async () => {
    await directory.pool.query('UPDATE tenants SET generation=2 WHERE id=$1', [tenant]);
    let metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.unready_hosts, 1);
    assert.equal(metrics.stale_backup_reporters, 1);
    assert.equal(metrics.overdue_database_backups, 1);
    await directory.pool.query('UPDATE backup_status SET generation=2 WHERE tenant_id=$1', [tenant]);
    await directory.pool.query("UPDATE host_policies SET generation=2,machine_id='foreign-machine' WHERE tenant_id=$1", [tenant]);
    metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.stale_backup_reporters, 0);
    assert.equal(metrics.overdue_database_backups, 1, 'an earlier generation backup is not current evidence');
    assert.equal(metrics.unready_hosts, 1);
    await directory.pool.query('UPDATE host_policies SET machine_id=$1 WHERE tenant_id=$1', [tenant]);
    await directory.pool.query("INSERT INTO environment_operations(id,tenant_id,kind,phase,source_generation,target_generation,source_machine,source_volume,target_volume,source_image,image_digest,region) VALUES('healthy-update',$1,'update','completed',1,2,$1,'volume_'||$1,'volume_'||$1,'image','image','region')", [tenant]);
    assert.equal((await collectOperationsMetrics(directory)).overdue_environment_backups, 0, 'a completed exact same-volume image update preserves valid backup lineage');
    await directory.pool.query("UPDATE environment_operations SET phase='stopping' WHERE id='healthy-update'");
    assert.equal((await collectOperationsMetrics(directory)).overdue_environment_backups, 1, 'incomplete updates cannot establish lineage');
    await directory.pool.query("UPDATE environment_operations SET phase='completed',kind='restore' WHERE id='healthy-update'");
    assert.equal((await collectOperationsMetrics(directory)).overdue_environment_backups, 1, 'restore operations cannot claim source-volume backup lineage');
    await directory.pool.query("UPDATE environment_operations SET kind='update',target_volume='foreign-volume' WHERE id='healthy-update'");
    assert.equal((await collectOperationsMetrics(directory)).overdue_environment_backups, 1);
    await directory.pool.query("UPDATE environment_operations SET target_volume=source_volume WHERE id='healthy-update'");
  });
  await t.test('snapshot age, reporter freshness and policy revisions are independently checked', async () => {
    await directory.pool.query("UPDATE backups SET created_at=now()-interval '25 hours',completed_at=now() WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE backup_status SET reported_at=now()-interval '4 minutes' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query('UPDATE host_policies SET revision=2 WHERE tenant_id=$1', [tenant]);
    const metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.stale_backup_reporters, 1);
    assert.equal(metrics.overdue_database_backups, 1);
    assert.equal(metrics.overdue_environment_backups, 1, 'recent upload completion must not conceal an old snapshot');
    assert.equal(metrics.unready_hosts, 1);
  });
  await t.test('unclaimed due work is visible without mistaking old reusable rows for stalled work', async () => {
    await directory.pool.query("UPDATE lifecycle_jobs SET state='queued',created_at=now()-interval '1 year',retry_at=now(),attempts=999 WHERE tenant_id=$1", [tenant]);
    assert.equal((await collectOperationsMetrics(directory)).overdue_lifecycle_queue, 0);
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()-interval '6 minutes' WHERE tenant_id=$1", [tenant]);
    assert.equal((await collectOperationsMetrics(directory)).overdue_lifecycle_queue, 1);
    await directory.pool.query("UPDATE lifecycle_jobs SET state='cancelled',error_code='historical failure' WHERE tenant_id=$1", [tenant]);
    const metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.overdue_lifecycle_queue, 0);
    assert.equal(metrics.lifecycle_failures, 0);
  });
  await t.test('stuck operations and cleanup expose counts without raw errors or identities', async () => {
    const secretError = 'DO_NOT_EXPORT_SECRET_ERROR';
    await directory.pool.query("UPDATE lifecycle_jobs SET state='running',lease_until=now()-interval '1 second',error_code=$2 WHERE tenant_id=$1", [tenant, secretError]);
    await directory.pool.query("INSERT INTO environment_operations(id,tenant_id,kind,source_generation,target_generation,source_machine,source_volume,source_image,image_digest,region,error_code,created_at) VALUES('operation',$1,'restore',1,2,'machine','volume','image','image','region',$2,now()-interval '31 minutes')", [tenant, secretError]);
    await directory.pool.query("INSERT INTO migration_runs(tenant_id,id,phase,writer,error_code,updated_at) VALUES($1,'migration','reconciliation','unknown',$2,now()-interval '31 minutes')", [tenant, secretError]);
    await directory.pool.query("INSERT INTO retired_volumes(tenant_id,volume_id,operation_id,delete_after,error_code) VALUES($1,'old-volume','operation',now()-interval '6 minutes',$2)", [tenant, secretError]);
    await directory.pool.query("INSERT INTO infrastructure_actions(tenant_id,generation,kind,state,created_at) VALUES($1,2,'machine','dispatching',now()-interval '11 minutes')", [tenant]);
    await directory.pool.query("INSERT INTO host_checkpoints(tenant_id,id,migration_id,machine_id,volume_id,generation,policy_revision,created_at) VALUES($1,'checkpoint','migration','machine','volume',2,1,now()-interval '31 minutes')", [tenant]);
    const metrics = await collectOperationsMetrics(directory);
    for (const field of ['lifecycle_failures', 'expired_lifecycle_leases', 'overdue_environment_operations', 'environment_failures', 'migration_reconciliation', 'overdue_migrations', 'overdue_volume_cleanup', 'uncertain_infrastructure_actions', 'overdue_host_checkpoints']) assert.equal(metrics[field], 1, field);
    const serialized = JSON.stringify(metrics);
    for (const privateValue of [tenant, other, secretError, 'private@example.invalid']) assert.equal(serialized.includes(privateValue), false);
  });
  await t.test('terminal operations stop alerting even when historical errors remain', async () => {
    await directory.pool.query("UPDATE lifecycle_jobs SET state='completed' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE environment_operations SET phase='completed' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE migration_runs SET phase='active',writer='tenant' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE retired_volumes SET state='deleted' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE infrastructure_actions SET state='observed' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE host_checkpoints SET state='complete' WHERE tenant_id=$1", [tenant]);
    const metrics = await collectOperationsMetrics(directory);
    for (const field of ['lifecycle_failures', 'expired_lifecycle_leases', 'overdue_environment_operations', 'environment_failures', 'migration_reconciliation', 'overdue_migrations', 'overdue_volume_cleanup', 'uncertain_infrastructure_actions', 'overdue_host_checkpoints']) assert.equal(metrics[field], 0, field);
  });
  await t.test('confirmed deletion resolves historical delay alerts but never hides an unknown writer', async () => {
    await directory.pool.query("UPDATE migration_runs SET phase='prepared',writer='none',source_retired_at=now(),source_retirement_digest=$2 WHERE tenant_id=$1", [tenant, 'a'.repeat(64)]);
    await directory.pool.query("UPDATE host_checkpoints SET state='pending' WHERE tenant_id=$1", [tenant]);
    await directory.pool.query("UPDATE lifecycle_jobs SET state='cancelled'");
    await directory.revokeTenant(tenant);
    let metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.overdue_migrations, 1, 'deleting is not deleted');
    assert.equal(metrics.overdue_host_checkpoints, 1);
    const storage = { remove: async () => {} } as any;
    const worker = new LifecycleWorker(directory, {
      fly: { name: () => 'test-app', inventory: async () => ({ present: false, machines: [], volumes: [] }), destroy: async () => {} } as any,
      envelopes: { create: async () => {} }, backups: new BackupCatalog(directory, storage), image: 'test-image', region: 'test',
    });
    assert.equal(await worker.tick(), 'completed');
    assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1', [tenant])).rows[0].state, 'deleted');
    assert.equal((await directory.pool.query('SELECT state FROM host_checkpoints WHERE tenant_id=$1', [tenant])).rows[0].state, 'pending');
    metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.overdue_migrations, 0);
    assert.equal(metrics.overdue_host_checkpoints, 0);
    await directory.pool.query("UPDATE migration_runs SET writer='unknown' WHERE tenant_id=$1", [tenant]);
    assert.equal((await collectOperationsMetrics(directory)).migration_reconciliation, 1, 'even deleted metadata with unknown writers requires investigation');
  });
  await t.test('same-volume image updates preserve actual scheduled full-backup evidence', async () => {
    const id = await directory.identity('google', 'metrics-scheduler', { name: 'Scheduler fixture' });
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=id,volume_id='scheduler-volume' WHERE id=$1", [id]);
    const data = path.join(root, 'scheduler-data'); fs.mkdirSync(path.join(data, 'app'), { recursive: true }); fs.mkdirSync(path.join(data, 'files'));
    fs.writeFileSync(path.join(data, 'tenant-manifest.json'), JSON.stringify({ tenantId: id, volumeId: 'scheduler-volume' }));
    fs.writeFileSync(path.join(data, 'files', 'fixture.txt'), 'fixture');
    const db = new Database(path.join(data, 'app', 'swarm.db'));
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);');
    db.prepare('INSERT INTO users VALUES(?)').run(id); db.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(id); db.close();
    const key = randomBytes(32);
    let generation = '1', clock = Date.now() - 5 * 60_000, fullSnapshots = 0;
    const catalog = new BackupCatalog(directory, {
      put: async (_tenant, _backup, _name, body) => { for await (const _chunk of body) { /* encrypted upload fixture */ } },
      get: async () => { throw new Error('not used'); }, remove: async () => {},
    });
    const owner = () => ({ tenant: id, generation });
    const make = () => new HostBackups(data, id, () => Buffer.from(key), {
      begin: pending => catalog.begin(owner(), { id: pending.id, scope: pending.scope, parts: pending.parts.length, bytes: pending.parts.reduce((n, f) => n + f.bytes, 0) }),
      put: (pending, part) => catalog.put(owner(), pending.id, part.name, fs.createReadStream(path.join(pending.directory, part.name)), part.bytes, part.sha256),
      complete: pending => catalog.complete(owner(), pending.id),
      report: status => catalog.report(owner(), status),
    }, async () => { fullSnapshots++; return async () => {}; }, () => clock);
    try {
      await make().tick(); assert.equal(fullSnapshots, 1);
      assert.equal((await collectOperationsMetrics(directory)).overdue_environment_backups, 0);
      await directory.pool.query('UPDATE tenants SET generation=2 WHERE id=$1', [id]);
      await directory.pool.query("INSERT INTO environment_operations(id,tenant_id,kind,phase,source_generation,target_generation,source_machine,source_volume,target_volume,source_image,image_digest,region) VALUES('scheduler-update',$1,'update','completed',1,2,$1,'scheduler-volume','scheduler-volume','image','image','region')", [id]);
      generation = '2'; clock = Date.now();
      await make().tick();
      assert.equal(fullSnapshots, 1, 'the unchanged volume journal deliberately defers the next full snapshot');
      assert.equal((await directory.pool.query("SELECT count(*) FROM backups WHERE tenant_id=$1 AND generation=2 AND scope='environment'", [id])).rows[0].count, '0');
      const metrics = await collectOperationsMetrics(directory);
      assert.equal(metrics.stale_backup_reporters, 0);
      assert.equal(metrics.overdue_database_backups, 0);
      assert.equal(metrics.overdue_environment_backups, 0, 'explicit completed same-volume lineage corroborates the retained full snapshot');
    } finally { key.fill(0); }
  });
  await t.test('an actual PostgreSQL listener loss exports unready until resubscription', async () => {
    let ready = false;
    const notifications = new SessionNotifications(directory, () => {}, value => { ready = value; });
    const token = randomBytes(32).toString('base64url'), tokenFile = path.join(root, 'listener-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const listener = (await startOperationsMetrics(directory, 'platform', {
      config: { tokenFile, port: 0 }, state: () => ({ ready }),
    }))!;
    const endpoint = 'http://127.0.0.1:' + (listener.server.address() as AddressInfo).port + '/metrics';
    const scrape = async () => {
      const response = await fetch(endpoint, { headers: { authorization: 'Bearer ' + token } });
      assert.equal(response.status, 200); return response.text();
    };
    const until = async (predicate: () => boolean) => {
      for (let n = 0; n < 500; n++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Listener readiness did not transition.');
    };
    try {
      await notifications.start();
      assert.match(await scrape(), /swarm_service_ready 1\n/);
      const client = (notifications as any).client;
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await until(() => !ready);
      assert.match(await scrape(), /swarm_service_ready 0\n/);
      await until(() => ready);
      assert.match(await scrape(), /swarm_service_ready 1\n/);
    } finally { notifications.stop(); await listener.close(); }
  });
  await t.test('loopback HTTP requires its dedicated credential and never falls back to browser authentication', async () => {
    const token = randomBytes(32).toString('base64url'), tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    let calls = 0, ready = true, failed = false;
    let gate: Promise<void> | undefined;
    const listener = (await startOperationsMetrics(directory, 'provisioner', {
      config: { tokenFile, port: 0 }, state: () => ({ ready, tickFailures: 2, retentionFailures: 3, retentionLastSuccess: 100 }),
      collect: async () => {
        calls++;
        await gate;
        if (failed) throw new Error('DO_NOT_EXPORT_DATABASE_CREDENTIALS');
        return collectOperationsMetrics(directory);
      },
    }))!;
    try {
      const address = listener.server.address() as AddressInfo;
      assert.equal(address.address, '127.0.0.1');
      const endpoint = 'http://127.0.0.1:' + address.port + '/metrics';
      const headers = { authorization: 'Bearer ' + token };
      for (const headers of [{}, { cookie: 'swarm_session=platform-secret' }, { authorization: 'Bearer ' + 'x'.repeat(43) }]) {
        assert.equal((await fetch(endpoint, { headers })).status, 401);
      }
      assert.equal((await fetch(endpoint, { headers: { ...headers, origin: 'https://swarm.test' } })).status, 403);
      assert.equal((await fetch(endpoint + '?token=' + token, { headers })).status, 404);
      assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 405);
      assert.equal(calls, 0, 'unauthorized requests do not query directory metadata');
      let response = await fetch(endpoint, { headers }), body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(body, /swarm_service_ready 1\n/);
      assert.match(body, /swarm_provisioner_tick_failures_total 2\n/);
      for (const privateValue of [tenant, other, token, 'DO_NOT_EXPORT', 'private@example.invalid']) assert.equal(body.includes(privateValue), false);
      ready = false;
      response = await fetch(endpoint, { headers }); assert.match(await response.text(), /swarm_service_ready 0\n/);
      failed = true;
      response = await fetch(endpoint, { headers }); body = await response.text();
      assert.equal(response.status, 503); assert.equal(body, 'swarm_operations_collection_success 0\n');
      failed = false;
      let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; });
      const before = calls, requests = Array.from({ length: 4 }, () => fetch(endpoint, { headers }));
      for (let attempt = 0; calls === before && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(calls, before + 1);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, before + 1, 'overlapping scrapes share one in-flight snapshot');
      release(); gate = undefined;
      for (const result of await Promise.all(requests)) { assert.equal(result.status, 200); await result.text(); }
    } finally { await listener.close(); }
  });
});
