import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { Directory } from '../server/src/platform/directory.js';
import { BackupCatalog,backupRoutes } from '../server/src/platform/backups.js';
import { backupLocation,type BackupStorage } from '../server/src/platform/backup-storage.js';
import { HostBackups } from '../server/src/runtime/backups.js';
import { restoreTenantEnvironment } from '../server/src/platform/recovery.js';
import { RuntimeIdentity } from '../server/src/platform/runtime-identity.js';
import { generateKeyPair,exportPKCS8,exportSPKI } from 'jose';

const url=process.env.TEST_DATABASE_URL;
test('durable encrypted backup scheduling, owner routing, retention and recovery',{skip:!url},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(target.href);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-backup-life-'));
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await directory.migrate();
  const tenant=await directory.identity('google','backup-a',{name:'A'}),other=await directory.identity('google','backup-b',{name:'B'});
  await directory.pool.query("UPDATE tenants SET state='active',machine_id=id",[]);
  const owner={tenant,generation:'1'},foreign={tenant:other,generation:'1'},master=randomBytes(32),objects=new Map<string,Buffer>();
  let failPut=false,failRemove=false,puts=0,quiesces=0,resumes=0,time=Date.now();
  const storage:BackupStorage={
    async put(who,id,name,body,bytes,sha256){
      puts++;if(failPut)throw new Error('storage temporarily unavailable');
      const chunks:Buffer[]=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));const data=Buffer.concat(chunks);
      assert.equal(data.length,bytes);assert.equal(createHash('sha256').update(data).digest('hex'),sha256);objects.set(backupLocation(who,id,name),data);
    },
    async get(who,id,name){const b=objects.get(backupLocation(who,id,name));if(!b)throw new Error('not found');return {body:Readable.from([b]),bytes:b.length};},
    async remove(who,id){if(failRemove)throw new Error('delete failed');const prefix=backupLocation(who,id);for(const key of objects.keys())if(key.startsWith(prefix))objects.delete(key);},
  };
  const catalog=new BackupCatalog(directory,storage),data=path.join(root,'data');fs.mkdirSync(path.join(data,'app'),{recursive:true});fs.mkdirSync(path.join(data,'files'),{recursive:true});
  fs.writeFileSync(path.join(data,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:'volume_a'}));fs.writeFileSync(path.join(data,'files','private.txt'),'Private A');
  const db=new Database(path.join(data,'app/swarm.db'));db.exec('CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);CREATE TABLE notes(body TEXT);CREATE TABLE auth_sessions(token TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO users VALUES(?)').run(tenant);db.prepare('INSERT INTO tenant_identity VALUES(1,?)').run(tenant);db.exec("INSERT INTO notes VALUES('first');INSERT INTO auth_sessions VALUES('stale-session')");db.close();
  const transport={begin:async(p:any)=>catalog.begin(owner,{id:p.id,scope:p.scope,parts:p.parts.length,bytes:p.parts.reduce((n:number,f:any)=>n+f.bytes,0)}),put:async(p:any,f:any)=>catalog.put(owner,p.id,f.name,fs.createReadStream(path.join(p.directory,f.name)),f.bytes,f.sha256),complete:async(p:any)=>catalog.complete(owner,p.id)};
  const make=()=>new HostBackups(data,tenant,()=>Buffer.from(master),transport,async()=>{quiesces++;return async()=>{resumes++;};},()=>time);
  let host=make();
  await t.test('restart removes abandoned snapshots without following symlinks',async()=>{
    const abandoned=path.join(data,'host-backups',randomBytes(16).toString('hex'));
    fs.mkdirSync(abandoned);fs.writeFileSync(path.join(abandoned,'0.bin'),'orphan');
    host=make();assert.equal(fs.existsSync(abandoned),false);
    const external=path.join(root,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'private'),'preserve');
    fs.symlinkSync(external,abandoned);assert.throws(make,/Unsafe backup/);assert.equal(fs.readFileSync(path.join(external,'private'),'utf8'),'preserve');fs.unlinkSync(abandoned);
  });
  await t.test('failed upload retains its encrypted bundle across host restart',async()=>{
    failPut=true;await host.tick();assert.equal(host.status().error,'backup_requires_retry');assert.ok(host.status().pending);assert.equal(host.status().lastDatabase,undefined);assert.equal(quiesces,resumes);
    const pending=host.status().pending;host=make();assert.equal(host.status().pending,pending);failPut=false;
    await host.tick();assert.equal(host.status().pending,pending,'an outstanding storage outcome retains its lease');
    await directory.pool.query("UPDATE backup_parts SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",[tenant]);
    await host.tick();assert.equal(host.status().pending,undefined);assert.equal(host.status().lastDatabase,time);assert.equal(quiesces,1);
    for(const object of objects.values())assert.equal(object.includes(Buffer.from('Private A')),false);
  });
  const full=(await directory.pool.query("SELECT id FROM backups WHERE tenant_id=$1 AND scope='environment'",[tenant])).rows[0].id;
  await t.test('the four-minute schedule skips early ticks and resumes with a database-only snapshot',async()=>{
    const before=puts;await host.tick();assert.equal(puts,before);
    time+=240000;const changed=new Database(path.join(data,'app/swarm.db'));changed.exec("UPDATE notes SET body='second'");changed.close();await host.tick();
    assert.equal(quiesces,1,'database backup leaves running workloads alone');assert.equal((await directory.pool.query("SELECT count(*) n FROM backups WHERE tenant_id=$1 AND scope='database'",[tenant])).rows[0].n,'1');
  });
  const database=(await directory.pool.query("SELECT id FROM backups WHERE tenant_id=$1 AND scope='database'",[tenant])).rows[0].id;
  await t.test('foreign backup IDs, malformed prefixes, missing parts and altered parts fail',async()=>{
    await assert.rejects(catalog.complete(foreign,full));assert.throws(()=>backupLocation(tenant,full,'../manifest.bin'));
    const id=randomBytes(16).toString('hex');await catalog.begin(owner,{id,scope:'database',parts:2,bytes:2});await assert.rejects(catalog.complete(owner,id));
    await catalog.put(owner,id,'0.bin',Readable.from(['x']),1,createHash('sha256').update('x').digest('hex'));
    await assert.rejects(catalog.put(owner,id,'0.bin',Readable.from(['y']),1,createHash('sha256').update('y').digest('hex')));
    const rejected=Readable.from(['secret']);await assert.rejects(catalog.put(foreign,id,'0.bin',rejected,6,'0'.repeat(64)));assert.equal(rejected.destroyed,true);
    const invalid=Readable.from(['secret']);await assert.rejects(catalog.put(owner,id,'../escape',invalid,6,'0'.repeat(64)));assert.equal(invalid.destroyed,true);
  });
  await t.test('workload JWTs cannot use host backup routes',async()=>{
    const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
    process.env.SESSION_SECRET='backup-test-request-boundary-secret-123456';
    const {requestBoundary}=await import('../server/src/security/request.js');
    const app=new Hono();app.use('*',requestBoundary);app.route('/internal/host/backups',backupRoutes(catalog,identity));
    const claims={sub:tenant,machine:tenant,generation:'1'};
    const userToken=await identity.sign(claims,'swarm-runtime'),hostToken=await identity.sign(claims,'swarm-host');
    assert.equal((await app.request('/internal/host/backups',{headers:{authorization:`Bearer ${userToken}`}})).status,401);
    assert.equal((await app.request('/internal/host/backups',{headers:{authorization:`Bearer ${hostToken}`}})).status,200);
    const id=randomBytes(16).toString('hex');await catalog.begin(owner,{id,scope:'database',parts:2,bytes:2});
    const put=(token:string)=>app.request(`/internal/host/backups/${id}/0.bin`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','content-length':'1','x-backup-sha256':createHash('sha256').update('x').digest('hex')},body:'x'});
    assert.equal((await put(userToken)).status,401);assert.equal((await put(hostToken)).status,200);
    const empty=randomBytes(16).toString('hex');await catalog.begin(owner,{id:empty,scope:'environment',parts:2,bytes:100});
    const emptyPart=await app.request(`/internal/host/backups/${empty}/0.bin`,{method:'PUT',headers:{authorization:`Bearer ${hostToken}`,'content-type':'application/octet-stream','content-length':'0','x-backup-sha256':createHash('sha256').update('').digest('hex')}});
    assert.equal(emptyPart.status,200);assert.equal(objects.get(backupLocation(tenant,empty,'0.bin'))?.length,0);
    assert.equal((await app.request('/api/ordinary',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'x'})).status,415);
  });
  await t.test('KMS failure removes temporary recovery state and publishes nothing',async()=>{
    const destination=path.join(root,'key-failure');
    await assert.rejects(restoreTenantEnvironment(directory,{key:async()=>{throw new Error('KMS unavailable');}} as any,storage,{tenant,fullBackup:full,destination,volume:'new_volume'}),/KMS unavailable/);
    assert.equal(fs.existsSync(destination),false);assert.equal(fs.readdirSync(root).some(n=>n.startsWith('.swarm-recovery-')),false);
  });
  await t.test('backup health exposes lag and retry state without private contents',async()=>{
    await catalog.report(owner,{lastDatabase:Date.now()-360000,lastEnvironment:Date.now()-25*3600000,error:'backup_requires_retry'});
    const health=(await catalog.health()).find(r=>r.tenant===tenant)!;
    assert.equal(health.database_overdue,true);assert.equal(health.environment_overdue,true);assert.equal(health.error_code,'backup_requires_retry');
    await assert.rejects(catalog.report({...owner,generation:'99'},{lastDatabase:Date.now()}));
    await assert.rejects(catalog.report(owner,{lastDatabase:Date.now()+1000000}));
    await catalog.report(owner,{lastDatabase:Date.now(),lastEnvironment:Date.now()});
    assert.equal((await catalog.health()).find(r=>r.tenant===tenant)!.database_overdue,false);
  });
  await t.test('recovery combines the latest database with private files into a new unpublished volume',async()=>{
    const envelopes={key:async(who:string)=>{if(who!==tenant)throw new Error('foreign key');return Buffer.from(master);}};
    await assert.rejects(restoreTenantEnvironment(directory,envelopes as any,storage,{tenant:other,fullBackup:full,destination:path.join(root,'foreign'),volume:'other_volume'}));
    const destination=path.join(root,'restored'),receipt=await restoreTenantEnvironment(directory,envelopes as any,storage,{tenant,fullBackup:full,databaseBackup:database,destination,volume:'new_volume'});
    assert.equal(receipt.routingChanged,false);assert.equal(fs.readFileSync(path.join(destination,'files/private.txt'),'utf8'),'Private A');
    const restored=new Database(path.join(destination,'app/swarm.db'));assert.equal(restored.prepare('SELECT body FROM notes').get().body,'second');assert.equal(restored.prepare('SELECT count(*) n FROM auth_sessions').get().n,0);restored.close();
    await assert.rejects(restoreTenantEnvironment(directory,envelopes as any,storage,{tenant,fullBackup:full,destination,volume:'new_volume'}),/new absolute/);
  });
  await t.test('retention cleanup failures remain retryable and never delete foreign objects',async()=>{
    const sentinel=backupLocation(other,full,'manifest.bin');objects.set(sentinel,Buffer.from('foreign'));
    await directory.pool.query("UPDATE backups SET expires_at=now()-interval '1 minute' WHERE tenant_id=$1",[tenant]);failRemove=true;
    await assert.rejects(catalog.prune());assert.ok((await directory.pool.query("SELECT 1 FROM backups WHERE tenant_id=$1 AND error_code='storage_cleanup_requires_retry'",[tenant])).rowCount);
    failRemove=false;await catalog.prune();assert.equal((await directory.pool.query("SELECT 1 FROM backups WHERE tenant_id=$1 AND state!='deleted'",[tenant])).rowCount,0);assert.equal(objects.get(sentinel)?.toString(),'foreign');
  });
  master.fill(0);
});
