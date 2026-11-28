import './fixtures/platform-open-signups.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {Directory} from '../server/src/platform/directory.js';
import {DockerTenants} from '../server/src/platform/docker-tenants.js';
import {LifecycleWorker} from '../server/src/platform/lifecycle-worker.js';
import {EnvironmentWorker,planEnvironmentOperation,queueEnvironmentOperation,requestEnvironmentRollback} from '../server/src/platform/environment-operations.js';
import {HostControl} from '../server/src/platform/host-control.js';
import {assertQualifiedImage} from '../server/src/platform/release-policy.js';
import {fakeDocker,image,foreignImage} from './fixtures/docker-engine.mts';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required (disposable PostgreSQL only).');

test('Docker adapter integrates with fenced lifecycle and environment workers (fake Engine)',async t=>{
  const saved={TENANT_DRIVER:process.env.TENANT_DRIVER,NODE_ENV:process.env.NODE_ENV};
  process.env.TENANT_DRIVER='docker';process.env.NODE_ENV='test';
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(connection.href);await directory.migrate();const engine=await fakeDocker(),driver=new DockerTenants(engine.host);
  t.after(async()=>{await engine.close();await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const tenant=await directory.identity('google',randomBytes(16).toString('hex'),{name:'Docker fixture'});
  const lifecycle=new LifecycleWorker(directory,{fly:driver,image,region:'local',envelopes:{create:async()=>{}},backups:{prune:async()=>{}}});
  const environments=new EnvironmentWorker(directory,driver),hosts=new HostControl(directory);
  const current=async()=>(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];
  const ready=async()=>{const row=await current(),owner={tenant,generation:String(row.generation),machine:row.machine_id};
    // Simulated host acknowledgement for worker integration only, not kernel evidence.
    await hosts.report(owner,{revision:(await hosts.policy(owner)).revision,state:'running'});};
  const retry=async()=>{await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[tenant]);return lifecycle.tick();};
  const retryEnvironment=async()=>{await directory.pool.query('UPDATE environment_operations SET retry_at=now() WHERE tenant_id=$1',[tenant]);return environments.tick();};
  const queue=async(operation:string)=>directory.pool.query('INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,$3)',[randomBytes(16).toString('hex'),tenant,operation]);
  await t.test('create waits for host readiness and reconciles without duplicate resources',async()=>{
    assert.equal(await lifecycle.tick(),'retry');assert.equal((await current()).state,'provisioning');
    await ready();assert.equal(await retry(),'completed');assert.equal((await current()).state,'active');
    assert.equal(engine.networks.size,1);assert.equal(engine.volumes.size,1);assert.equal(engine.containers.size,1);
    assert.equal(engine.calls.filter(c=>c.route==='/containers/create').length,1);
  });
  await t.test('suspend stops the writer; wake refreshes bootstrap and waits for acknowledgement',async()=>{
    const row=await current(),first=engine.containers.get(row.machine_id).bootstrapArchive;
    await queue('suspend');assert.equal(await lifecycle.tick(),'completed');assert.equal((await current()).state,'suspended');
    await queue('wake');assert.equal(await lifecycle.tick(),'retry');assert.equal((await current()).state,'provisioning');
    assert.notDeepEqual(engine.containers.get(row.machine_id).bootstrapArchive,first);
    await ready();assert.equal(await retry(),'completed');assert.equal((await current()).machine_id,row.machine_id);
  });
  await t.test('image replacement preserves the volume and replaces the stopped container',async()=>{
    const before=await current();
    await queueEnvironmentOperation(directory,await planEnvironmentOperation(directory,{tenant,kind:'update',image:foreignImage}));
    assert.equal(await environments.tick(),'retry');const after=await current();
    assert.equal(after.volume_id,before.volume_id);assert.notEqual(after.machine_id,before.machine_id);assert.equal(after.image_digest,foreignImage);
    assert.equal(engine.containers.has(before.machine_id),false);assert.equal(engine.volumes.size,1);
    await ready();assert.equal(await retryEnvironment(),'completed');assert.equal((await current()).state,'active');
  });
  await t.test('pre-activation rollback restores the source image under a new generation',async()=>{
    const before=await current();
    const operation=await queueEnvironmentOperation(directory,await planEnvironmentOperation(directory,{tenant,kind:'update',image}));
    engine.failAfter=(m,r)=>m==='POST'&&r==='/containers/create';
    assert.equal(await environments.tick(),'retry');engine.failAfter=undefined;
    await requestEnvironmentRollback(directory,operation.id);
    assert.equal(await retryEnvironment(),'completed');
    assert.equal(await retryEnvironment(),'retry');const after=await current();
    assert.equal(after.volume_id,before.volume_id);assert.equal(after.image_digest,before.image_digest);
    assert.ok(Number(after.generation)>Number(before.generation));await ready();assert.equal(await retryEnvironment(),'completed');
  });
  await t.test('no simulated Docker operation manufactures Fly release-gate evidence',async()=>{
    assert.equal((await directory.pool.query('SELECT count(*)::integer AS n FROM release_gates')).rows[0].n,0);
    await assert.rejects(assertQualifiedImage(directory.pool,image),/qualification evidence/);
  });
  await t.test('deletion revokes the tenant and removes its entire Docker namespace',async()=>{
    await directory.revokeTenant(tenant);assert.equal(await retry(),'completed');assert.equal((await current()).state,'deleted');
    assert.equal(engine.networks.size,0);assert.equal(engine.volumes.size,0);assert.equal(engine.containers.size,0);
    assert.equal((await directory.pool.query('SELECT 1 FROM runtime_credentials WHERE tenant_id=$1 AND revoked_at IS NULL',[tenant])).rowCount,0);
  });
});
