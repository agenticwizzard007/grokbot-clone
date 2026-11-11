import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash,hkdfSync} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import Database from 'better-sqlite3';
import {Directory,opaqueToken} from '../server/src/platform/directory.js';
import {inventoryLegacySource} from '../server/src/platform/migration-inventory.js';
import {MigrationTransfer,verifiedMigrationTransfer} from '../server/src/platform/migration-transfer.js';
import {MigrationDestination,planMigrationDestination} from '../server/src/platform/migration-destination.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';
import {FakeFly} from './fixtures/fly-tenants.mts';
import {BackupCatalog} from '../server/src/platform/backups.js';
import {backupLocation,type BackupStorage} from '../server/src/platform/backup-storage.js';
import {HostInstallations,stageHostInstallation} from '../server/src/platform/host-installations.js';
import {HostInstaller} from '../server/src/runtime/install-environment.js';
import {sealSecret,openSecret} from '../server/src/security/secret-envelope.js';

const url=process.env.TEST_DATABASE_URL;
const checksum=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
test('migration packages transfer under a frozen-source lease and install privately',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(target.href);await directory.migrate();await directory.migrate();
  const image=`registry.example/test@sha256:${'a'.repeat(64)}`;
  for(const gate of infrastructureGates)await directory.pool.query('INSERT INTO release_gates(name,image_digest,evidence_uri,approved_at) VALUES($1,$2,$3,now())',[gate,image,'test-only-simulated-evidence']);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-transfer-'));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  async function fixture(){
    const tenant=await directory.identity('google',opaqueToken(),{name:'Migrating'}),operation=opaqueToken(),master=randomBytes(32),secret='source-test-only-session-secret';
    t.after(()=>master.fill(0));
    const sourceSnapshot=path.join(root,`${tenant}.db`),filesRoot=path.join(root,`${tenant}-files`),cliProfilesRoot=path.join(root,`${tenant}-cli`),workDirectory=path.join(root,`${tenant}-work`);
    fs.mkdirSync(path.join(filesRoot,'bot_owned/empty-folder'),{recursive:true});fs.writeFileSync(path.join(filesRoot,'bot_owned/note.txt'),'private owner file');fs.writeFileSync(path.join(filesRoot,'bot_owned/empty.txt'),'');
    fs.mkdirSync(path.join(filesRoot,'bot_foreign'),{recursive:true});fs.writeFileSync(path.join(filesRoot,'bot_foreign/secret.txt'),'foreign file');
    fs.mkdirSync(cliProfilesRoot);
    const db=new Database(sourceSnapshot);
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,phone TEXT);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));CREATE TABLE private_api_keys(user_id TEXT REFERENCES users(id),provider TEXT,secret TEXT,PRIMARY KEY(user_id,provider));');
    db.prepare('INSERT INTO users VALUES(?,NULL)').run(tenant);db.prepare('INSERT INTO users VALUES(?,NULL)').run('usr_foreign_owner');
    db.prepare('INSERT INTO bots VALUES(?,?)').run('bot_owned',tenant);db.prepare('INSERT INTO bots VALUES(?,?)').run('bot_foreign','usr_foreign_owner');
    const oldKey=Buffer.from(hkdfSync('sha256',secret,tenant,'swarm-private-secrets-v1',32));db.prepare('INSERT INTO private_api_keys VALUES(?,?,?)').run(tenant,'voice',sealSecret(oldKey,tenant,'api:voice','private provider token'));oldKey.fill(0);db.close();
    const checkpoint=checksum(fs.readFileSync(sourceSnapshot)),sourceFence=`source:${randomBytes(16).toString('hex')}`;
    await directory.pool.query("UPDATE lifecycle_jobs SET state='cancelled' WHERE tenant_id=$1",[tenant]);
    await directory.pool.query("INSERT INTO migration_runs(tenant_id,id,phase,writer,source_checkpoint,source_fence) VALUES($1,$2,'exporting','none',$3,$4)",[tenant,operation,checkpoint,sourceFence]);
    const state={frozen:true,complete:true,checkpoint,stops:0},objects=new Map<string,Buffer>(),calls:string[]=[];
    let beforePut:((name:string)=>Promise<void>)|undefined,afterPut:((name:string)=>Promise<void>)|undefined,beforeKey:(()=>Promise<void>)|undefined;
    const source={inspect:async()=>({tenant,checkpoint:state.checkpoint,fence:sourceFence,writersStopped:state.complete,filesFrozen:state.complete}),frozen:async()=>state.frozen,stop:async()=>{state.stops++;state.frozen=true;return true;}};
    const fly=new FakeFly(),plan=await planMigrationDestination(directory,{tenant,image,region:'iad'});
    const {volume}=await new MigrationDestination(directory,fly,source).reserve(plan);
    const envelopes={create:async()=>{},key:async()=>{await beforeKey?.();return Buffer.from(master);}};
    const storage:BackupStorage={
      async put(who,id,name,body,bytes,sha){calls.push(name);await beforePut?.(name);const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));const value=Buffer.concat(chunks);assert.equal(value.length,bytes);assert.equal(checksum(value),sha);objects.set(backupLocation(who,id,name),value);await afterPut?.(name);},
      async get(who,id,name){const value=objects.get(backupLocation(who,id,name));if(!value)throw new Error('Missing object');return {body:Readable.from([value]),bytes:value.length};},
      async remove(who,id){for(const name of objects.keys())if(name.startsWith(backupLocation(who,id)))objects.delete(name);},
    };
    const reviewedInventoryHash=(await inventoryLegacySource({tenant,sourceSnapshot,filesRoot,cliProfilesRoot})).inventoryHash;
    const input={tenant,operation,checkpoint,volume,sourceSnapshot,filesRoot,cliProfilesRoot,reviewedInventoryHash,workDirectory,sourceSessionSecret:secret};
    return {tenant,operation,volume,master,source,storage,input,state,objects,calls,transfer:()=>new MigrationTransfer(directory,envelopes,storage,source),beforePut:(fn?:typeof beforePut)=>{beforePut=fn;},afterPut:(fn?:typeof afterPut)=>{afterPut=fn;},beforeKey:(fn?:typeof beforeKey)=>{beforeKey=fn;}};
  }
  const record=async(tenant:string)=>(await directory.pool.query('SELECT * FROM migration_transfers WHERE tenant_id=$1',[tenant])).rows[0];

  await t.test('owned database, credentials and empty files survive encrypted transfer and held-host installation',async()=>{
    const f=await fixture(),result=await f.transfer().upload(f.input);
    assert.equal(result.routingChanged,false);assert.equal(f.state.stops,0);assert.equal((await record(f.tenant)).state,'complete');
    assert.equal(fs.existsSync(path.join(f.input.workDirectory,'environment')),false);
    assert.ok([...f.objects.values()].every(value=>!value.includes(Buffer.from('private owner file'))&&!value.includes(Buffer.from('private provider token'))));
    assert.ok([...f.objects.values()].some(value=>value.length===0));
    const verified=await verifiedMigrationTransfer(directory,f.tenant,result.packageHash,result.checkpoint);assert.equal(verified.backup_id,result.backup);
    assert.equal(await verifiedMigrationTransfer(directory,'usr_foreign_owner',result.packageHash,result.checkpoint),null);
    assert.equal(await verifiedMigrationTransfer(directory,f.tenant,'0'.repeat(64),result.checkpoint),null);
    assert.equal(await verifiedMigrationTransfer(directory,f.tenant,result.packageHash,'0'.repeat(64)),null);
    const machine=`machine_${randomBytes(8).toString('hex')}`,owner={tenant:f.tenant,generation:'1',machine},plan={...owner,volume:f.volume,id:randomBytes(16).toString('hex'),fullBackup:result.backup};
    await directory.pool.query("UPDATE migration_runs SET phase='activating',package_hash=$2 WHERE tenant_id=$1",[f.tenant,result.packageHash]);
    await directory.pool.query("UPDATE tenants SET state='provisioning',machine_id=$2,volume_id=$3 WHERE id=$1",[f.tenant,machine,f.volume]);
    await directory.pool.query("UPDATE tenants SET volume_id='wrong_volume' WHERE id=$1",[f.tenant]);
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,{...plan,volume:'wrong_volume'})),/binding changed/);
    await directory.pool.query('UPDATE tenants SET volume_id=$2 WHERE id=$1',[f.tenant,f.volume]);
    // An admitted migration keeps its immutable inputs despite ordinary expiry.
    await directory.pool.query("UPDATE backups SET expires_at=now()-interval '1 day' WHERE tenant_id=$1",[f.tenant]);
    await new BackupCatalog(directory,f.storage).prune();assert.equal((await directory.pool.query('SELECT state FROM backups WHERE tenant_id=$1',[f.tenant])).rows[0].state,'complete');
    await directory.transaction(c=>stageHostInstallation(c,plan));
    const installations=new HostInstallations(directory,f.storage),destination=path.join(root,`${f.tenant}-destination`);fs.mkdirSync(destination);
    const host=new HostInstaller(destination,{...owner,volume:f.volume},()=>Buffer.from(f.master),{
      plan:()=>installations.plan(owner),parts:(p,b,a)=>installations.parts(owner,p.id,b,a),part:async(p,b,x)=>(await installations.part(owner,p.id,b,x.name)).body,complete:(p,r)=>installations.complete(owner,p.id,r),
    });
    await host.tick();const restored=host.activeRoot();
    assert.equal(fs.readFileSync(path.join(restored,'files/bot_owned/note.txt'),'utf8'),'private owner file');assert.equal(fs.statSync(path.join(restored,'files/bot_owned/empty.txt')).size,0);assert.equal(fs.existsSync(path.join(restored,'files/bot_foreign')),false);
    assert.ok(fs.statSync(path.join(restored,'files/bot_owned/empty-folder')).isDirectory());
    const db=new Database(path.join(restored,'app/swarm.db'));try{
      assert.deepEqual(db.prepare('SELECT id FROM users').all(),[{id:f.tenant}]);
      assert.equal(openSecret(f.master,f.tenant,'api:voice',(db.prepare('SELECT secret FROM private_api_keys').get() as any).secret),'private provider token');
    }finally{db.close();}
  });
  for(const field of ['source_checkpoint','source_fence'])await t.test(`unexpired migration backup cannot install after ${field} changes`,async()=>{
    const f=await fixture(),result=await f.transfer().upload(f.input),machine=`machine_${randomBytes(8).toString('hex')}`;
    const plan={tenant:f.tenant,generation:'1',machine,volume:f.volume,id:randomBytes(16).toString('hex'),fullBackup:result.backup};
    await directory.pool.query("UPDATE migration_runs SET phase='activating',package_hash=$2 WHERE tenant_id=$1",[f.tenant,result.packageHash]);
    await directory.pool.query("UPDATE tenants SET state='provisioning',machine_id=$2,volume_id=$3 WHERE id=$1",[f.tenant,machine,f.volume]);
    await directory.pool.query(`UPDATE migration_runs SET ${field}=$2 WHERE tenant_id=$1`,[f.tenant,'f'.repeat(64)]);
    assert.ok((await directory.pool.query('SELECT 1 FROM backups WHERE tenant_id=$1 AND expires_at>now()',[f.tenant])).rowCount);
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,plan)),/binding changed/);
    assert.equal((await directory.pool.query('SELECT 1 FROM host_installations WHERE tenant_id=$1',[f.tenant])).rowCount,0);
  });
  await t.test('completed upload retries reuse the immutable bundle without writing again',async()=>{
    const f=await fixture(),first=await f.transfer().upload(f.input),count=f.calls.length;
    const second=await f.transfer().upload(f.input);assert.deepEqual(second,first);assert.equal(f.calls.length,count);
  });
  for(const mode of ['unreserved','substituted','changed-during-key'])await t.test(`${mode} destination cannot admit or upload a package`,async()=>{
    const f=await fixture();
    if(mode==='unreserved')await directory.pool.query('DELETE FROM migration_destinations WHERE tenant_id=$1',[f.tenant]);
    if(mode==='substituted')f.input.volume='volume_substituted';
    if(mode==='changed-during-key')f.beforeKey(async()=>{await directory.pool.query("UPDATE migration_destinations SET volume_id='volume_substituted' WHERE tenant_id=$1",[f.tenant]);});
    await assert.rejects(f.transfer().upload(f.input),/export is absent|authorization changed/);
    assert.equal(f.objects.size,0);assert.equal(await record(f.tenant),undefined);assert.equal(fs.existsSync(path.join(f.input.workDirectory,'environment')),false);
  });
  await t.test('target verification and installation reject changed reserved-volume bindings',async()=>{
    const f=await fixture(),result=await f.transfer().upload(f.input),machine=`machine_${randomBytes(8).toString('hex')}`;
    await directory.pool.query("UPDATE migration_runs SET phase='activating',package_hash=$2 WHERE tenant_id=$1",[f.tenant,result.packageHash]);
    await directory.pool.query("UPDATE tenants SET state='provisioning',machine_id=$2,volume_id=$3 WHERE id=$1",[f.tenant,machine,f.volume]);
    await directory.pool.query("UPDATE migration_destinations SET volume_id='volume_substituted' WHERE tenant_id=$1",[f.tenant]);
    assert.equal(await verifiedMigrationTransfer(directory,f.tenant,result.packageHash,result.checkpoint),null);
    await assert.rejects(directory.transaction(c=>stageHostInstallation(c,{tenant:f.tenant,generation:'1',machine,volume:f.volume,id:randomBytes(16).toString('hex'),fullBackup:result.backup})),/binding changed/);
  });
  await t.test('ordinary runtime backup APIs cannot bypass the trusted pending-migration transfer path',async()=>{
    const f=await fixture(),catalog=new BackupCatalog(directory,f.storage);
    await assert.rejects(catalog.begin({tenant:f.tenant,generation:'1'},{id:randomBytes(16).toString('hex'),scope:'environment',parts:2,bytes:100}),/Runtime revoked/);
    assert.equal((await directory.pool.query('SELECT 1 FROM backups WHERE tenant_id=$1',[f.tenant])).rowCount,0);assert.equal(f.calls.length,0);
  });
  await t.test('storage acknowledgement without consuming the complete part cannot publish a package',async()=>{
    const f=await fixture(),storage={...f.storage,put:async()=>{}};
    const transfer=new MigrationTransfer(directory,{create:async()=>{},key:async()=>Buffer.from(f.master)},storage,f.source);
    await assert.rejects(transfer.upload(f.input),/complete migration part/);
    assert.equal((await record(f.tenant)).state,'uploading');assert.equal((await directory.pool.query("SELECT 1 FROM backup_parts WHERE tenant_id=$1 AND state='ready'",[f.tenant])).rowCount,0);
  });
  await t.test('lost upload responses retain a lease; retry resumes identical ciphertext after that lease expires',async()=>{
    const f=await fixture();let fail=true;f.afterPut(async()=>{if(fail){fail=false;throw new Error('response lost');}});
    await assert.rejects(f.transfer().upload(f.input),/response lost/);const first=await record(f.tenant);assert.equal(first.state,'uploading');
    const journal=fs.readFileSync(path.join(f.input.workDirectory,'transfer.json'),'utf8');
    await assert.rejects(f.transfer().upload(f.input),/outstanding/);assert.equal(f.calls.length,1);
    await directory.pool.query("UPDATE backup_parts SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",[f.tenant]);
    const result=await f.transfer().upload(f.input);assert.equal(result.backup,first.backup_id);assert.equal(result.packageHash,first.package_hash);assert.equal(fs.readFileSync(path.join(f.input.workDirectory,'transfer.json'),'utf8'),journal);
  });
  await t.test('revocation during upload blocks publication and cleanup waits for outstanding writes',async()=>{
    const f=await fixture();f.afterPut(async()=>{await directory.revokeTenant(f.tenant);});
    await assert.rejects(f.transfer().upload(f.input),/authorization changed/);assert.equal((await record(f.tenant)).state,'uploading');
    assert.equal(await verifiedMigrationTransfer(directory,f.tenant,(await record(f.tenant)).package_hash,f.input.checkpoint),null);
    const catalog=new BackupCatalog(directory,f.storage);await assert.rejects(catalog.prune(f.tenant),/pending/);assert.ok(f.objects.size>0);
    await directory.pool.query("UPDATE backup_parts SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",[f.tenant]);
    await catalog.prune(f.tenant);assert.equal(f.objects.size,0);
    await assert.rejects(f.transfer().upload(f.input),/revoked/);
  });
  await t.test('a new fence prevents a stale uploader from acknowledging or clearing the outstanding part',async()=>{
    const f=await fixture();f.afterPut(async()=>{await directory.pool.query('UPDATE migration_runs SET fence=fence+1 WHERE tenant_id=$1',[f.tenant]);});
    await assert.rejects(f.transfer().upload(f.input),/authorization changed/);
    const part=(await directory.pool.query('SELECT state,lease_until FROM backup_parts WHERE tenant_id=$1',[f.tenant])).rows[0];assert.equal(part.state,'uploading');assert.ok(new Date(part.lease_until).getTime()>Date.now());
    assert.equal((await record(f.tenant)).state,'uploading');
  });
  for(const cleanup of [false,true])await t.test(`dispatch rechecks the upload lease after source waits (${cleanup?'cleanup already admitted':'elapsed initial lease'})`,async()=>{
    const f=await fixture();let changed=false;
    f.source.frozen=async()=>{
      if(!changed&&(await directory.pool.query("SELECT 1 FROM backup_parts WHERE tenant_id=$1 AND state='uploading'",[f.tenant])).rowCount){
        changed=true;await directory.pool.query("UPDATE backup_parts SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",[f.tenant]);
        if(cleanup)await directory.pool.query("UPDATE backups SET state='deleting' WHERE tenant_id=$1",[f.tenant]);
      }
      return true;
    };
    f.beforePut(async name=>{const part=(await directory.pool.query('SELECT lease_until FROM backup_parts WHERE tenant_id=$1 AND name=$2',[f.tenant,name])).rows[0];assert.ok(new Date(part.lease_until).getTime()>Date.now()+120000);});
    if(cleanup){await assert.rejects(f.transfer().upload(f.input),/revoked before dispatch/);assert.equal(f.calls.length,0);}
    else{await f.transfer().upload(f.input);assert.ok(f.calls.length>0);}assert.equal(changed,true);
  });
  for(const mode of ['partial','changed','resumed'])await t.test(`${mode} source checkpoint prevents admission and invokes containment`,async()=>{
    const f=await fixture();if(mode==='partial')f.state.complete=false;if(mode==='changed')f.state.checkpoint='f'.repeat(64);if(mode==='resumed')f.state.frozen=false;
    await assert.rejects(f.transfer().upload(f.input),/complete frozen/);assert.equal(await record(f.tenant),undefined);assert.equal(f.calls.length,0);assert.equal(f.state.stops,1);
    const run=(await directory.pool.query('SELECT phase,writer FROM migration_runs WHERE tenant_id=$1',[f.tenant])).rows[0];assert.deepEqual(run,{phase:'reconciliation',writer:'none'});
  });
  await t.test('source resumption after the last uploaded part prevents a complete package',async()=>{
    const f=await fixture();f.afterPut(async()=>{f.state.frozen=false;});await assert.rejects(f.transfer().upload(f.input),/complete frozen/);
    assert.equal((await record(f.tenant)).state,'uploading');assert.equal(f.state.stops,1);assert.equal(await verifiedMigrationTransfer(directory,f.tenant,(await record(f.tenant)).package_hash,f.input.checkpoint),null);
  });
  await t.test('source containment is still attempted if directory metadata writes fail',async()=>{
    const f=await fixture(),transaction=directory.transaction.bind(directory);
    f.source.frozen=async()=>{directory.transaction=async()=>{throw new Error('Directory unavailable');};return false;};
    try{await assert.rejects(f.transfer().upload(f.input));assert.equal(f.state.stops,1);assert.equal(f.calls.length,0);}
    finally{directory.transaction=transaction;}
  });
  await t.test('authorization revoked during key retrieval leaves no plaintext or uploaded package',async()=>{
    const f=await fixture();f.beforeKey(async()=>{await directory.revokeTenant(f.tenant);});await assert.rejects(f.transfer().upload(f.input),/authorization changed/);
    assert.equal(fs.existsSync(path.join(f.input.workDirectory,'environment')),false);assert.equal(await record(f.tenant),undefined);assert.equal(f.calls.length,0);
  });
  await t.test('tampered encrypted bytes, missing journals and owner-swapped workspaces cannot replace an admitted package',async()=>{
    const f=await fixture();await f.transfer().upload(f.input);const bundle=path.join(f.input.workDirectory,'encrypted'),file=path.join(bundle,'0.bin'),original=fs.readFileSync(file);
    fs.writeFileSync(file,Buffer.from('changed'));await assert.rejects(f.transfer().upload(f.input),/part changed/);fs.writeFileSync(file,original);
    const journal=fs.readFileSync(path.join(f.input.workDirectory,'transfer.json'));fs.unlinkSync(path.join(f.input.workDirectory,'transfer.json'));
    await assert.rejects(f.transfer().upload(f.input),/missing locally/);fs.writeFileSync(path.join(f.input.workDirectory,'transfer.json'),journal);
    const other=await fixture();await assert.rejects(other.transfer().upload({...other.input,workDirectory:f.input.workDirectory}),/another export/);
    assert.equal((await record(f.tenant)).state,'complete');assert.equal(other.calls.length,0);
  });
  await t.test('unknown/private workspace contents and incomplete file inventory fail without deleting unrelated files',async()=>{
    const f=await fixture();fs.mkdirSync(f.input.workDirectory,{mode:0o700});fs.writeFileSync(path.join(f.input.workDirectory,'environment'),'unrelated');
    await assert.rejects(f.transfer().upload(f.input),/Unbound/);assert.equal(fs.readFileSync(path.join(f.input.workDirectory,'environment'),'utf8'),'unrelated');
    const other=await fixture(),missing={...other.input,filesRoot:undefined};missing.reviewedInventoryHash=(await inventoryLegacySource(missing)).inventoryHash;await assert.rejects(other.transfer().upload(missing),/inventory is incomplete/);assert.equal(other.calls.length,0);
  });
  await t.test('packaging-crash plaintext is removed only from its bound private workspace',async()=>{
    const f=await fixture();await f.transfer().upload(f.input);
    for(const name of ['environment','environment.preparing-0123456789abcdef','.snapshot-ABC123']){fs.mkdirSync(path.join(f.input.workDirectory,name));fs.writeFileSync(path.join(f.input.workDirectory,name,'private'),'left by crashed packager');}
    await f.transfer().upload(f.input);
    assert.deepEqual(fs.readdirSync(f.input.workDirectory).sort(),['binding.json','encrypted','transfer.json']);
  });
});
