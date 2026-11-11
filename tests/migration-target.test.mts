import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import Database from 'better-sqlite3';
import {Directory,opaqueToken} from '../server/src/platform/directory.js';
import {MigrationCoordinator,type MigrationSource} from '../server/src/platform/migration-coordinator.js';
import {MigrationDestination,planMigrationDestination} from '../server/src/platform/migration-destination.js';
import {inventoryLegacySource} from '../server/src/platform/migration-inventory.js';
import {MigrationTransfer} from '../server/src/platform/migration-transfer.js';
import {FlyMigrationTarget} from '../server/src/platform/migration-target.js';
import {HostControl} from '../server/src/platform/host-control.js';
import {HostInstallations} from '../server/src/platform/host-installations.js';
import {HostCheckpoints} from '../server/src/platform/host-checkpoints.js';
import {HostInstaller} from '../server/src/runtime/install-environment.js';
import {HostCheckpoint} from '../server/src/runtime/checkpoints.js';
import {BackupCatalog} from '../server/src/platform/backups.js';
import {backupLocation,type BackupStorage} from '../server/src/platform/backup-storage.js';
import {restoreEnvironment} from '../server/src/platform/backup.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';
import {FakeFly} from './fixtures/fly-tenants.mts';

const url=process.env.TEST_DATABASE_URL;
test('Fly migration target uses held installation, exact readiness and a fresh rollback checkpoint',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(target.href);await directory.migrate();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-target-')),image=`registry.example/test@sha256:${'a'.repeat(64)}`;
  for(const gate of infrastructureGates)await directory.pool.query('INSERT INTO release_gates(name,image_digest,evidence_uri,approved_at) VALUES($1,$2,$3,now())',[gate,image,'simulated-target-infrastructure']);
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  async function fixture(options:{timeout?:number;idle?:boolean}={}){
    const tenant=await directory.identity('google',opaqueToken(),{name:'Target migration'}),master=randomBytes(32),fly=new FakeFly(),sourceSnapshot=path.join(root,`${tenant}-source.db`),filesRoot=path.join(root,`${tenant}-files`),cliProfilesRoot=path.join(root,`${tenant}-cli`);
    t.after(()=>master.fill(0));fs.mkdirSync(path.join(filesRoot,'bot_owned'),{recursive:true});fs.writeFileSync(path.join(filesRoot,'bot_owned/note.txt'),'source file');
    fs.mkdirSync(cliProfilesRoot);
    const db=new Database(sourceSnapshot);db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,phone TEXT);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));CREATE TABLE notes(user_id TEXT REFERENCES users(id),body TEXT);');
    db.prepare('INSERT INTO users VALUES(?,NULL)').run(tenant);db.prepare('INSERT INTO bots VALUES(?,?)').run('bot_owned',tenant);db.prepare('INSERT INTO notes VALUES(?,?)').run(tenant,'source data');db.close();
    const sourceCheckpoint=createHash('sha256').update(fs.readFileSync(sourceSnapshot)).digest('hex');
    const state={frozen:false,operation:'',sourceFence:'',stops:0,resumed:false,restored:'',rollbackRoot:''};
    const objects=new Map<string,Buffer>(),storage:BackupStorage={
      async put(who,id,name,body){const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));objects.set(backupLocation(who,id,name),Buffer.concat(chunks));},
      async get(who,id,name){const value=objects.get(backupLocation(who,id,name));if(!value)throw new Error('missing object');return {body:Readable.from([value]),bytes:value.length};},
      async remove(who,id){for(const key of objects.keys())if(key.startsWith(backupLocation(who,id)))objects.delete(key);},
    };
    // Source enforcement is simulated. Restore validates the real encrypted target
    // checkpoint; this fixture does not claim a production legacy filesystem fence.
    const source:MigrationSource={
      async freeze(who,op){state.frozen=true;state.operation=op;state.sourceFence=`source:${op}`;return {tenant:who,checkpoint:sourceCheckpoint,fence:state.sourceFence,writersStopped:true,filesFrozen:true};},
      async inspect(who,op){return op===state.operation?{tenant:who,checkpoint:sourceCheckpoint,fence:state.sourceFence,writersStopped:state.frozen,filesFrozen:state.frozen}:null;},
      async frozen(){return state.frozen;},async stop(){state.stops++;state.frozen=true;return true;},
      async restore(who,_op,checkpoint){
        const row=(await directory.pool.query("SELECT * FROM host_checkpoints WHERE tenant_id=$1 AND receipt_hash=$2 AND state='complete'",[who,checkpoint.checkpoint])).rows[0];assert.ok(row);
        const bundle=path.join(root,`${tenant}-rollback-bundle`);fs.mkdirSync(bundle);for(const [key,value]of objects)if(key.startsWith(backupLocation(who,row.backup_id)))fs.writeFileSync(path.join(bundle,key.split('/').at(-1)!),value);
        state.rollbackRoot=path.join(root,`${tenant}-rollback-restored`);await restoreEnvironment(bundle,state.rollbackRoot,tenant,row.backup_id,'legacy_test_volume',master);state.restored=checkpoint.checkpoint;return {checkpoint:checkpoint.checkpoint,writersStopped:true};
      },
      async resume(_who,_op,checkpoint){assert.equal(checkpoint,state.restored);state.resumed=true;state.frozen=false;},
      async resumeState(){return {state:state.resumed?'active':'stopped',checkpoint:state.restored};},
    };
    const hosts=new HostControl(directory),installations=new HostInstallations(directory,storage),checkpoints=new HostCheckpoints(directory),catalog=new BackupCatalog(directory,storage);
    const destination=path.join(root,`${tenant}-destination`);fs.mkdirSync(destination);
    let onWait:(()=>Promise<void>)|undefined,installedRoot='';
    async function hostTick(){
      await onWait?.();if(options.idle)return;
      const row=(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];if(!row.machine_id)return;
      const machine=fly.machines.get(fly.name(tenant))?.find(m=>m.id===row.machine_id);if(machine?.state!=='started')return;
      const owner={tenant,machine:row.machine_id,generation:String(row.generation)},policy=await hosts.policy(owner);
      if(policy.desired==='hold'){
        await hosts.report(owner,{revision:policy.revision,state:'held'});
        const installer=new HostInstaller(destination,{...owner,volume:row.volume_id},()=>Buffer.from(master),{
          plan:()=>installations.plan(owner),parts:(p,b,a)=>installations.parts(owner,p.id,b,a),part:async(p,b,x)=>(await installations.part(owner,p.id,b,x.name)).body,complete:(p,r)=>installations.complete(owner,p.id,r),
        });await installer.tick();installedRoot=installer.activeRoot();
        const checkpoint=new HostCheckpoint(installedRoot,path.join(root,`${tenant}-checkpoints`),{...owner,volume:row.volume_id},()=>Buffer.from(master),{
          plan:()=>checkpoints.plan(owner),begin:(p,j)=>checkpoints.begin(owner,p.id,{backup:j.backup,parts:j.parts.length,bytes:j.parts.reduce((n,v)=>n+v.bytes,0)}),
          put:(_p,j,x,body)=>catalog.put(owner,j.backup,x.name,body,x.bytes,x.sha256),finishBackup:(_p,j)=>catalog.complete(owner,j.backup),complete:p=>checkpoints.complete(owner,p.id),
        },async p=>{const policy=await hosts.policy(owner);assert.equal(policy.desired,'hold');assert.equal(policy.revision,p.revision);await hosts.report(owner,{revision:p.revision,state:'held'});});await checkpoint.tick();
      }else await hosts.report(owner,{revision:policy.revision,state:'running'});
    }
    const adapter=new FlyMigrationTarget(directory,fly,source,async()=>{await hostTick();},options.timeout??3000),coordinator=new MigrationCoordinator(directory,source,adapter,()=>{});
    const frozen=await coordinator.beginExport(tenant),plan=await planMigrationDestination(directory,{tenant,image,region:'iad'});
    const reservation=await new MigrationDestination(directory,fly,source).reserve(plan);
    const reviewedInventoryHash=(await inventoryLegacySource({tenant,sourceSnapshot,filesRoot,cliProfilesRoot})).inventoryHash;
    const uploaded=await new MigrationTransfer(directory,{create:async()=>{},key:async()=>Buffer.from(master)},storage,source).upload({tenant,operation:frozen.operation,checkpoint:frozen.checkpoint,volume:reservation.volume,sourceSnapshot,filesRoot,cliProfilesRoot,reviewedInventoryHash,sourceSessionSecret:'test-only-legacy-session-secret',workDirectory:path.join(root,`${tenant}-transfer`)});
    await coordinator.prepare(tenant,uploaded.packageHash,uploaded.checkpoint);
    return {tenant,fly,source,state,coordinator,adapter,frozen,reservation,uploaded,hostTick,installedRoot:()=>installedRoot,onWait:(fn:typeof onWait)=>{onWait=fn;}};
  }
  const owner=async(tenant:string)=>(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0];
  const migration=async(tenant:string)=>(await directory.pool.query('SELECT * FROM migration_runs WHERE tenant_id=$1',[tenant])).rows[0];
  await t.test('cutover installs owned data before running; rollback captures target changes instead of the original package',async()=>{
    const f=await fixture();assert.equal((await owner(f.tenant)).state,'pending');await f.coordinator.cutover(f.tenant);
    const row=await migration(f.tenant);assert.equal(row.phase,'active');assert.equal(row.writer,'tenant');assert.equal(f.state.frozen,true);assert.equal((await owner(f.tenant)).state,'active');
    const db=new Database(path.join(f.installedRoot(),'app/swarm.db'));assert.equal((db.prepare('SELECT body FROM notes').get() as any).body,'source data');db.exec("UPDATE notes SET body='target work after cutover'");db.close();fs.writeFileSync(path.join(f.installedRoot(),'files/bot_owned/note.txt'),'new target file');
    await f.coordinator.rollback(f.tenant);assert.equal((await migration(f.tenant)).phase,'rolled_back');assert.equal(f.state.resumed,true);assert.notEqual(f.state.restored,row.target_checkpoint);
    const restored=new Database(path.join(f.state.rollbackRoot,'app/swarm.db'));assert.equal((restored.prepare('SELECT body FROM notes').get() as any).body,'target work after cutover');restored.close();
    assert.equal(fs.readFileSync(path.join(f.state.rollbackRoot,'files/bot_owned/note.txt'),'utf8'),'new target file');
    assert.ok(f.fly.machines.get(f.fly.name(f.tenant))!.every(m=>m.state==='stopped'));
  });
  await t.test('the exact already-active target can be inspected after a lost coordinator result',async()=>{
    const f=await fixture();await f.coordinator.cutover(f.tenant);const inspected=await f.adapter.inspect(f.tenant,f.frozen.operation);assert.equal(inspected.state,'active');assert.equal(inspected.checkpoint?.machine,(await owner(f.tenant)).machine_id);
    const creates=f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/machines')).length;await f.coordinator.cutover(f.tenant);assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/machines')).length,creates);
  });
  await t.test('source resumption while the held host installs prevents the run permit and triggers containment',async()=>{
    const f=await fixture();f.onWait(async()=>{f.state.frozen=false;});await assert.rejects(f.coordinator.cutover(f.tenant),/source hold changed/);
    assert.equal((await migration(f.tenant)).phase,'reconciliation');assert.equal((await owner(f.tenant)).state,'suspended');assert.equal(f.state.stops,1);
    assert.equal((await directory.pool.query('SELECT run_authorized_at FROM migration_targets WHERE tenant_id=$1',[f.tenant])).rows[0].run_authorized_at,null);
  });
  await t.test('revocation during the provider bootstrap read blocks the credential write and startup',async()=>{
    const f=await fixture();let reads=0;
    f.fly.after=async(method,route)=>{if(method==='GET'&&/\/machines\/[^/]+$/.test(route)&&++reads===2)await directory.revokeTenant(f.tenant);};
    await assert.rejects(f.coordinator.cutover(f.tenant),/authorization changed/);
    assert.equal(f.fly.calls.some(c=>c.method==='POST'&&c.route.endsWith('/start')),false);assert.equal((await owner(f.tenant)).state,'deleting');
  });
  await t.test('revocation during the provider start read is rechecked at actual dispatch',async()=>{
    const f=await fixture();f.fly.after=async(method,route,result)=>{if(method==='GET'&&/\/machines\/[^/]+$/.test(route)&&result.config?.files)await directory.revokeTenant(f.tenant);};
    await assert.rejects(f.coordinator.cutover(f.tenant),/authorization changed/);assert.equal(f.fly.calls.some(c=>c.method==='POST'&&c.route.endsWith('/start')),false);
  });
  await t.test('lost start acknowledgement remains uncertain and cannot be blindly replayed',async()=>{
    const f=await fixture();let lost=false;f.fly.after=async(method,route)=>{if(method==='POST'&&route.endsWith('/start')&&!lost){lost=true;throw new Error('start response lost');}};
    await assert.rejects(f.coordinator.cutover(f.tenant),/start response lost/);const row=await migration(f.tenant);assert.equal(row.phase,'reconciliation');assert.equal(row.writer,'unknown');
    assert.equal((await directory.pool.query("SELECT state FROM infrastructure_actions WHERE tenant_id=$1 AND kind='migration-install-start'",[f.tenant])).rows[0].state,'dispatching');
    await assert.rejects(f.coordinator.cutover(f.tenant),/phase requires reconciliation/);assert.equal(f.fly.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/start')).length,1);
  });
  await t.test('withdrawn image qualification during the start read prevents actual boot',async()=>{
    const f=await fixture();let removed=false;
    f.fly.after=async(method,route,result)=>{if(!removed&&method==='GET'&&/\/machines\/[^/]+$/.test(route)&&result.config?.files){removed=true;await directory.pool.query("UPDATE release_gates SET evidence_uri='' WHERE name=$1 AND image_digest=$2",[infrastructureGates[0],image]);}};
    try{await assert.rejects(f.coordinator.cutover(f.tenant),/qualification/);assert.equal(f.fly.calls.some(c=>c.method==='POST'&&c.route.endsWith('/start')),false);}
    finally{await directory.pool.query("UPDATE release_gates SET evidence_uri='simulated-target-infrastructure' WHERE name=$1 AND image_digest=$2",[infrastructureGates[0],image]);}
  });
  await t.test('readiness timeout cannot publish routing or assume installation succeeded',async()=>{
    const f=await fixture({idle:true,timeout:20});await assert.rejects(f.coordinator.cutover(f.tenant),/deadline exceeded/);
    assert.equal((await owner(f.tenant)).state,'suspended');assert.equal((await migration(f.tenant)).phase,'reconciliation');
    assert.equal((await directory.pool.query('SELECT run_authorized_at FROM migration_targets WHERE tenant_id=$1',[f.tenant])).rows[0].run_authorized_at,null);
  });
  await t.test('a foreign or substituted volume cannot pass target verification',async()=>{
    const f=await fixture();f.fly.volumes.get(f.fly.name(f.tenant))![0].id='foreign_volume';
    assert.equal(await f.adapter.verify(f.tenant,f.uploaded.packageHash,f.uploaded.checkpoint),false);
    await assert.rejects(f.coordinator.cutover(f.tenant),/Source\/package authorization changed/);assert.equal(f.fly.machines.size,0);
  });
  await t.test('checkpoint failure leaves source stopped and cannot roll back to the imported package',async()=>{
    const f=await fixture();await f.coordinator.cutover(f.tenant);
    f.onWait(async()=>{throw new Error('checkpoint disk failed');});await assert.rejects(f.coordinator.rollback(f.tenant),/checkpoint disk failed/);
    assert.equal(f.state.resumed,false);assert.equal(f.state.restored,'');assert.equal((await migration(f.tenant)).phase,'reconciliation');assert.equal((await owner(f.tenant)).state,'suspended');
  });
});
