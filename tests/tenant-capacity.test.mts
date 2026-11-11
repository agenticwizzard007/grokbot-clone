import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {Directory} from '../server/src/platform/directory.js';
import {HostControl} from '../server/src/platform/host-control.js';
import {LifecycleWorker} from '../server/src/platform/lifecycle-worker.js';
import {EnvironmentWorker,planEnvironmentOperation,queueEnvironmentOperation,requestEnvironmentRollback} from '../server/src/platform/environment-operations.js';
import {recommendCapacity,setCapacityPolicy,validateCapacityPolicy,type CapacityPolicy,type CapacitySample,type CapacityChange} from '../server/src/platform/tenant-capacity.js';
import {capacityCommand} from '../server/src/platform/capacity-cli.js';
import {environmentCommand} from '../server/src/platform/environment-cli.js';
import {migrateDirectory} from '../server/src/platform/migrate.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';
import {FakeFly} from './fixtures/fly-tenants.mjs';
import {expireLeaseDuringLock} from './fixtures/lease-expiry.mjs';

const image='registry.test/host@sha256:'+'a'.repeat(64),base={guest:{cpu_kind:'shared' as const,cpus:2,memory_mb:4096},volumeGb:10};
const policy:CapacityPolicy={version:1,enabled:true,tiers:[base.guest,{cpu_kind:'shared',cpus:4,memory_mb:8192}],maxVolumeGb:40,volumeStepGb:10,cpuThreshold:.8,memoryThreshold:.8,diskThreshold:.8,reserveGb:2,windowSeconds:120,cooldownSeconds:600};
const owner={tenant:'usr_capacitytesting',generation:'1',machine:'machine_a',volume:'volume_a'};
function samples(binding=owner,now=Date.now(),cpu=.9,usedBytes=9*1024**3):CapacitySample[]{return Array.from({length:5},(_,n)=>({...binding,at:now-(4-n)*30000,cpu,memory:.3,usedBytes}));}
test('capacity recommendations require sustained owner-bound evidence within explicit limits',()=>{
  const now=Date.now(),s=samples(owner,now);
  assert.deepEqual(recommendCapacity(policy,base,s,owner,now),{guest:policy.tiers[1],volumeGb:20});
  assert.deepEqual(recommendCapacity(policy,base,samples(owner,now,.1,2*1024**3),owner,now),base);
  const spike=samples(owner,now,.1,2*1024**3);spike[4].cpu=1;assert.deepEqual(recommendCapacity(policy,base,spike,owner,now),base);
  const memory=samples(owner,now,.1,2*1024**3).map(s=>({...s,memory:.95}));assert.deepEqual(recommendCapacity(policy,base,memory,owner,now).guest,policy.tiers[1]);
  for(const bad of [s.map(v=>({...v,tenant:'usr_foreigntenant'})),s.map(v=>({...v,generation:'2'})),s.map(v=>({...v,machine:'other'})),s.map(v=>({...v,volume:'other'})),s.map(v=>({...v,cpu:NaN})),s.map(v=>({...v,usedBytes:11*1024**3})),s.slice(1),s.map((v,i)=>({...v,at:v.at+(i===2?1e6:0)})),s.map(v=>({...v,at:v.at-70000})),[...s].reverse()])assert.throws(()=>recommendCapacity(policy,base,bad,owner,now));
  assert.throws(()=>recommendCapacity({...policy,enabled:false},base,s,owner,now),/disabled/);
  assert.throws(()=>recommendCapacity({...policy,maxVolumeGb:10},base,s,owner,now),/storage capacity exhausted/);
  assert.throws(()=>recommendCapacity(policy,{...base,guest:policy.tiers[1]},s,owner,now),/compute capacity exhausted/);
  assert.throws(()=>validateCapacityPolicy({...policy,tiers:[policy.tiers[1],policy.tiers[0]]}),/increase/);
  assert.throws(()=>validateCapacityPolicy({...policy,tiers:[base.guest,{...policy.tiers[1],cpu_kind:'performance'}]}),/CPU class/);
  assert.throws(()=>validateCapacityPolicy({...policy,maxVolumeGb:1e9}));
  assert.throws(()=>validateCapacityPolicy({...policy,force:true}));
});
test('migration command rejects implicit roles and runtime credentials before connecting',async()=>{
  for(const role of [undefined,'standalone','tenant','unknown'])await assert.rejects(migrateDirectory({SWARM_ROLE:role,MIGRATION_DATABASE_URL:'postgresql://invalid'}),/explicit platform service role/);
  await assert.rejects(migrateDirectory({SWARM_ROLE:'platform',DATABASE_URL:'postgresql://invalid'}),/MIGRATION_DATABASE_URL/);
});

test('durable usage-based capacity maintenance',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema},public`);
  // Same command used by the release job, including concurrent/idempotent DDL.
  await Promise.all(['platform','provisioner'].map(role=>migrateDirectory({SWARM_ROLE:role,MIGRATION_DATABASE_URL:url.href})));
  const directory=new Directory(url.href),root=fs.mkdtempSync(path.join(os.tmpdir(),'tenant-capacity-'));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  for(const name of [...infrastructureGates,'tenant-capacity-resize'])await directory.pool.query('INSERT INTO release_gates(name,evidence_uri,image_digest,approved_at) VALUES($1,$2,$3,now())',[name,'test-fixture://simulated-only',image]);
  async function fixture(){
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE state IN ('queued','failed')");
    await directory.pool.query("UPDATE environment_operations SET retry_at=now()+interval '1 day' WHERE phase NOT IN ('completed','cancelled')");
    const tenant=await directory.identity('google',randomBytes(16).toString('hex'),{name:'Capacity'}),fly=new FakeFly(),hosts=new HostControl(directory);
    const lifecycle=new LifecycleWorker(directory,{fly,image,region:'iad',envelopes:{create:async()=>{}},backups:{prune:async()=>{}}});
    const current=async()=>(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];
    const ready=async()=>{const row=await current(),owner={tenant,generation:String(row.generation),machine:row.machine_id};await hosts.report(owner,{revision:(await hosts.policy(owner)).revision,state:'running'});};
    await lifecycle.tick();await ready();await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[tenant]);await lifecycle.tick();
    const source=await current(),binding={tenant,generation:'1',machine:source.machine_id,volume:source.volume_id};
    await directory.transaction(c=>setCapacityPolicy(c,tenant,policy));
    const worker=new EnvironmentWorker(directory,fly),again=async()=>{await directory.pool.query('UPDATE environment_operations SET retry_at=now() WHERE tenant_id=$1',[tenant]);return worker.tick();};
    const operation=async()=>(await directory.pool.query('SELECT * FROM environment_operations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1',[tenant])).rows[0];
    const change=():CapacityChange=>({policyRevision:'1',source:structuredClone(base),target:{guest:{...policy.tiers[1]},volumeGb:20},samples:samples(binding),evidence:{uri:'https://evidence.test/usage',sha256:'b'.repeat(64),reviewer:'fixture reviewer'},maintenanceAcknowledged:true});
    const plan=()=>planEnvironmentOperation(directory,{tenant,kind:'update',image,capacity:change()});
    const growths=()=>fly.calls.filter(c=>c.method==='PUT'&&c.route.endsWith('/extend')).length;
    return {tenant,fly,source,binding,current,ready,lifecycle,worker,again,operation,change,plan,growths};
  }
  await t.test('sizing preserves one private volume and every isolation field, then later updates preserve size',async()=>{
    const f=await fixture(),plan=await f.plan();assert.equal((await f.current()).generation,'1');await queueEnvironmentOperation(directory,plan);
    assert.equal(await f.worker.tick(),'retry');const row=await f.current();assert.equal(row.volume_id,f.source.volume_id);assert.notEqual(row.machine_id,f.source.machine_id);
    assert.equal(f.fly.volumes.get(row.fly_app)![0].size_gb,20);assert.equal(f.growths(),1);
    const machine=await f.fly.machine(row.fly_app,f.tenant,row.machine_id,row.volume_id,'2');assert.deepEqual(machine.config.guest,policy.tiers[1]);assert.deepEqual(machine.config.services,[]);assert.equal(machine.config.env.SWARM_TENANT_ID,f.tenant);
    await f.ready();assert.equal(await f.again(),'completed');
    await queueEnvironmentOperation(directory,await planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image}));await f.worker.tick();
    const updated=await f.current();assert.deepEqual(f.fly.machines.get(updated.fly_app)![0].config.guest,policy.tiers[1]);assert.equal(f.fly.volumes.get(updated.fly_app)![0].size_gb,20);assert.equal(f.growths(),1);
    await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('operator commands need an approved policy, create a private reviewable plan and queue separately',async()=>{
    const f=await fixture(),usage=path.join(root,'usage.json'),output=path.join(root,'plan.json');fs.writeFileSync(usage,JSON.stringify(samples(f.binding)));
    const args=['plan','--tenant',f.tenant,'--usage',usage,'--evidence-uri','https://evidence.test/report','--evidence-sha256','c'.repeat(64),'--reviewer','operator','--acknowledge-maintenance','yes','--output',output];
    assert.equal((await capacityCommand(args,directory,f.fly)).queued,false);assert.equal((await f.current()).state,'active');assert.equal(fs.statSync(output).mode&0o777,0o600);
    await assert.rejects(capacityCommand(args,directory,f.fly),/EEXIST/);await environmentCommand(['queue','--plan',output],directory);
    await assert.rejects(directory.transaction(c=>setCapacityPolicy(c,f.tenant,{...policy,enabled:false})),/reconcile/);
    await assert.rejects(environmentCommand(['queue','--plan',output],directory),/source changed/);
  });
  await t.test('stale samples, changed policy, nonrecommended target and unqualified resizing do not revoke routing',async()=>{
    const f=await fixture(),bad=f.change();bad.samples=samples(f.binding,Date.now()-70000);
    await assert.rejects(planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image,capacity:bad}),/stale/);
    const altered=f.change();altered.target.volumeGb=40;await assert.rejects(planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image,capacity:altered}),/differs/);
    const plan=await f.plan();await directory.transaction(c=>setCapacityPolicy(c,f.tenant,policy));await assert.rejects(queueEnvironmentOperation(directory,plan),/policy changed/);
    await directory.pool.query("DELETE FROM release_gates WHERE name='tenant-capacity-resize'");
    await assert.rejects(f.plan(),/qualification/);assert.equal((await f.current()).state,'active');
    await directory.pool.query("INSERT INTO release_gates(name,evidence_uri,image_digest,approved_at) VALUES('tenant-capacity-resize','test-fixture://only',$1,now())",[image]);
  });
  await t.test('source capacity drift blocks cloud side effects',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());f.fly.machines.get(f.source.fly_app)![0].config.guest.cpus=8;
    const calls=f.fly.calls.length;assert.equal(await f.worker.tick(),'retry');assert.equal(f.fly.calls.slice(calls).some(c=>c.method!=='GET'),false);assert.equal((await f.operation()).source_removed,false);
  });
  await t.test('source image drift blocks resize before writer removal',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());f.fly.machines.get(f.source.fly_app)![0].config.image='registry.test/host@sha256:'+'f'.repeat(64);
    const calls=f.fly.calls.length;assert.equal(await f.worker.tick(),'retry');assert.equal(f.fly.calls.slice(calls).some(c=>c.method!=='GET'),false);
  });
  await t.test('release qualification revoked during a cloud lookup prevents irreversible growth',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());
    f.fly.after=async(m,r)=>{if(m==='GET'&&r.endsWith('/volumes')&&(await f.operation()).source_removed)await directory.pool.query("DELETE FROM release_gates WHERE name='tenant-capacity-resize'");};
    assert.equal(await f.worker.tick(),'retry');assert.equal(f.growths(),0);
    await directory.pool.query("INSERT INTO release_gates(name,evidence_uri,image_digest,approved_at) VALUES('tenant-capacity-resize','test-fixture://only',$1,now())",[image]);
  });
  await t.test('unapproved, future and withdrawn evidence cannot authorize resize or its next dispatch',async()=>{
    const f=await fixture();
    try{
      for(const date of ['infinity','2099-01-01']){
        await directory.pool.query("UPDATE release_gates SET approved_at=$1::timestamptz WHERE name='tenant-capacity-resize'",[date]);
        await assert.rejects(f.plan(),/qualification/);
      }
      await directory.pool.query("UPDATE release_gates SET approved_at=now() WHERE name='tenant-capacity-resize'");
      await queueEnvironmentOperation(directory,await f.plan());
      f.fly.after=async(m,r)=>{if(m==='GET'&&r.endsWith('/volumes')&&(await f.operation()).source_removed)await directory.pool.query("UPDATE release_gates SET approved_at='infinity' WHERE name='tenant-capacity-resize'");};
      assert.equal(await f.worker.tick(),'retry');assert.equal(f.growths(),0);assert.equal((await f.operation()).run_authorized_at,null);
    }finally{await directory.pool.query("UPDATE release_gates SET approved_at=now() WHERE name='tenant-capacity-resize'");}
  });
  await t.test('revoked policy at the stopped replacement lookup prevents bootstrap delivery',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());
    const before=f.fly.calls.length;let lookups=0;
    f.fly.after=async(m,r)=>{if(m==='GET'&&r.includes('/machines/')&&(await f.operation()).target_machine&&++lookups===2)await directory.pool.query('UPDATE tenant_capacity_policies SET revision=revision+1 WHERE tenant_id=$1',[f.tenant]);};
    assert.equal(await f.worker.tick(),'retry');assert.equal(lookups,2);assert.equal(f.fly.calls.slice(before).some(c=>c.method==='POST'&&/^\/apps\/[^/]+\/machines\/[^/]+$/.test(c.route)),false);
    assert.equal((await f.operation()).run_authorized_at,null);
  });
  await t.test('a second fresh recommendation cannot bypass the per-tenant cooldown',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());await f.worker.tick();await f.ready();await f.again();
    const row=await f.current(),binding={tenant:f.tenant,generation:'2',machine:row.machine_id,volume:row.volume_id};
    const source={guest:policy.tiers[1],volumeGb:20},measurements=samples(binding,Date.now(),.1,19*1024**3);
    const capacity={...f.change(),source,target:recommendCapacity(policy,source,measurements,binding),samples:measurements};
    await assert.rejects(planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image,capacity}),/cooldown/);
    assert.equal((await f.current()).state,'active');assert.equal((await f.current()).generation,'2');
  });
  await t.test('lost growth response is resolved by inspection without a second irreversible request',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let failed=false;
    f.fly.after=async(method,route)=>{if(!failed&&method==='PUT'&&route.endsWith('/extend')){failed=true;throw new Error('lost response');}};
    assert.equal(await f.worker.tick(),'retry');assert.equal(await f.again(),'retry');await f.ready();assert.equal(await f.again(),'completed');assert.equal(f.growths(),1);
  });
  await t.test('unknown growth never repeats and keeps rollback and deletion pending',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan());f.fly.failBefore=(m,r)=>m==='PUT'&&r.endsWith('/extend');
    await f.worker.tick();f.fly.failBefore=undefined;assert.equal(await f.again(),'retry');assert.equal(f.growths(),1);
    await requestEnvironmentRollback(directory,queued.id);assert.equal(await f.worker.tick(),'retry');assert.equal((await f.operation()).phase,'aborting');
    await directory.revokeTenant(f.tenant);assert.equal(await f.lifecycle.tick(),'retry');assert.equal((await f.current()).state,'deleting');assert.equal(f.growths(),1);
  });
  await t.test('lost machine-create response after growth is inspected without growing again',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let lost=false;
    f.fly.after=async(m,r)=>{if(!lost&&m==='POST'&&r.endsWith('/machines')){lost=true;throw new Error('lost machine response');}};
    await f.worker.tick();assert.equal(await f.again(),'retry');await f.ready();assert.equal(await f.again(),'completed');assert.equal(f.growths(),1);
  });
  await t.test('rollback before activation preserves irreversible growth and restores prior compute size',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan());let once=false;
    f.fly.after=async(m,r)=>{if(!once&&m==='PUT'&&r.endsWith('/extend')){once=true;throw new Error('lost growth response');}};
    await f.worker.tick();await requestEnvironmentRollback(directory,queued.id);assert.equal(await f.worker.tick(),'completed');
    assert.equal(await f.worker.tick(),'retry');const row=await f.current();assert.equal(row.volume_id,f.source.volume_id);assert.equal(f.fly.volumes.get(row.fly_app)![0].size_gb,20);assert.deepEqual(f.fly.machines.get(row.fly_app)![0].config.guest,base.guest);
    await f.ready();assert.equal(await f.again(),'completed');assert.equal(f.growths(),1);
  });
  await t.test('lease loss during final volume lookup prevents growth dispatch',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());
    f.fly.after=async(m,r)=>{if(m==='GET'&&r.endsWith('/volumes')&&(await f.operation()).source_removed)await directory.pool.query('UPDATE environment_operations SET fence=fence+1,lease_until=NULL WHERE tenant_id=$1',[f.tenant]);};
    assert.equal(await f.worker.tick(),'retry');assert.equal(f.growths(),0);
  });
  await t.test('lease expiry during an unchanged row lock wait blocks growth until a new claim',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let held:Awaited<ReturnType<typeof expireLeaseDuringLock>>|undefined;
    f.fly.after=async(m,r)=>{if(!held&&m==='GET'&&r.endsWith('/volumes')&&(await f.operation()).source_removed)held=await expireLeaseDuringLock(directory,'environment_operations',f.tenant);};
    assert.equal(await f.worker.tick(),'retry');assert.ok(held);assert.deepEqual(await held.released,{sawWait:true,expired:true});
    assert.equal(f.growths(),0);assert.equal((await f.operation()).phase,'allocating');
    assert.equal((await directory.pool.query("SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND kind LIKE '%:volume-growth'",[f.tenant])).rowCount,0);
    const expired=(await f.operation()).fence;f.fly.after=undefined;
    assert.equal(await f.again(),'retry');assert.ok(BigInt((await f.operation()).fence)>BigInt(expired));assert.equal(f.growths(),1);
    await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('usage that expires while waiting for a policy row cannot be queued',async()=>{
    const f=await fixture(),capacity=f.change();capacity.samples=samples(f.binding,Date.now()-55000);
    const plan=await planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image,capacity});
    const blocker=await directory.pool.connect();await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT tenant_id FROM tenant_capacity_policies WHERE tenant_id=$1 FOR UPDATE',[f.tenant]);
    const pending=queueEnvironmentOperation(directory,plan);void pending.catch(()=>{});let sawWait=false;
    try{
      for(let n=0;n<200;n++){
        if((await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT revision,policy FROM tenant_capacity_policies%'",[pid])).rowCount){sawWait=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(sawWait,true);const newest=capacity.samples.at(-1)!.at;
      while(Date.now()-newest<=60010)await new Promise(resolve=>setTimeout(resolve,25));
    }finally{await blocker.query('COMMIT');blocker.release();}
    await assert.rejects(pending,/stale/);assert.equal((await f.current()).state,'active');assert.equal((await f.current()).generation,'1');assert.equal(await f.operation(),undefined);
  });
  await t.test('deletion waits for an in-flight growth outcome then cleans only the owning environment',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    f.fly.before=async(m,r)=>{if(m==='PUT'&&r.endsWith('/extend')){entered();await held;}};
    const resizing=f.worker.tick();await started;
    try{await directory.revokeTenant(f.tenant);assert.equal(await f.lifecycle.tick(),'retry');assert.equal(f.fly.calls.some(c=>c.method==='DELETE'&&c.route.endsWith(`/volumes/${f.source.volume_id}`)),false);}finally{release();await resizing;}
    await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[f.tenant]);assert.equal(await f.lifecycle.tick(),'completed');assert.equal((await f.current()).state,'deleted');assert.equal(f.growths(),1);
  });
  await t.test('changed network and foreign volumes cannot be grown',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());f.fly.apps.get(f.source.fly_app).network='shared';
    await f.worker.tick();assert.equal(f.growths(),0);assert.equal(f.fly.machines.get(f.source.fly_app)![0].state,'started');
  });
});
