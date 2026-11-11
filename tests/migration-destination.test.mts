import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {Directory,opaqueToken} from '../server/src/platform/directory.js';
import {MigrationDestination,planMigrationDestination} from '../server/src/platform/migration-destination.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';
import {LifecycleWorker} from '../server/src/platform/lifecycle-worker.js';
import {FakeFly} from './fixtures/fly-tenants.mts';

const url=process.env.TEST_DATABASE_URL;
test('migration destination reservation is private, fenced and retryable',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(target.href);await directory.migrate();await directory.migrate();
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const image=`registry.example/test@sha256:${'a'.repeat(64)}`;
  for(const gate of infrastructureGates)await directory.pool.query('INSERT INTO release_gates(name,image_digest,evidence_uri,approved_at) VALUES($1,$2,$3,now())',[gate,image,'simulated-destination-test']);
  async function fixture(){
    const tenant=await directory.identity('google',opaqueToken(),{name:'Migrating'}),operation=opaqueToken(),checkpoint=randomBytes(32).toString('hex'),sourceFence=`source:${opaqueToken()}`;
    await directory.pool.query("UPDATE lifecycle_jobs SET state='cancelled' WHERE tenant_id=$1",[tenant]);
    await directory.pool.query("INSERT INTO migration_runs(tenant_id,id,phase,writer,source_checkpoint,source_fence) VALUES($1,$2,'exporting','none',$3,$4)",[tenant,operation,checkpoint,sourceFence]);
    const state={frozen:true,complete:true,stops:0},fly=new FakeFly();
    const source={inspect:async()=>({tenant,checkpoint,fence:sourceFence,writersStopped:state.complete,filesFrozen:state.complete}),frozen:async()=>state.frozen,stop:async()=>{state.stops++;state.frozen=true;return true;}};
    const plan=await planMigrationDestination(directory,{tenant,image,region:'iad'}),destination=new MigrationDestination(directory,fly,source);
    return {tenant,operation,source,state,plan,destination,fly,app:fly.name(tenant)};
  }
  const saved=async(tenant:string)=>(await directory.pool.query('SELECT * FROM migration_destinations WHERE tenant_id=$1',[tenant])).rows[0];
  const posts=(fly:FakeFly)=>fly.calls.filter(call=>call.method==='POST');
  await t.test('read-only plan and repeated reservation create only an isolated app and encrypted volume',async()=>{
    const f=await fixture();assert.equal(f.fly.calls.length,0);assert.equal(await saved(f.tenant),undefined);
    const result=await f.destination.reserve(f.plan);assert.equal(result.routingChanged,false);assert.equal((await saved(f.tenant)).state,'reserved');
    assert.equal(result.network,f.fly.network(f.tenant));assert.equal(f.fly.volumes.get(f.app)![0].encrypted,true);assert.equal(f.fly.machines.size,0);
    const tenant=(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[f.tenant])).rows[0];
    assert.equal(tenant.state,'pending');assert.equal(tenant.machine_id,null);assert.equal(tenant.volume_id,null);assert.equal(tenant.encrypted_data_key,null);
    for(const table of ['runtime_credentials','host_policies','host_installations'])assert.equal((await directory.pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`,[f.tenant])).rowCount,0);
    assert.equal((await f.destination.reserve(f.plan)).volume,result.volume);assert.equal(posts(f.fly).length,2);
  });
  await t.test('reviewed destination binding cannot be replaced or adopted by another tenant',async()=>{
    const f=await fixture(),other=await fixture();await f.destination.reserve(f.plan);
    await assert.rejects(f.destination.reserve({...f.plan,tenant:other.tenant}),/Invalid reviewed/);
    const changed=await planMigrationDestination(directory,{tenant:f.tenant,image,region:'lhr'});
    await assert.rejects(f.destination.reserve(changed),/cannot be replaced/);assert.equal(posts(f.fly).length,2);
    assert.equal(await saved(other.tenant),undefined);
  });
  await t.test('unqualified releases and changed checkpoints cannot allocate resources',async()=>{
    const f=await fixture();
    await assert.rejects(planMigrationDestination(directory,{tenant:f.tenant,image:`registry.example/test@sha256:${'b'.repeat(64)}`,region:'iad'}),/qualification/);
    await directory.pool.query("UPDATE migration_runs SET source_checkpoint=$2 WHERE tenant_id=$1",[f.tenant,'0'.repeat(64)]);
    await assert.rejects(f.destination.reserve(f.plan),/changed/);assert.equal(f.fly.calls.length,0);
  });
  await t.test('withdrawn image qualification is checked again before creation',async()=>{
    const f=await fixture();
    f.fly.before=async(method,route)=>{if(method==='GET'&&route===`/apps/${f.app}`)await directory.pool.query("UPDATE release_gates SET evidence_uri='' WHERE name=$1 AND image_digest=$2",[infrastructureGates[0],image]);};
    try{await assert.rejects(f.destination.reserve(f.plan),/qualification/);assert.equal(posts(f.fly).length,0);}
    finally{await directory.pool.query("UPDATE release_gates SET evidence_uri='simulated-destination-test' WHERE name=$1 AND image_digest=$2",[infrastructureGates[0],image]);}
  });
  for(const stage of ['app','volume'])await t.test(`lost ${stage} creation response is observed without a duplicate create`,async()=>{
    const f=await fixture(),route=stage==='app'?'/apps':`/apps/${f.app}/volumes`;let lost=false;
    f.fly.after=async(method,uri)=>{if(method==='POST'&&uri===route&&!lost){lost=true;throw new Error('response lost');}};
    await assert.rejects(f.destination.reserve(f.plan),/response lost/);
    f.fly.after=undefined;await f.destination.reserve(f.plan);
    assert.equal(posts(f.fly).filter(call=>call.route===route).length,1);assert.equal((await saved(f.tenant)).state,'reserved');
  });
  for(const stage of ['app','volume'])await t.test(`unobserved ${stage} dispatch cannot be blindly replayed`,async()=>{
    const f=await fixture(),route=stage==='app'?'/apps':`/apps/${f.app}/volumes`;
    f.fly.failBefore=(method,uri)=>method==='POST'&&uri===route;
    await assert.rejects(f.destination.reserve(f.plan),/response lost/);f.fly.failBefore=undefined;
    await assert.rejects(f.destination.reserve(f.plan),/cannot be replayed/);
    assert.equal(posts(f.fly).filter(call=>call.route===route).length,1);
    assert.equal((await directory.pool.query("SELECT state FROM infrastructure_actions WHERE tenant_id=$1 AND kind=$2",[f.tenant,stage])).rows[0].state,'dispatching');
  });
  for(const mode of ['partial','resumed'])await t.test(`${mode} source prevents destination effects and requests containment`,async()=>{
    const f=await fixture();if(mode==='partial')f.state.complete=false;else f.state.frozen=false;
    await assert.rejects(f.destination.reserve(f.plan),/complete source hold/);
    assert.equal(posts(f.fly).length,0);assert.equal(f.state.stops,1);
    assert.equal((await directory.pool.query('SELECT phase FROM migration_runs WHERE tenant_id=$1',[f.tenant])).rows[0].phase,'reconciliation');
  });
  await t.test('source loss during volume creation cannot publish a reserved destination',async()=>{
    const f=await fixture();f.fly.after=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes'))f.state.frozen=false;};
    await assert.rejects(f.destination.reserve(f.plan),/complete source hold/);
    assert.equal((await saved(f.tenant)).state,'allocating');assert.equal(f.state.stops,1);assert.equal(f.fly.machines.size,0);
  });
  await t.test('revocation during discovery blocks the first cloud write',async()=>{
    const f=await fixture();f.fly.before=async(method,route)=>{if(method==='GET'&&route===`/apps/${f.app}`)await directory.revokeTenant(f.tenant);};
    await assert.rejects(f.destination.reserve(f.plan),/authorization changed/);assert.equal(posts(f.fly).length,0);
  });
  await t.test('revocation after accepted creation preserves the unresolved intent for deletion',async()=>{
    const f=await fixture();f.fly.after=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes'))await directory.revokeTenant(f.tenant);};
    await assert.rejects(f.destination.reserve(f.plan),/authorization changed/);
    assert.equal((await saved(f.tenant)).volume_id,null);
    assert.equal((await directory.pool.query("SELECT state FROM infrastructure_actions WHERE tenant_id=$1 AND kind='volume'",[f.tenant])).rows[0].state,'dispatching');
  });
  await t.test('a new fence prevents stale observation and lease release',async()=>{
    const f=await fixture();f.fly.after=async(method,route)=>{if(method==='POST'&&route==='/apps')await directory.pool.query("UPDATE migration_runs SET fence=fence+1,lease_owner='successor',lease_until=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1",[f.tenant]);};
    await assert.rejects(f.destination.reserve(f.plan),/authorization changed/);
    const row=(await directory.pool.query('SELECT * FROM migration_runs WHERE tenant_id=$1',[f.tenant])).rows[0];assert.equal(row.lease_owner,'successor');assert.ok(row.lease_until);
    assert.equal((await directory.pool.query("SELECT state FROM infrastructure_actions WHERE tenant_id=$1 AND kind='app'",[f.tenant])).rows[0].state,'dispatching');
  });
  await t.test('an unadmitted namespace and unexpected writer are never adopted',async()=>{
    const f=await fixture();f.fly.apps.set(f.app,{name:f.app,network:f.fly.network(f.tenant)});
    await assert.rejects(f.destination.reserve(f.plan),/Unadmitted/);assert.equal(posts(f.fly).length,0);
    const other=await fixture();await other.destination.reserve(other.plan);
    other.fly.machines.set(other.app,[{id:'unexpected',state:'started',config:{metadata:{swarm_tenant:other.tenant}}}]);
    await assert.rejects(other.destination.reserve(other.plan),/unexpected writer/);assert.equal(posts(other.fly).length,2);
  });
  await t.test('foreign network, extra volumes and unencrypted storage fail reservation',async()=>{
    const f=await fixture();await f.destination.reserve(f.plan);const volume=f.fly.volumes.get(f.app)![0];
    volume.encrypted=false;await assert.rejects(f.destination.reserve(f.plan),/Encrypted volume/);assert.equal((await saved(f.tenant)).state,'allocating');volume.encrypted=true;
    f.fly.volumes.get(f.app)!.push({...volume,id:'duplicate'});await assert.rejects(f.destination.reserve(f.plan),/Ambiguous/);f.fly.volumes.set(f.app,[volume]);
    f.fly.apps.get(f.app).network='shared';await assert.rejects(f.destination.reserve(f.plan),/Foreign application network/);
    assert.equal(posts(f.fly).length,2);
  });
  await t.test('lease expiration while waiting for the tenant lock cannot publish allocation',async()=>{
    const f=await fixture();let held:Promise<void>|undefined,release!:()=>void;
    f.fly.after=async(method,route)=>{
      if(method!=='POST'||!route.endsWith('/volumes'))return;
      let acquired!:()=>void;const ready=new Promise<void>(resolve=>{acquired=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      held=directory.transaction(async client=>{await client.query('SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);acquired();await gate;await client.query("UPDATE migration_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",[f.tenant]);});
      await ready;setTimeout(release,40);
    };
    await assert.rejects(f.destination.reserve(f.plan),/authorization changed/);await held;
    assert.equal((await saved(f.tenant)).state,'allocating');
  });
  await t.test('account revocation while reservation waits on its first lock cannot create a destination',async()=>{
    const f=await fixture();let acquired!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{acquired=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const held=directory.transaction(async client=>{await client.query('SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);acquired();await gate;await client.query("UPDATE tenants SET state='deleting',generation=generation+1 WHERE id=$1",[f.tenant]);});
    await ready;const pending=assert.rejects(f.destination.reserve(f.plan),/changed, revoked/);setTimeout(release,40);
    await Promise.all([held,pending]);assert.equal(await saved(f.tenant),undefined);assert.equal(f.fly.calls.length,0);
  });
  await t.test('deletion discovers reserved resources but remains blocked without source retirement',async()=>{
    const f=await fixture();await f.destination.reserve(f.plan);await directory.revokeTenant(f.tenant);
    // Isolate this fixture from earlier deliberately unresolved deletion jobs.
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE tenant_id!=$1",[f.tenant]);
    const worker=new LifecycleWorker(directory,{fly:f.fly,image,region:'iad',envelopes:{create:async()=>{}},backups:{prune:async()=>{}}});
    assert.equal(await worker.tick(),'retry');assert.equal(f.fly.apps.has(f.app),true);
    assert.equal((await directory.pool.query("SELECT error_code FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='delete'",[f.tenant])).rows[0].error_code,'migration_cleanup_pending');
    // Simulated retirement proof, not evidence of a real source cleanup adapter.
    await directory.pool.query("UPDATE migration_runs SET source_retired_at=now(),source_retirement_digest=$2 WHERE tenant_id=$1",[f.tenant,'1'.repeat(64)]);
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1",[f.tenant]);
    assert.equal(await worker.tick(),'completed');assert.equal(f.fly.apps.has(f.app),false);assert.equal(f.fly.volumes.get(f.app)?.length,0);
  });
});
