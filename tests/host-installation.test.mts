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
import {BackupCatalog} from '../server/src/platform/backups.js';
import {backupEnvironment} from '../server/src/platform/backup.js';
import {backupLocation,type BackupStorage} from '../server/src/platform/backup-storage.js';
import {HostInstallations,stageHostInstallation,hostInstallationRoutes,installReceipt} from '../server/src/platform/host-installations.js';
import {HostInstaller,type InstallTransport} from '../server/src/runtime/install-environment.js';
import {setHostIntent} from '../server/src/platform/host-control.js';
import {RuntimeIdentity} from '../server/src/platform/runtime-identity.js';

const url=process.env.TEST_DATABASE_URL;
test('held host installation, owner-scoped transfer and durable publication',{skip:!url},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(target.href);await directory.migrate();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-install-'));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
  async function fixture(){
    const tenant=await directory.identity('google',randomBytes(16).toString('hex'),{name:'Install'}),machine=`machine_${randomBytes(6).toString('hex')}`,volume=`volume_${randomBytes(6).toString('hex')}`,owner={tenant,machine,generation:'1'},master=randomBytes(32);
    t.after(()=>master.fill(0));
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=$2,volume_id=$3 WHERE id=$1",[tenant,machine,volume]);
    const source=path.join(root,`${tenant}-source`),destination=path.join(root,`${tenant}-destination`);fs.mkdirSync(path.join(source,'app'),{recursive:true});fs.mkdirSync(path.join(source,'files'),{recursive:true});fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:'volume_source'}));fs.writeFileSync(path.join(source,'files/private.txt'),'Private to this tenant');
    const db=new Database(path.join(source,'app/swarm.db'));db.exec('CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);CREATE TABLE notes(body TEXT);CREATE TABLE auth_sessions(token TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO users VALUES(?)').run(tenant);db.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(tenant);db.exec("INSERT INTO notes VALUES('original');INSERT INTO auth_sessions VALUES('old-session')");db.close();
    const objects=new Map<string,Buffer>();let gets=0,afterGet:(()=>Promise<void>)|undefined,lastStream:Readable|undefined;
    const storage:BackupStorage={
      async put(who,id,name,body){const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));objects.set(backupLocation(who,id,name),Buffer.concat(chunks));},
      async get(who,id,name){gets++;const b=objects.get(backupLocation(who,id,name));if(!b)throw new Error('not found');lastStream=Readable.from([b]);await afterGet?.();return {body:lastStream,bytes:b.length};},
      async remove(who,id){for(const key of objects.keys())if(key.startsWith(backupLocation(who,id)))objects.delete(key);},
    };
    const catalog=new BackupCatalog(directory,storage);
    async function snapshot(scope:'environment'|'database'){
      const output=path.join(root,randomBytes(16).toString('hex')),backup=await backupEnvironment(source,output,tenant,master,scope);
      const parts=fs.readdirSync(output).map(name=>({name,body:fs.readFileSync(path.join(output,name))}));
      await catalog.begin(owner,{id:backup.id,scope,parts:parts.length,bytes:parts.reduce((n,p)=>n+p.body.length,0)});
      for(const p of parts)await catalog.put(owner,backup.id,p.name,Readable.from([p.body]),p.body.length,createHash('sha256').update(p.body).digest('hex'));
      await catalog.complete(owner,backup.id);return backup.id;
    }
    const fullBackup=await snapshot('environment');const changed=new Database(path.join(source,'app/swarm.db'));changed.exec("UPDATE notes SET body='latest'");changed.close();const databaseBackup=await snapshot('database');
    await directory.pool.query("UPDATE tenants SET state='provisioning' WHERE id=$1",[tenant]);
    const plan={...owner,volume,id:randomBytes(16).toString('hex'),fullBackup,databaseBackup};
    await directory.transaction(c=>stageHostInstallation(c,plan));
    const installations=new HostInstallations(directory,storage);
    const transport:InstallTransport={plan:()=>installations.plan(owner),parts:(p,b,a)=>installations.parts(owner,p.id,b,a),part:async(p,b,f)=>(await installations.part(owner,p.id,b,f.name)).body,complete:(p,r)=>installations.complete(owner,p.id,r)};
    return {tenant,owner,plan,master,objects,catalog,installations,transport,destination,gets:()=>gets,afterGet:(fn:()=>Promise<void>)=>{afterGet=fn;},lastStream:()=>lastStream,host:(tr=transport)=>new HostInstaller(destination,{...owner,volume},()=>Buffer.from(master),tr)};
  }
  await t.test('newest private database and files publish durably before a lost acknowledgement is retried',async()=>{
    const f=await fixture();await assert.rejects(directory.transaction(c=>setHostIntent(c,f.owner,'run')),/not acknowledged/);
    const transport={...f.transport,complete:async()=>{throw new Error('response lost');}};
    await assert.rejects(f.host(transport).tick(),/response lost/);
    const installed=f.host().activeRoot();assert.notEqual(installed,f.destination);
    assert.equal(fs.readFileSync(path.join(installed,'files/private.txt'),'utf8'),'Private to this tenant');
    const db=new Database(path.join(installed,'app/swarm.db'));assert.equal(db.prepare('SELECT body FROM notes').get().body,'latest');assert.equal(db.prepare('SELECT count(*) n FROM auth_sessions').get().n,0);db.close();
    const downloads=f.gets();await f.host().tick();assert.equal(f.gets(),downloads,'published data must not be downloaded or replaced on retry');
    assert.equal((await f.installations.plan(f.owner))?.state,'installed');
    await directory.transaction(c=>setHostIntent(c,f.owner,'run'));assert.equal(await f.installations.plan(f.owner),null);
    assert.equal(f.host().activeRoot(),installed);
  });
  await t.test('workload and foreign-host credentials cannot read the exact installation ID',async()=>{
    const f=await fixture(),foreign=await fixture(),app=hostInstallationRoutes(f.installations,identity);
    const claims={sub:f.tenant,machine:f.owner.machine,generation:'1'},workload=await identity.sign(claims,'swarm-runtime'),host=await identity.sign(claims,'swarm-host');
    const foreignHost=await identity.sign({sub:foreign.tenant,machine:foreign.owner.machine,generation:'1'},'swarm-host');
    assert.equal((await app.request('/',{headers:{authorization:`Bearer ${workload}`}})).status,401);
    assert.equal((await app.request(`/${f.plan.id}/${f.plan.fullBackup}/manifest.bin`,{headers:{authorization:`Bearer ${foreignHost}`}})).status,409);
    assert.equal(f.gets(),0);
    const manifest=await app.request(`/${f.plan.id}/${f.plan.fullBackup}/manifest.bin`,{headers:{authorization:`Bearer ${host}`}});
    assert.equal(manifest.status,200);assert.ok((await manifest.arrayBuffer()).byteLength>0);
    await assert.rejects(f.installations.complete(foreign.owner,f.plan.id,installReceipt({...f.plan,state:'pending'})));
  });
  await t.test('staging refuses foreign backups, running environments and replacing an immutable plan',async()=>{
    const f=await fixture(),foreign=await fixture();
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,{...f.plan,id:randomBytes(16).toString('hex')})),/cannot be replaced/);
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,{...foreign.plan,fullBackup:f.plan.fullBackup})),/unavailable/);
    await directory.pool.query("UPDATE tenants SET state='active' WHERE id=$1",[f.tenant]);
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,f.plan)),/held, unpublished/);
  });
  await t.test('revocation while storage opens blocks byte delivery and publication',async()=>{
    const f=await fixture();f.afterGet(()=>directory.revokeTenant(f.tenant));
    await assert.rejects(f.host().tick(),/unavailable/);assert.equal(f.lastStream()?.destroyed,true);
    assert.equal(fs.existsSync(path.join(f.destination,'active-environment.json')),false);
    assert.equal(fs.existsSync(path.join(f.destination,'environments',f.plan.id)),false);
  });
  await t.test('a changed generation before acknowledgement cannot enable workloads',async()=>{
    const f=await fixture();
    const transport={...f.transport,complete:async(p:any,r:string)=>{await directory.pool.query('UPDATE tenants SET generation=generation+1 WHERE id=$1',[f.tenant]);await f.transport.complete(p,r);}};
    await assert.rejects(f.host(transport).tick(),/unavailable/);
    assert.equal((await directory.pool.query('SELECT state FROM host_installations WHERE tenant_id=$1',[f.tenant])).rows[0].state,'pending');
    await assert.rejects(directory.transaction(c=>setHostIntent(c,{...f.owner,generation:'2'},'run')),/not acknowledged/);
  });
  await t.test('tampered ciphertext and oversized inventories never publish an environment',async()=>{
    const f=await fixture(),key=backupLocation(f.tenant,f.plan.fullBackup,'0.bin'),bytes=Buffer.from(f.objects.get(key)!);bytes[0]^=1;f.objects.set(key,bytes);
    await assert.rejects(f.host().tick(),/integrity/);assert.equal(f.host().activeRoot(),f.destination);
    const oversized={...f.transport,parts:async()=>({parts:[],count:100002,bytes:1,next:null})};
    await assert.rejects(f.host(oversized).tick(),/inventory/);assert.equal(f.host().activeRoot(),f.destination);
  });
  await t.test('retention preserves pending inputs while account deletion still erases them',async()=>{
    const f=await fixture();await directory.pool.query("UPDATE backups SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1",[f.tenant]);
    await f.catalog.prune();assert.ok(f.objects.size>0);await f.host().tick();
    await directory.revokeTenant(f.tenant);await f.catalog.prune(f.tenant);assert.equal(f.objects.size,0);
  });
  await t.test('missing acknowledged data and redirected environment pointers fail closed',async()=>{
    const f=await fixture();await f.host().tick();const installed=f.host().activeRoot();
    fs.renameSync(installed,`${installed}-saved`);await assert.rejects(f.host().tick(),/Acknowledged environment is missing/);
    fs.symlinkSync(`${installed}-saved`,installed);assert.throws(()=>f.host().activeRoot(),/Unsafe installed/);
  });
  await t.test('image replacement may reuse only its own volume pointer, never installation authority',async()=>{
    const f=await fixture();await f.host().tick();const root=f.host().activeRoot();
    const replacement=new HostInstaller(f.destination,{...f.owner,machine:'replacement-machine',generation:'2',volume:f.plan.volume},()=>Buffer.from(f.master),f.transport);
    assert.equal(replacement.activeRoot(),root);await assert.rejects(replacement.tick(),/owner changed/);
    for(const delta of [{tenant:'usr_foreign_owner'},{volume:'foreign_volume'}])assert.throws(()=>new HostInstaller(f.destination,{...f.owner,volume:f.plan.volume,...delta},()=>Buffer.from(f.master),f.transport).activeRoot(),/owner changed/);
  });
});
