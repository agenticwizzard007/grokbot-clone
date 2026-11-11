import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import Database from 'better-sqlite3';
import {generateKeyPair,exportPKCS8,exportSPKI} from 'jose';
import {Directory,opaqueToken} from '../server/src/platform/directory.js';
import {HostCheckpoints,stageHostCheckpoint,hostCheckpointRoutes} from '../server/src/platform/host-checkpoints.js';
import {HostControl,setHostIntent} from '../server/src/platform/host-control.js';
import {HostCheckpoint,type CheckpointTransport} from '../server/src/runtime/checkpoints.js';
import {BackupCatalog} from '../server/src/platform/backups.js';
import {backupLocation,type BackupStorage} from '../server/src/platform/backup-storage.js';
import {restoreEnvironment} from '../server/src/platform/backup.js';
import {RuntimeIdentity} from '../server/src/platform/runtime-identity.js';

const url=process.env.TEST_DATABASE_URL;
test('fresh rollback checkpoints require a held owner host and durable encrypted inventory',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(target.href);await directory.migrate();await directory.migrate();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-checkpoint-')),hosts=new HostControl(directory),checkpoints=new HostCheckpoints(directory);
  const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  async function fixture(){
    const tenant=await directory.identity('google',opaqueToken(),{name:'Rollback target'}),machine=`machine_${opaqueToken()}`,volume=`volume_${opaqueToken()}`,migration=opaqueToken(),id=randomBytes(16).toString('hex'),master=randomBytes(32);
    t.after(()=>master.fill(0));const owner={tenant,machine,generation:'1'};
    await directory.pool.query("UPDATE tenants SET state='provisioning',machine_id=$2,volume_id=$3 WHERE id=$1",[tenant,machine,volume]);
    await directory.pool.query("INSERT INTO migration_runs(tenant_id,id,phase,writer) VALUES($1,$2,'rollback_pending','tenant')",[tenant,migration]);
    await directory.transaction(async c=>{await setHostIntent(c,owner,'hold');await stageHostCheckpoint(c,{...owner,id,volume,migration});});
    await hosts.report(owner,{revision:(await hosts.policy(owner)).revision,state:'held'});
    const data=path.join(root,`${tenant}-data`),journal=path.join(root,`${tenant}-journal`);fs.mkdirSync(path.join(data,'app'),{recursive:true});fs.mkdirSync(path.join(data,'files'));
    fs.writeFileSync(path.join(data,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:volume}));fs.writeFileSync(path.join(data,'files/note.txt'),'latest target private file');fs.writeFileSync(path.join(data,'files/empty.txt'),'');
    const db=new Database(path.join(data,'app/swarm.db'));db.exec('CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE notes(body TEXT);');
    db.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(tenant);db.prepare('INSERT INTO users VALUES(?)').run(tenant);db.exec("INSERT INTO notes VALUES('fresh after target activation')");db.close();
    const objects=new Map<string,Buffer>();let puts=0,afterPut:(()=>Promise<void>)|undefined;
    const storage:BackupStorage={async put(who,b,name,body){puts++;const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));objects.set(backupLocation(who,b,name),Buffer.concat(chunks));await afterPut?.();},
      async get(who,b,name){const value=objects.get(backupLocation(who,b,name))!;return {body:Readable.from([value]),bytes:value.length};},
      async remove(who,b){for(const k of objects.keys())if(k.startsWith(backupLocation(who,b)))objects.delete(k);}};
    const catalog=new BackupCatalog(directory,storage);
    const transport:CheckpointTransport={plan:()=>checkpoints.plan(owner),begin:(p,j)=>checkpoints.begin(owner,p.id,{backup:j.backup,parts:j.parts.length,bytes:j.parts.reduce((n,p)=>n+p.bytes,0)}),
      put:(_p,j,part,body)=>catalog.put(owner,j.backup,part.name,body,part.bytes,part.sha256),finishBackup:(_p,j)=>catalog.complete(owner,j.backup),complete:p=>checkpoints.complete(owner,p.id)};
    let running=false;
    const verifyHeld=async(plan:any)=>{const current=await hosts.policy(owner);if(current.desired!=='hold'||current.revision!==plan.revision||running)throw new Error('workloads not held');await hosts.report(owner,{revision:current.revision,state:'held'});};
    const host=(tr=transport)=>new HostCheckpoint(data,journal,{...owner,volume},()=>Buffer.from(master),tr,verifyHeld);
    return {tenant,owner,id,migration,volume,data,journal,master,objects,catalog,transport,host,puts:()=>puts,run:(v:boolean)=>{running=v;},afterPut:(fn:typeof afterPut)=>{afterPut=fn;}};
  }
  await t.test('fresh private database and files restore from a held encrypted checkpoint',async()=>{
    const f=await fixture(),result=await f.host().tick();assert.ok(result);assert.match(result.receipt,/^[a-f0-9]{64}$/);assert.ok([...f.objects.values()].every(v=>!v.includes(Buffer.from('latest target private file'))));
    const bundle=path.join(root,`${f.tenant}-bundle`);fs.mkdirSync(bundle);
    for(const [name,value]of f.objects)fs.writeFileSync(path.join(bundle,name.split('/').at(-1)!),value);
    const destination=path.join(root,`${f.tenant}-restored`);await restoreEnvironment(bundle,destination,f.tenant,result.backup,f.volume,f.master);
    const db=new Database(path.join(destination,'app/swarm.db'));assert.equal((db.prepare('SELECT body FROM notes').get() as any).body,'fresh after target activation');db.close();
    assert.equal(fs.readFileSync(path.join(destination,'files/note.txt'),'utf8'),'latest target private file');assert.equal(fs.statSync(path.join(destination,'files/empty.txt')).size,0);
    await assert.rejects(directory.transaction(c=>setHostIntent(c,f.owner,'run')),/requires its writer hold/);
    assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1',[f.tenant])).rows[0].state,'provisioning');
  });
  await t.test('lost completion acknowledgement retries the same journal and ciphertext',async()=>{
    const f=await fixture();let lost=true;
    const transport={...f.transport,complete:async(p:any)=>{const result=await f.transport.complete(p);if(lost){lost=false;throw new Error('response lost');}return result;}};
    await assert.rejects(f.host(transport).tick(),/response lost/);const bytes=fs.readFileSync(path.join(f.journal,f.id,'journal.json'),'utf8'),puts=f.puts();
    const result=await f.host().tick();assert.ok(result);assert.equal(f.puts(),puts);assert.equal(fs.readFileSync(path.join(f.journal,f.id,'journal.json'),'utf8'),bytes);
  });
  await t.test('ordinary backup admission and pre-existing backups cannot substitute for a fresh checkpoint',async()=>{
    const f=await fixture(),backup=randomBytes(16).toString('hex');
    await assert.rejects(f.catalog.begin(f.owner,{id:backup,scope:'environment',parts:2,bytes:2}),/Runtime revoked/);
    await directory.pool.query("INSERT INTO backups(tenant_id,id,generation,scope,expected_parts,expected_bytes,expires_at) VALUES($1,$2,1,'environment',2,2,now()+interval '1 day')",[f.tenant,backup]);
    await assert.rejects(checkpoints.begin(f.owner,f.id,{backup,parts:2,bytes:2}),/fresh backup/);
    await assert.rejects(f.catalog.put(f.owner,backup,'0.bin',Readable.from(['x']),1,'a'.repeat(64)),/unavailable/);
    assert.equal(f.puts(),0);
  });
  await t.test('workload tokens and a foreign host cannot use a known checkpoint ID',async()=>{
    const f=await fixture(),foreign=await fixture(),app=hostCheckpointRoutes(checkpoints,identity),claims={sub:f.tenant,machine:f.owner.machine,generation:'1'};
    const workload=await identity.sign(claims,'swarm-runtime'),other=await identity.sign({sub:foreign.tenant,machine:foreign.owner.machine,generation:'1'},'swarm-host');
    assert.equal((await app.request('/',{headers:{authorization:`Bearer ${workload}`}})).status,401);
    assert.equal((await app.request(`/${f.id}/complete`,{method:'POST',headers:{authorization:`Bearer ${other}`}})).status,409);
    await assert.rejects(checkpoints.begin(foreign.owner,f.id,{backup:randomBytes(16).toString('hex'),parts:2,bytes:2}),/authorization changed/);
  });
  await t.test('hold acknowledgement is required and staging cannot replace the immutable request',async()=>{
    const f=await fixture();await directory.pool.query('UPDATE host_policies SET acknowledged_revision=NULL WHERE tenant_id=$1',[f.tenant]);
    await assert.rejects(checkpoints.begin(f.owner,f.id,{backup:randomBytes(16).toString('hex'),parts:2,bytes:2}),/acknowledged/);
    await assert.rejects(directory.transaction(c=>stageHostCheckpoint(c,{...f.owner,volume:f.volume,migration:f.migration,id:randomBytes(16).toString('hex')})),/cannot be replaced/);
  });
  await t.test('running workloads cannot produce a checkpoint or permit startup while it is pending',async()=>{
    const f=await fixture();f.run(true);await assert.rejects(f.host().tick(),/not held/);assert.equal(f.puts(),0);
    await assert.rejects(directory.transaction(c=>setHostIntent(c,f.owner,'run')),/writer hold/);
  });
  for(const change of ['revocation','revision','generation'])await t.test(`${change} during upload blocks checkpoint publication`,async()=>{
    const f=await fixture();let changed=false;f.afterPut(async()=>{if(changed)return;changed=true;
      if(change==='revocation')await directory.revokeTenant(f.tenant);
      if(change==='revision')await directory.transaction(c=>setHostIntent(c,f.owner,'hold',true));
      if(change==='generation')await directory.pool.query('UPDATE tenants SET generation=generation+1 WHERE id=$1',[f.tenant]);
    });
    await assert.rejects(f.host().tick(),/authorization changed/);
    assert.equal((await directory.pool.query('SELECT state FROM host_checkpoints WHERE tenant_id=$1',[f.tenant])).rows[0].state,'uploading');
    await assert.rejects(checkpoints.complete(f.owner,f.id));
  });
  await t.test('retention preserves rollback input; deletion revokes and removes its ciphertext',async()=>{
    const f=await fixture();await f.host().tick();await directory.pool.query("UPDATE backups SET expires_at=now()-interval '1 day' WHERE tenant_id=$1",[f.tenant]);
    await f.catalog.prune();assert.ok(f.objects.size>0);await directory.revokeTenant(f.tenant);await f.catalog.prune(f.tenant);assert.equal(f.objects.size,0);
  });
  await t.test('an admitted snapshot with missing local journal requires reconciliation',async()=>{
    const f=await fixture();await f.host().tick();fs.unlinkSync(path.join(f.journal,f.id,'journal.json'));await assert.rejects(f.host().tick(),/journal is missing/);
  });
  await t.test('replaced host journal owners and redirected files cannot publish',async()=>{
    const f=await fixture();await f.host().tick();const journal=path.join(f.journal,f.id,'journal.json'),value=JSON.parse(fs.readFileSync(journal,'utf8'));value.tenant='usr_foreign_owner';fs.writeFileSync(journal,JSON.stringify(value));
    await assert.rejects(f.host().tick(),/identity mismatch/);fs.unlinkSync(journal);fs.symlinkSync(path.join(f.data,'files/note.txt'),journal);await assert.rejects(f.host().tick());
  });
});
