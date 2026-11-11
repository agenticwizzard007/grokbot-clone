import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {generateKeyPair,exportPKCS8,exportSPKI} from 'jose';
import {Directory} from '../server/src/platform/directory.js';
import {FakeFly} from './fixtures/fly-tenants.mjs';
import {LifecycleWorker} from '../server/src/platform/lifecycle-worker.js';
import {HostControl,hostControlRoutes,setHostIntent} from '../server/src/platform/host-control.js';
import {RuntimeIdentity} from '../server/src/platform/runtime-identity.js';
import {RuntimeRefreshStore} from '../server/src/runtime/refresh-state.js';
const url=process.env.TEST_DATABASE_URL,image='registry.test/host@sha256:'+'a'.repeat(64);
test('durable provisioning, host activation and revocation boundaries',{skip:!url},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(connection.href);await directory.migrate();
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const hosts=new HostControl(directory);
  async function fixture(){
    // Other scenarios remain inspectable but cannot be claimed by this scenario.
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE state IN ('queued','failed')");
    const tenant=await directory.identity('google',randomBytes(16).toString('hex'),{name:'Lifecycle'}),fly=new FakeFly();let prunes=0;
    const dependencies={fly,image,region:'iad',envelopes:{create:async()=>{}},backups:{prune:async()=>{prunes++;}}};
    const worker=new LifecycleWorker(directory,dependencies),again=async()=>{await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[tenant]);return worker.tick();};
    const record=async()=>(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];
    const ready=async()=>{const row=await record(),owner={tenant,generation:String(row.generation),machine:row.machine_id};const policy=await hosts.policy(owner);await hosts.report(owner,{revision:policy.revision,state:'running'});};
    return {tenant,fly,worker,dependencies,again,record,ready,prunes:()=>prunes};
  }
  await t.test('creation waits for the exact host acknowledgement and retries without extra resources',async()=>{
    const f=await fixture();assert.equal(await f.worker.tick(),'retry');assert.equal((await f.record()).state,'provisioning');
    assert.equal((await directory.pool.query("SELECT error_code FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='create'",[f.tenant])).rows[0].error_code,'host_readiness_pending');
    await f.ready();assert.equal(await f.again(),'completed');assert.equal((await f.record()).state,'active');
    for(const suffix of ['/apps','/volumes','/machines'])assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith(suffix)).length,1);
  });
  await t.test('lost volume creation response is resolved by inspection, never duplicate creation',async()=>{
    const f=await fixture();let failed=false;
    f.fly.after=async(method,route)=>{if(!failed&&method==='POST'&&route.endsWith('/volumes')){failed=true;throw new Error('lost response');}};
    assert.equal(await f.worker.tick(),'retry');assert.equal(await f.again(),'retry');await f.ready();assert.equal(await f.again(),'completed');
    assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/volumes')).length,1);
  });
  await t.test('unknown creation with no observable result remains blocked instead of issuing another write',async()=>{
    const f=await fixture();f.fly.failBefore=(m,r)=>m==='POST'&&r.endsWith('/volumes');
    assert.equal(await f.worker.tick(),'retry');f.fly.failBefore=undefined;
    assert.equal(await f.again(),'retry');assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/volumes')).length,1);
    assert.equal((await directory.pool.query("SELECT error_code FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='create'",[f.tenant])).rows[0].error_code,'infrastructure_outcome_uncertain');
    assert.equal((await directory.pool.query("SELECT state FROM infrastructure_actions WHERE tenant_id=$1 AND kind='volume'",[f.tenant])).rows[0].state,'dispatching');
  });
  await t.test('deletion during volume creation prevents credentials, activation and stale directory writes',async()=>{
    const f=await fixture();f.fly.after=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes'))await directory.revokeTenant(f.tenant);};
    assert.equal(await f.worker.tick(),'retry');const revoked=await f.record();assert.equal(revoked.state,'deleting');assert.equal(revoked.volume_id,null);
    assert.equal((await directory.pool.query('SELECT 1 FROM runtime_credentials WHERE tenant_id=$1',[f.tenant])).rowCount,0);
    f.fly.after=undefined;assert.equal(await f.again(),'completed');assert.equal((await f.record()).state,'deleted');assert.equal(f.fly.apps.size,0);
  });
  for(const kind of ['app','volume','machine'])await t.test(`late ${kind} creation keeps deletion pending until its outcome is inspected`,async()=>{
    const f=await fixture();let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    const suffix=kind==='app'?'/apps':kind==='volume'?'/volumes':'/machines';
    f.fly.before=async(method,route)=>{if(method==='POST'&&route.endsWith(suffix)){entered();await held;}};
    const creating=f.worker.tick();await started;await directory.revokeTenant(f.tenant);
    const deleting=new LifecycleWorker(directory,f.dependencies);
    try{
      assert.equal(await deleting.tick(),'retry');assert.equal((await f.record()).state,'deleting');
      assert.equal(f.fly.calls.filter(c=>c.method==='DELETE').length,0);
    }finally{release();await creating;}
    f.fly.before=undefined;await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[f.tenant]);
    assert.equal(await deleting.tick(),'completed');assert.equal((await f.record()).state,'deleted');
    assert.equal(f.fly.apps.size,0);assert.equal([...f.fly.machines.values()].flat().length,0);assert.equal([...f.fly.volumes.values()].flat().length,0);
    assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith(suffix)).length,1);
  });
  await t.test('only one worker may own lifecycle operations for a tenant at a time',async()=>{
    const f=await fixture();let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    f.fly.after=async(method,route)=>{if(method==='POST'&&route==='/apps'){entered();await held;}};
    const running=f.worker.tick();await started;
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomBytes(16).toString('hex'),f.tenant]);
    assert.equal(await new LifecycleWorker(directory,f.dependencies).tick(),'idle');release();assert.equal(await running,'retry');
  });
  await t.test('a migrated tenant remains outside generic provisioning while cutover is unresolved',async()=>{
    const f=await fixture();await directory.pool.query('INSERT INTO migration_runs(tenant_id,id,package_hash,source_checkpoint) VALUES($1,$2,$3,$3)',[f.tenant,randomBytes(16).toString('hex'),'0'.repeat(64)]);
    assert.equal(await f.worker.tick(),'idle');assert.equal(f.fly.calls.length,0);
  });
  await t.test('stopped migration writers do not imply legacy data retirement during deletion',async()=>{
    const f=await fixture();await f.worker.tick();await f.ready();await f.again();
    await directory.pool.query("INSERT INTO migration_runs(tenant_id,id,phase,writer,package_hash,source_checkpoint) VALUES($1,$2,'reconciliation','none',$3,$3)",[f.tenant,randomBytes(16).toString('hex'),'0'.repeat(64)]);
    await directory.revokeTenant(f.tenant);assert.equal(await f.again(),'retry');assert.equal((await f.record()).state,'deleting');
    assert.equal((await directory.pool.query("SELECT error_code FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='delete'",[f.tenant])).rows[0].error_code,'migration_cleanup_pending');
    assert.equal(f.prunes(),0);assert.equal(f.fly.calls.filter(c=>c.method==='DELETE').length,0);
    // This is simulated trusted cleanup evidence; no production retirement
    // adapter is provided by a stopped-writer receipt or this test fixture.
    await directory.pool.query("UPDATE migration_runs SET source_retired_at=now(),source_retirement_digest=$2 WHERE tenant_id=$1",[f.tenant,'a'.repeat(64)]);
    assert.equal(await f.again(),'completed');assert.equal((await f.record()).state,'deleted');
  });
  await t.test('suspension fences workloads; wake needs a new acknowledgement before routing',async()=>{
    const f=await fixture();await f.worker.tick();await f.ready();await f.again();
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'suspend')",[randomBytes(16).toString('hex'),f.tenant]);
    assert.equal(await f.worker.tick(),'completed');let row=await f.record();assert.equal(row.state,'suspended');
    assert.equal((await hosts.policy({tenant:f.tenant,generation:'1',machine:row.machine_id})).desired,'hold');
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomBytes(16).toString('hex'),f.tenant]);
    assert.equal(await f.worker.tick(),'retry');row=await f.record();assert.equal(row.state,'provisioning');
    await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('wake replaces expired credentials and a lost bootstrap exchange survives restart',async()=>{
    const f=await fixture();await f.worker.tick();await f.ready();await f.again();const row=await f.record();
    const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'wake-registration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const binding={tenant:f.tenant,machine:row.machine_id,volume:row.volume_id,generation:'1'},store=()=>new RuntimeRefreshStore(path.join(root,'refresh'),binding);
    const bootstrap=()=>Buffer.from(f.fly.machines.get(row.fly_app)![0].config.files[0].raw_value,'base64').toString();
    const first=store().prepare(bootstrap());await identity.exchange(first.current,f.tenant,row.machine_id,first.pending);store().commit(first,first.pending);
    await directory.pool.query("UPDATE runtime_credentials SET expires_at=now()-interval '1 day' WHERE tenant_id=$1",[f.tenant]);
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'suspend')",[randomBytes(16).toString('hex'),f.tenant]);assert.equal(await f.worker.tick(),'completed');
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomBytes(16).toString('hex'),f.tenant]);assert.equal(await f.worker.tick(),'retry');
    await assert.rejects(identity.exchange(first.pending,f.tenant,row.machine_id));
    const replacement=bootstrap(),attempt=store().prepare(replacement);assert.notEqual(attempt.current,first.current);
    await identity.exchange(attempt.current,f.tenant,row.machine_id,attempt.pending); // Accepted; pretend response was lost.
    const retry=store().prepare(replacement),recovered=await identity.exchange(retry.current,f.tenant,row.machine_id,retry.pending);
    store().commit(retry,recovered.refresh);assert.equal(store().prepare(replacement).current,recovered.refresh);
    await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('a stopped VM cannot reuse its previous running acknowledgement',async()=>{
    const f=await fixture();await f.worker.tick();await f.ready();await f.again();const row=await f.record();
    f.fly.machines.get(row.fly_app)![0].state='stopped';
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomBytes(16).toString('hex'),f.tenant]);
    assert.equal(await f.worker.tick(),'retry');assert.equal((await f.record()).state,'provisioning');
    assert.equal(await hosts.ready({tenant:f.tenant,machine:row.machine_id,generation:'1'}),false);
    await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('deletion stops compute even while provider disconnection remains pending',async()=>{
    const f=await fixture();await f.worker.tick();await f.ready();await f.again();
    await directory.pool.query("INSERT INTO connected_accounts(id,tenant_id,toolkit,state) VALUES($1,$2,'gmail','active')",[randomBytes(16).toString('hex'),f.tenant]);
    await directory.revokeTenant(f.tenant);assert.equal(await f.worker.tick(),'retry');
    const row=await f.record();assert.equal(row.state,'deleting');assert.equal(f.fly.machines.get(row.fly_app)?.[0].state,'stopped');assert.equal(f.prunes(),0);
  });
  await t.test('guessed application and foreign inventories are refused before deletion effects',async()=>{
    const f=await fixture();await f.worker.tick();const row=await f.record();
    await assert.rejects(f.fly.destroy('swarm-team',f.tenant),/Foreign tenant application/);
    f.fly.volumes.get(row.fly_app)!.push({id:'foreign_volume',name:'foreign'});
    const before=f.fly.calls.filter(c=>c.method==='DELETE').length;
    await assert.rejects(f.fly.destroy(row.fly_app,f.tenant),/Foreign resource/);
    assert.equal(f.fly.calls.filter(c=>c.method==='DELETE').length,before);
  });
  await t.test('hold blocks runtime authorization while only host tokens can inspect/report readiness',async()=>{
    const f=await fixture();await f.worker.tick();const row=await f.record();
    const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
    const owner={tenant:f.tenant,machine:row.machine_id,generation:'1'},claims={sub:owner.tenant,machine:owner.machine,generation:'1'};
    const hostToken=await identity.sign(claims,'swarm-host'),workloadToken=await identity.sign(claims,'swarm-runtime'),app=hostControlRoutes(hosts,identity);
    await directory.transaction(c=>setHostIntent(c,owner,'hold'));
    await assert.rejects(identity.verify(workloadToken),/revoked/);
    assert.equal((await app.request('/policy',{headers:{authorization:`Bearer ${workloadToken}`}})).status,401);
    const policy=await hosts.policy(owner);assert.equal(policy.desired,'hold');
    const report=(input:any)=>app.request('/state',{method:'POST',headers:{authorization:`Bearer ${hostToken}`,'content-type':'application/json'},body:JSON.stringify(input)});
    assert.equal((await report({revision:policy.revision,state:'running'})).status,409);
    assert.equal((await report({revision:policy.revision,state:'held',tenant:'usr_foreign'})).status,409);
    assert.equal((await report({revision:policy.revision,state:'held'})).status,200);
    await directory.transaction(c=>setHostIntent(c,owner,'run'));
    assert.equal((await report({revision:policy.revision,state:'running'})).status,409,'stale policy cannot activate');
    assert.equal(await hosts.ready(owner),false);await f.ready();assert.equal(await hosts.ready(owner),true);
    await directory.pool.query("UPDATE host_policies SET reported_at=now()-interval '5 minutes' WHERE tenant_id=$1",[f.tenant]);assert.equal(await hosts.ready(owner),false);
  });
});
