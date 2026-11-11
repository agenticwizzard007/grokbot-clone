import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import Database from 'better-sqlite3';
import {generateKeyPair,exportPKCS8,exportSPKI} from 'jose';
import {Directory} from '../server/src/platform/directory.js';
import {LifecycleWorker} from '../server/src/platform/lifecycle-worker.js';
import {EnvironmentWorker,planEnvironmentOperation,queueEnvironmentOperation,requestEnvironmentRollback} from '../server/src/platform/environment-operations.js';
import {environmentCommand} from '../server/src/platform/environment-cli.js';
import {HostControl} from '../server/src/platform/host-control.js';
import {HostInstallations} from '../server/src/platform/host-installations.js';
import {HostInstaller} from '../server/src/runtime/install-environment.js';
import {RuntimeIdentity} from '../server/src/platform/runtime-identity.js';
import {BackupCatalog} from '../server/src/platform/backups.js';
import {backupEnvironment} from '../server/src/platform/backup.js';
import {backupLocation,type BackupStorage} from '../server/src/platform/backup-storage.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';
import {FakeFly} from './fixtures/fly-tenants.mjs';

const url=process.env.TEST_DATABASE_URL,firstImage='registry.test/host@sha256:'+'a'.repeat(64),nextImage='registry.test/host@sha256:'+'b'.repeat(64);
test('fenced environment replacement, encrypted recovery and operator commands',{skip:!url},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(connection.href);await directory.migrate();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'environment-operations-'));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  for(const image of [firstImage,nextImage])for(const name of infrastructureGates)await directory.pool.query('INSERT INTO release_gates(name,evidence_uri,image_digest,approved_at) VALUES($1,$2,$3,now())',[name,'test-fixture://deterministic-only',image]);
  const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey)),hosts=new HostControl(directory);
  async function fixture(){
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE state IN ('queued','failed')");
    await directory.pool.query("UPDATE environment_operations SET retry_at=now()+interval '1 day' WHERE phase NOT IN ('completed','cancelled')");
    const tenant=await directory.identity('google',randomBytes(16).toString('hex'),{name:'Recovery'}),fly=new FakeFly(),objects=new Map<string,Buffer>(),master=randomBytes(32);t.after(()=>master.fill(0));
    const storage:BackupStorage={
      async put(who,id,name,body){const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));objects.set(backupLocation(who,id,name),Buffer.concat(chunks));},
      async get(who,id,name){const data=objects.get(backupLocation(who,id,name));if(!data)throw new Error('not found');return {body:Readable.from([data]),bytes:data.length};},
      async remove(who,id){for(const key of objects.keys())if(key.startsWith(backupLocation(who,id)))objects.delete(key);},
    };
    const backups=new BackupCatalog(directory,storage),lifecycle=new LifecycleWorker(directory,{fly,backups,image:firstImage,region:'iad',envelopes:{create:async()=>{}}});
    const current=async()=>(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];
    const ready=async()=>{const row=await current(),owner={tenant,generation:String(row.generation),machine:row.machine_id};await hosts.report(owner,{revision:(await hosts.policy(owner)).revision,state:'running'});};
    await lifecycle.tick();await ready();await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[tenant]);await lifecycle.tick();const source=await current();
    const data=path.join(root,tenant);fs.mkdirSync(path.join(data,'app'),{recursive:true});fs.mkdirSync(path.join(data,'files'));
    fs.writeFileSync(path.join(data,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:source.volume_id}));fs.writeFileSync(path.join(data,'files/private.txt'),'owner private file');
    const database=new Database(path.join(data,'app/swarm.db'));database.exec('CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);CREATE TABLE notes(body TEXT)');database.prepare('INSERT INTO users VALUES(?)').run(tenant);database.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(tenant);database.exec("INSERT INTO notes VALUES('full snapshot')");database.close();
    async function snapshot(scope:'environment'|'database'){
      const output=path.join(root,randomBytes(16).toString('hex')),saved=await backupEnvironment(data,output,tenant,master,scope),parts=fs.readdirSync(output).map(name=>({name,data:fs.readFileSync(path.join(output,name))})),owner={tenant,generation:String(source.generation)};
      await backups.begin(owner,{id:saved.id,scope,parts:parts.length,bytes:parts.reduce((n,p)=>n+p.data.length,0)});
      for(const part of parts)await backups.put(owner,saved.id,part.name,Readable.from([part.data]),part.data.length,createHash('sha256').update(part.data).digest('hex'));
      await backups.complete(owner,saved.id);return saved.id;
    }
    const fullBackup=await snapshot('environment'),db=new Database(path.join(data,'app/swarm.db'));db.exec("UPDATE notes SET body='latest snapshot'");db.close();const databaseBackup=await snapshot('database');
    const worker=new EnvironmentWorker(directory,fly),again=async()=>{await directory.pool.query('UPDATE environment_operations SET retry_at=now() WHERE tenant_id=$1',[tenant]);return worker.tick();};
    const plan=(kind:'restore'|'update'='restore')=>planEnvironmentOperation(directory,{tenant,kind,image:nextImage,...(kind==='restore'?{fullBackup,databaseBackup}:{})});
    const operation=async()=>(await directory.pool.query('SELECT * FROM environment_operations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1',[tenant])).rows[0];
    const install=async()=>{
      const row=await current(),owner={tenant,generation:String(row.generation),machine:row.machine_id},installations=new HostInstallations(directory,storage),destination=path.join(root,row.volume_id);fs.mkdirSync(destination,{recursive:true});
      const host=new HostInstaller(destination,{...owner,volume:row.volume_id},()=>Buffer.from(master),{plan:()=>installations.plan(owner),parts:(p,b,a)=>installations.parts(owner,p.id,b,a),part:async(p,b,f)=>(await installations.part(owner,p.id,b,f.name)).body,complete:(p,r)=>installations.complete(owner,p.id,r)});
      await host.tick();return {host,destination,owner};
    };
    return {tenant,fly,source,current,ready,worker,again,operation,plan,install,lifecycle,backups,objects,fullBackup,databaseBackup};
  }
  await t.test('restore stops the source, installs exact owner data and routes only after readiness',async()=>{
    const f=await fixture(),oldToken=await identity.sign({sub:f.tenant,machine:f.source.machine_id,generation:'1'},'swarm-runtime');
    const reviewed=await f.plan();assert.equal((await f.current()).state,'active');const queued=await queueEnvironmentOperation(directory,reviewed);await assert.rejects(identity.verify(oldToken),/revoked/);
    assert.equal(await f.worker.tick(),'retry');let row=await f.current();assert.equal(row.state,'provisioning');assert.notEqual(row.volume_id,f.source.volume_id);
    assert.equal(f.fly.machines.get(f.source.fly_app)!.some(m=>m.id===f.source.machine_id),false);
    const calls=f.fly.calls,sourceDeleted=calls.findIndex(c=>c.method==='DELETE'&&c.route.endsWith(`/machines/${f.source.machine_id}`)),newVolume=calls.findLastIndex(c=>c.method==='POST'&&c.route.endsWith('/volumes'));assert.ok(sourceDeleted<newVolume);
    assert.equal((await hosts.policy({tenant:f.tenant,generation:'2',machine:row.machine_id})).desired,'hold');
    const installed=await f.install();assert.equal(fs.readFileSync(path.join(installed.host.activeRoot(),'files/private.txt'),'utf8'),'owner private file');
    const db=new Database(path.join(installed.host.activeRoot(),'app/swarm.db'));assert.equal(db.prepare('SELECT body FROM notes').get().body,'latest snapshot');db.close();
    assert.equal(await f.again(),'retry');assert.equal((await f.current()).state,'provisioning');await f.ready();assert.equal(await f.again(),'completed');
    row=await f.current();assert.equal(row.state,'active');assert.equal((await f.operation()).id,queued.id);assert.equal((await f.operation()).phase,'completed');
    assert.equal(f.fly.volumes.get(f.source.fly_app)!.length,2,'previous volume retained for recovery audit');
    await directory.pool.query("UPDATE retired_volumes SET delete_after=now()-interval '1 minute' WHERE tenant_id=$1",[f.tenant]);await f.worker.pruneRetiredVolumes();assert.deepEqual(f.fly.volumes.get(f.source.fly_app)!.map(v=>v.id),[row.volume_id]);
  });
  await t.test('image update preserves the current volume and requires a fresh machine acknowledgement',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan('update'));assert.equal(await f.worker.tick(),'retry');
    const row=await f.current();assert.equal(row.volume_id,f.source.volume_id);assert.notEqual(row.machine_id,f.source.machine_id);assert.equal(row.image_digest,nextImage);
    assert.equal((await directory.pool.query('SELECT 1 FROM host_installations WHERE tenant_id=$1',[f.tenant])).rowCount,0);
    assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/volumes')).length,1);await f.ready();assert.equal(await f.again(),'completed');
  });
  await t.test('retention never deletes a current volume or treats an accepted deletion as confirmed',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan());await f.worker.tick();await f.install();await f.again();await f.ready();await f.again();const current=await f.current();
    await directory.pool.query("INSERT INTO retired_volumes(tenant_id,volume_id,operation_id,delete_after) VALUES($1,$2,$3,now()-interval '1 minute')",[f.tenant,current.volume_id,queued.id]);
    const before=f.fly.calls.filter(c=>c.method==='DELETE').length;await f.worker.pruneRetiredVolumes();assert.equal(f.fly.calls.filter(c=>c.method==='DELETE').length,before);
    await directory.pool.query("UPDATE retired_volumes SET delete_after=now()-interval '1 minute' WHERE tenant_id=$1",[f.tenant]);
    const original=structuredClone(f.fly.volumes.get(f.source.fly_app)!.find(v=>v.id===f.source.volume_id));
    f.fly.after=async(method,route)=>{if(method==='DELETE'&&route.endsWith(`/volumes/${f.source.volume_id}`))f.fly.volumes.get(f.source.fly_app)!.push({...original,state:'destroying'});};
    await f.worker.pruneRetiredVolumes();assert.equal((await directory.pool.query('SELECT error_code FROM retired_volumes WHERE tenant_id=$1 AND volume_id=$2',[f.tenant,f.source.volume_id])).rows[0].error_code,'volume_cleanup_requires_retry');
    f.fly.after=undefined;await f.worker.pruneRetiredVolumes();assert.deepEqual(f.fly.volumes.get(f.source.fly_app)!.map(v=>v.id),[current.volume_id]);
    assert.equal((await directory.pool.query('SELECT state FROM retired_volumes WHERE tenant_id=$1 AND volume_id=$2',[f.tenant,f.source.volume_id])).rows[0].state,'deleted');
  });
  await t.test('planning is read-only and stale, foreign-backup or unqualified plans cannot start work',async()=>{
    const f=await fixture(),other=await fixture();
    await assert.rejects(planEnvironmentOperation(directory,{tenant:f.tenant,kind:'restore',image:nextImage,fullBackup:other.fullBackup}),/unavailable/);
    await assert.rejects(planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image:'registry.test/host@sha256:'+'c'.repeat(64)}),/qualification/);
    const plan=await f.plan('update');await directory.pool.query('UPDATE tenants SET generation=generation+1 WHERE id=$1',[f.tenant]);await assert.rejects(queueEnvironmentOperation(directory,plan),/source changed/);
    assert.equal((await directory.pool.query('SELECT 1 FROM environment_operations WHERE tenant_id=$1',[f.tenant])).rowCount,0);
  });
  await t.test('operator plan files must be explicitly queued and cannot be replayed',async()=>{
    const f=await fixture(),output=path.join(root,`${f.tenant}-plan.json`);
    assert.equal((await environmentCommand(['plan','--tenant',f.tenant,'--kind','update','--image',nextImage,'--output',output],directory)).queued,false);
    assert.equal((await f.current()).state,'active');const queued=await environmentCommand(['queue','--plan',output],directory);
    assert.equal((await environmentCommand(['status','--id',queued.id],directory)).phase,'stopping');await assert.rejects(environmentCommand(['queue','--plan',output],directory));
    await assert.rejects(environmentCommand(['queue','--plan',output,'--force','yes'],directory),/Unknown command/);
  });
  await t.test('lost creation responses are inspected without duplicate resources',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let failed=false;
    f.fly.after=async(method,route)=>{if(!failed&&method==='POST'&&route.endsWith('/volumes')){failed=true;throw new Error('response lost');}};
    assert.equal(await f.worker.tick(),'retry');assert.equal(await f.again(),'retry');await f.install();await f.again();await f.ready();assert.equal(await f.again(),'completed');
    assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/volumes')).length,2,'one source and one replacement');
  });
  await t.test('unobserved creates remain pending and never justify another create',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());f.fly.failBefore=(method,route)=>method==='POST'&&route.endsWith('/volumes');
    assert.equal(await f.worker.tick(),'retry');f.fly.failBefore=undefined;assert.equal(await f.again(),'retry');assert.equal((await f.operation()).error_code,'cloud_creation_uncertain');
    assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/volumes')).length,2);
  });
  await t.test('lease loss prevents stale metadata, bootstrap and starts after a cloud response',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());
    f.fly.after=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes'))await directory.pool.query('UPDATE environment_operations SET fence=fence+1,lease_until=NULL WHERE tenant_id=$1',[f.tenant]);};
    assert.equal(await f.worker.tick(),'retry');assert.equal((await f.operation()).target_volume,null);assert.equal((await f.current()).machine_id,f.source.machine_id);
    assert.equal((await directory.pool.query('SELECT 1 FROM runtime_credentials WHERE tenant_id=$1',[f.tenant])).rowCount,0);
  });
  await t.test('normal lifecycle work cannot race a replacement and two replacement workers cannot share its lease',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    f.fly.before=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes')){entered();await held;}};
    const running=f.worker.tick();await started;
    try{
      await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomBytes(16).toString('hex'),f.tenant]);
      assert.equal(await f.lifecycle.tick(),'idle');assert.equal(await new EnvironmentWorker(directory,f.fly).tick(),'idle');
    }finally{release();await running;}
  });
  await t.test('pre-activation rollback recreates the preserved source with a fresh generation',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan());assert.equal(await f.worker.tick(),'retry');
    const replacement=(await f.current()).machine_id;await requestEnvironmentRollback(directory,queued.id);
    assert.equal(await f.worker.tick(),'completed');const aborted=(await directory.pool.query('SELECT * FROM environment_operations WHERE id=$1',[queued.id])).rows[0];assert.equal(aborted.phase,'cancelled');assert.ok(aborted.rollback_operation);
    assert.equal(await f.worker.tick(),'retry');const resumed=await f.current();assert.equal(resumed.generation,'3');assert.equal(resumed.image_digest,firstImage);assert.equal(resumed.volume_id,f.source.volume_id);assert.notEqual(resumed.machine_id,replacement);
    assert.equal(f.fly.volumes.get(f.source.fly_app)!.length,1);await f.ready();assert.equal(await f.again(),'completed');assert.equal((await f.current()).state,'active');
  });
  await t.test('rollback refuses a target that received a run permit even before routing was active',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan('update'));assert.equal(await f.worker.tick(),'retry');
    assert.equal((await f.current()).state,'provisioning');assert.ok((await f.operation()).run_authorized_at);
    await assert.rejects(requestEnvironmentRollback(directory,queued.id),/unactivated/);
    await directory.pool.query("UPDATE host_policies SET desired='hold' WHERE tenant_id=$1",[f.tenant]);await assert.rejects(requestEnvironmentRollback(directory,queued.id),/unactivated/);
  });
  await t.test('rollback waits for uncertain creation outcomes instead of abandoning possible resources',async()=>{
    const f=await fixture(),queued=await queueEnvironmentOperation(directory,await f.plan());f.fly.failBefore=(method,route)=>method==='POST'&&route.endsWith('/volumes');
    await f.worker.tick();f.fly.failBefore=undefined;await requestEnvironmentRollback(directory,queued.id);assert.equal(await f.worker.tick(),'retry');
    assert.equal((await f.operation()).phase,'aborting');assert.equal((await f.operation()).error_code,'cloud_creation_uncertain');assert.equal((await f.current()).state,'suspended');
  });
  await t.test('deletion while replacement creation is delayed waits for and removes every owned resource',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    f.fly.before=async(method,route)=>{if(method==='POST'&&route.endsWith('/volumes')){entered();await held;}};
    const running=f.worker.tick();await started;await directory.revokeTenant(f.tenant);
    try{assert.equal(await f.lifecycle.tick(),'retry');assert.equal((await f.current()).state,'deleting');}finally{release();await running;}
    f.fly.before=undefined;await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[f.tenant]);assert.equal(await f.lifecycle.tick(),'completed');
    assert.equal((await f.current()).state,'deleted');assert.equal(f.fly.apps.size,0);assert.equal([...f.fly.volumes.values()].flat().length,0);
  });
  await t.test('backup expiration during admitted replacement does not race retention',async()=>{
    const f=await fixture();await queueEnvironmentOperation(directory,await f.plan());await directory.pool.query("UPDATE backups SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1",[f.tenant]);
    await f.backups.prune();assert.ok(f.objects.size>0);assert.equal(await f.worker.tick(),'retry');await f.install();await f.again();await f.ready();assert.equal(await f.again(),'completed');
    await f.backups.prune();assert.equal(f.objects.size,0);
  });
});
