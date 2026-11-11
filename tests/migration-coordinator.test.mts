import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Directory } from '../server/src/platform/directory.js';
import { MigrationCoordinator, type MigrationSource, type MigrationTarget } from '../server/src/platform/migration-coordinator.js';

const url = process.env.TEST_DATABASE_URL;
test('migration cutover fences writers and reconciles unknown outcomes', { skip: !url }, async t => {
  const schema = `test_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(connection.href); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const checkpoint = '1'.repeat(64), packageHash = '2'.repeat(64);
  async function fixture() {
    const tenant = await directory.identity('google', randomBytes(16).toString('hex'), { name: 'Migration owner' });
    const state = { source: true, target: false, frozen: false, freezes: 0, restored: 0, resumed: 0, activations: 0, sourceStops: 0, targetStops: 0, revocations: 0 };
    const receipt = { tenant, checkpoint, machine: `machine_${tenant}`, volume: `volume_${tenant}`, generation: '1' };
    const source: MigrationSource = {
      async freeze(_tenant, _operation, fence) { state.freezes++; state.source = false; state.frozen = true; return { tenant, checkpoint, fence, writersStopped: true, filesFrozen: true }; },
      async inspect() { return state.frozen ? { tenant, checkpoint, fence: '1', writersStopped: true, filesFrozen: true } : null; },
      async frozen() { return state.frozen && !state.source; },
      async restore(_tenant, _operation, target) { assert.equal(state.target, false); state.restored++; return { checkpoint: target.checkpoint, writersStopped: true }; },
      async resume() { assert.equal(state.target, false); state.source = true; state.resumed++; },
      async resumeState() { return { state: state.source ? 'active' : 'stopped', checkpoint }; },
      async stop() { state.sourceStops++; state.source = false; return true; },
    };
    const target: MigrationTarget = {
      async verify() { return true; },
      async activate() { assert.equal(state.source, false); state.target = true; state.activations++; return receipt; },
      async inspect() { return state.target ? { state: 'active', checkpoint: receipt } : { state: 'absent' }; },
      async freeze() { state.target = false; return { ...receipt, writersStopped: true }; },
      async stop() { state.targetStops++; state.target = false; return true; },
    };
    const coordinator = new MigrationCoordinator(directory, source, target, () => { state.revocations++; });
    const run = async () => (await directory.pool.query('SELECT * FROM migration_runs WHERE tenant_id=$1', [tenant])).rows[0];
    return { tenant, state, source, target, receipt, coordinator, run, prepare: async () => { await coordinator.beginExport(tenant); await coordinator.prepare(tenant, packageHash, checkpoint); } };
  }
  await t.test('normal cutover and reconciled rollback keep one writer and are idempotent', async () => {
    const f = await fixture(); await f.prepare(); await f.coordinator.cutover(f.tenant); await f.coordinator.cutover(f.tenant);
    assert.equal(f.state.activations, 1); assert.equal(f.state.source, false); assert.equal((await f.run()).writer, 'tenant');
    await f.coordinator.rollback(f.tenant); await f.coordinator.rollback(f.tenant);
    assert.equal(f.state.restored, 1); assert.equal(f.state.resumed, 1); assert.equal(f.state.target, false); assert.equal((await f.run()).writer, 'legacy');
  });
  await t.test('prepare rejects expired provisioning attempts, not just live leases', async () => {
    const f = await fixture(); await directory.pool.query("UPDATE lifecycle_jobs SET attempts=1,state='failed' WHERE tenant_id=$1", [f.tenant]);
    await assert.rejects(f.prepare(), /Provisioning has started/); assert.equal(await f.run(), undefined);
  });
  await t.test('prepare requires verified identity and matching package', async () => {
    const f = await fixture(); await directory.pool.query('DELETE FROM identities WHERE tenant_id=$1', [f.tenant]);
    await assert.rejects(f.prepare(), /verified immutable identity/);
    const g = await fixture(); g.target.verify = async () => false; await assert.rejects(g.prepare(), /package is not verified/);
  });
  await t.test('export starts with a held source and package verification cannot precede the freeze', async () => {
    const f=await fixture();let verified=0;
    f.target.verify=async(tenant,hash,source)=>{verified++;assert.equal(tenant,f.tenant);assert.equal(hash,packageHash);assert.equal(source,checkpoint);assert.equal(f.state.source,false);return true;};
    await assert.rejects(f.coordinator.prepare(f.tenant,packageHash,checkpoint),/absent/);assert.equal(verified,0);
    const frozen=await f.coordinator.beginExport(f.tenant),row=await f.run();
    assert.equal(row.phase,'exporting');assert.equal(row.writer,'none');assert.equal(row.package_hash,null);assert.equal(frozen.checkpoint,checkpoint);
    assert.deepEqual(await f.coordinator.beginExport(f.tenant),frozen);assert.equal(f.state.freezes,1);
    await assert.rejects(f.coordinator.cutover(f.tenant),/reconciliation/);assert.equal(f.state.activations,0);
    await assert.rejects(f.coordinator.prepare(f.tenant,packageHash,'9'.repeat(64)),/exact source checkpoint/);assert.equal(verified,0);
    await f.coordinator.prepare(f.tenant,packageHash,checkpoint);assert.equal(verified,1);assert.equal((await f.run()).phase,'prepared');
  });
  await t.test('a database-only or unproven file fence never admits an export package',async()=>{
    const f=await fixture();const freeze=f.source.freeze;
    f.source.freeze=async(...args)=>({...await freeze(...args),filesFrozen:false});
    await assert.rejects(f.coordinator.beginExport(f.tenant),/not proven frozen/);
    assert.equal((await f.run()).phase,'reconciliation');assert.equal(f.state.activations,0);assert.ok(f.state.sourceStops);
  });
  await t.test('lost freeze response is contained and cannot be blindly retried as a new source snapshot',async()=>{
    const f=await fixture();const freeze=f.source.freeze;
    f.source.freeze=async(...args)=>{await freeze(...args);throw new Error('freeze response lost');};
    await assert.rejects(f.coordinator.beginExport(f.tenant),/response lost/);
    assert.equal(f.state.freezes,1);assert.equal(f.state.source,false);
    await assert.rejects(f.coordinator.beginExport(f.tenant));assert.equal(f.state.freezes,1);
  });
  await t.test('a changed source fence during package verification stops both writers',async()=>{
    const f=await fixture();await f.coordinator.beginExport(f.tenant);
    f.target.verify=async()=>{f.state.source=true;return true;};
    await assert.rejects(f.coordinator.prepare(f.tenant,packageHash,checkpoint),/resumed/);
    assert.equal(f.state.source,false);assert.equal(f.state.target,false);assert.equal((await f.run()).phase,'reconciliation');
  });
  await t.test('source checkpoint changes prevent activation and require explicit reconciliation', async () => {
    const f = await fixture(); await f.prepare(); const inspect = f.source.inspect;
    f.source.inspect = async (...args) => ({ ...(await inspect(...args))!, checkpoint: '3'.repeat(64) });
    await assert.rejects(f.coordinator.cutover(f.tenant), /differs/); assert.equal(f.state.activations, 0);
    assert.equal((await f.run()).phase, 'reconciliation'); await assert.rejects(f.coordinator.cutover(f.tenant), /reconciliation/);
  });
  await t.test('lost activation response stops the actual target and cannot be replayed', async () => {
    const f = await fixture(); await f.prepare(); const activate = f.target.activate;
    f.target.activate = async (...args) => { await activate(...args); throw new Error('lost response'); };
    await assert.rejects(f.coordinator.cutover(f.tenant), /lost response/);
    assert.equal(f.state.target, false); assert.equal(f.state.source, false); assert.equal((await f.run()).writer, 'none');
    await assert.rejects(f.coordinator.cutover(f.tenant)); assert.equal(f.state.activations, 1);
  });
  await t.test('source unexpectedly restarting after activation fences both writers', async () => {
    const f = await fixture(); await f.prepare(); const activate = f.target.activate;
    f.target.activate = async (...args) => { const receipt = await activate(...args); f.state.source = true; return receipt; };
    await assert.rejects(f.coordinator.cutover(f.tenant), /resumed unexpectedly/);
    assert.equal(f.state.target, false); assert.equal(f.state.source, false); assert.ok(f.state.targetStops);
  });
  await t.test('deletion during activation cannot republish a tenant or revive a writer', async () => {
    const f = await fixture(); await f.prepare(); const activate = f.target.activate;
    f.target.activate = async (...args) => { const receipt = await activate(...args); await directory.revokeTenant(f.tenant); return receipt; };
    await assert.rejects(f.coordinator.cutover(f.tenant), /revoked/);
    assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1', [f.tenant])).rows[0].state, 'deleting');
    assert.equal(f.state.target, false); assert.equal(f.state.source, false);
  });
  await t.test('foreign activation receipt is rejected and stopped', async () => {
    const f = await fixture(); await f.prepare(); f.target.activate = async () => ({ ...f.receipt, tenant: 'usr_foreign' });
    await assert.rejects(f.coordinator.cutover(f.tenant), /Invalid target/); assert.equal(f.state.targetStops, 1);
  });
  await t.test('containment failure stays visible and does not claim the writers are stopped', async () => {
    const f = await fixture(); await f.prepare(); f.target.activate = async () => { throw new Error('uncertain'); };
    f.target.stop = async () => { throw new Error('host unreachable'); };
    await assert.rejects(f.coordinator.cutover(f.tenant)); const row = await f.run();
    assert.equal(row.error_code, 'containment_requires_retry'); assert.equal(row.writer, 'unknown');
  });
  await t.test('known active target after process death is inspected without another activation', async () => {
    const f = await fixture(); await f.prepare(); f.state.frozen = true; f.state.source = false; f.state.target = true;
    await directory.pool.query("UPDATE migration_runs SET phase='activating' WHERE tenant_id=$1", [f.tenant]);
    await f.coordinator.cutover(f.tenant); assert.equal(f.state.activations, 0); assert.equal((await f.run()).phase, 'active');
  });
  await t.test('uncertain target after process death never triggers a blind activation retry', async () => {
    const f = await fixture(); await f.prepare(); f.state.frozen = true; f.state.source = false;
    await directory.pool.query("UPDATE migration_runs SET phase='activating' WHERE tenant_id=$1", [f.tenant]);
    await assert.rejects(f.coordinator.cutover(f.tenant), /reconciliation/); assert.equal(f.state.activations, 0);
  });
  await t.test('crash after source resume reconciles without copying a stale checkpoint over live data', async () => {
    const f = await fixture(); await f.prepare(); await f.coordinator.cutover(f.tenant);
    await directory.pool.query("UPDATE migration_runs SET phase='rollback_resuming' WHERE tenant_id=$1", [f.tenant]);
    f.state.source = true; f.state.target = false;
    await f.coordinator.rollback(f.tenant); assert.equal(f.state.restored, 0); assert.equal(f.state.resumed, 0); assert.equal((await f.run()).phase, 'rolled_back');
  });
  await t.test('lost resume response stops source rather than restoring or resuming twice', async () => {
    const f = await fixture(); await f.prepare(); await f.coordinator.cutover(f.tenant); const resume = f.source.resume;
    f.source.resume = async (...args) => { await resume(...args); throw new Error('lost resume response'); };
    await assert.rejects(f.coordinator.rollback(f.tenant)); assert.equal(f.state.source, false); assert.equal(f.state.target, false);
    await assert.rejects(f.coordinator.rollback(f.tenant)); assert.equal(f.state.resumed, 1);
  });
  await t.test('concurrent workers cannot claim the same migration', async () => {
    const f = await fixture(); await f.prepare(); let entered!: () => void, release!: () => void;
    const enteredP = new Promise<void>(r => { entered = r; }), releaseP = new Promise<void>(r => { release = r; });
    const activate = f.target.activate; f.target.activate = async (...args) => { entered(); await releaseP; return activate(...args); };
    const first = f.coordinator.cutover(f.tenant); await enteredP;
    await assert.rejects(f.coordinator.cutover(f.tenant), /already leased/); release(); await first;
  });
  for(const change of ['revocation','lease-expiry'])await t.test(`${change} during a tenant lock wait cannot publish prepared migration metadata`,async()=>{
    const f=await fixture();await f.coordinator.beginExport(f.tenant);
    const lock=await directory.pool.connect();let entered!:()=>void;const waiting=new Promise<void>(done=>{entered=done;});
    f.target.verify=async()=>{await lock.query('BEGIN');await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);entered();return true;};
    const rejection=assert.rejects(f.coordinator.prepare(f.tenant,packageHash,checkpoint),/revoked/);
    try{
      await waiting;let observed=false;
      for(let i=0;i<500;i++){
        if((await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM tenants WHERE id=$1 FOR UPDATE'")).rowCount){observed=true;break;}
        await new Promise(done=>setTimeout(done,5));
      }
      assert.equal(observed,true);
      if(change==='revocation')await lock.query("UPDATE tenants SET state='deleting',generation=generation+1 WHERE id=$1",[f.tenant]);
      else await lock.query("UPDATE migration_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",[f.tenant]);
      await lock.query('COMMIT');await rejection;
      assert.equal((await f.run()).phase,'reconciliation');assert.equal(f.state.activations,0);assert.equal(f.state.source,false);assert.equal(f.state.target,false);
    }finally{await lock.query('ROLLBACK');lock.release();}
  });
  await t.test('directory failure during containment still attempts to stop both external writers',async()=>{
    const f=await fixture();await f.prepare();const transaction=directory.transaction.bind(directory),activate=f.target.activate;
    f.target.activate=async(...args)=>{
      await activate(...args);directory.transaction=async()=>{throw new Error('directory unavailable');};throw new Error('activation response lost');
    };
    try{await assert.rejects(f.coordinator.cutover(f.tenant));assert.equal(f.state.source,false);assert.equal(f.state.target,false);assert.equal(f.state.targetStops,1);}
    finally{directory.transaction=transaction;}
  });
});
