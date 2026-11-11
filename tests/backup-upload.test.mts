import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import {Directory,opaqueToken} from '../server/src/platform/directory.js';
import {BackupCatalog} from '../server/src/platform/backups.js';
import type {BackupStorage} from '../server/src/platform/backup-storage.js';

const url=process.env.TEST_DATABASE_URL,sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function latch(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
test('backup upload dispatch, acknowledgement and cleanup have exclusive leases',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(target.href);await directory.migrate();
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  async function fixture(){
    const tenant=await directory.identity('google',opaqueToken(),{name:'Backup'}),id=randomBytes(16).toString('hex');
    await directory.pool.query("UPDATE tenants SET state='active' WHERE id=$1",[tenant]);
    let puts=0,removes=0,after:((attempt:number)=>Promise<void>)|undefined;
    const storage:BackupStorage={
      async put(_tenant,_id,_name,body){const attempt=++puts;for await(const _chunk of body){}await after?.(attempt);},
      async get(){throw new Error('not used');},async remove(){removes++;},
    };
    const owner={tenant,generation:'1'},catalog=new BackupCatalog(directory,storage);await catalog.begin(owner,{id,scope:'database',parts:2,bytes:2});
    return {tenant,id,owner,catalog,storage,put:()=>catalog.put(owner,id,'0.bin',Readable.from(['x']),1,sha('x')),after:(fn:typeof after)=>{after=fn;},puts:()=>puts,removes:()=>removes};
  }
  const part=async(f:{tenant:string;id:string})=>(await directory.pool.query("SELECT * FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND name='0.bin'",[f.tenant,f.id])).rows[0];
  const expire=async(f:{tenant:string;id:string})=>directory.pool.query("UPDATE backup_parts SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND backup_id=$2",[f.tenant,f.id]);
  await t.test('lost acknowledgement preserves outstanding ownership and prevents early cleanup',async()=>{
    const f=await fixture();f.after(async()=>{throw new Error('response lost');});await assert.rejects(f.put(),/response lost/);
    const first=await part(f);assert.equal(first.state,'uploading');assert.ok(first.upload_owner);assert.ok(new Date(first.lease_until).getTime()>Date.now());
    await assert.rejects(f.put(),/already running/);assert.equal(f.puts(),1);
    await directory.revokeTenant(f.tenant);await assert.rejects(f.catalog.prune(f.tenant),/cleanup is pending/);assert.equal(f.removes(),0);
    await expire(f);await f.catalog.prune(f.tenant);assert.equal(f.removes(),1);
  });
  for(const stale of ['failure','success'])await t.test(`a stale ${stale} cannot change its successor's active lease`,async()=>{
    const f=await fixture(),first=latch(),second=latch(),releaseFirst=latch(),releaseSecond=latch();
    f.after(async attempt=>{if(attempt===1){first.resolve();await releaseFirst.promise;if(stale==='failure')throw new Error('old failure');}else{second.resolve();await releaseSecond.promise;}});
    const old=assert.rejects(f.put(),stale==='failure'?/old failure/:/authorization changed/);await first.promise;
    const original=await part(f);await expire(f);const next=f.put();await second.promise;
    const successor=await part(f);assert.notEqual(successor.upload_owner,original.upload_owner);
    releaseFirst.resolve();await old;
    const current=await part(f);assert.equal(current.state,'uploading');assert.equal(current.upload_owner,successor.upload_owner);assert.deepEqual(current.lease_until,successor.lease_until);
    releaseSecond.resolve();await next;assert.equal((await part(f)).state,'ready');
  });
  await t.test('a late failure cannot downgrade an already acknowledged replacement',async()=>{
    const f=await fixture(),entered=latch(),release=latch();f.after(async attempt=>{if(attempt===1){entered.resolve();await release.promise;throw new Error('old failure');}});
    const old=assert.rejects(f.put(),/old failure/);await entered.promise;await expire(f);await f.put();release.resolve();await old;
    assert.equal((await part(f)).state,'ready');assert.equal((await part(f)).upload_owner,null);
  });
  await t.test('revocation before storage acknowledgement prevents publication',async()=>{
    const f=await fixture();f.after(()=>directory.revokeTenant(f.tenant));await assert.rejects(f.put(),/authorization changed/);
    assert.equal((await part(f)).state,'uploading');await assert.rejects(f.catalog.complete(f.owner,f.id));
    await assert.rejects(f.catalog.prune(f.tenant),/cleanup is pending/);assert.equal(f.removes(),0);
  });
  await t.test('expired upload ownership cannot be renewed by its late acknowledgement',async()=>{
    const f=await fixture();f.after(async()=>{await expire(f);});await assert.rejects(f.put(),/authorization changed/);assert.equal((await part(f)).state,'uploading');
  });
  await t.test('storage acknowledgement without consuming the stream is rejected',async()=>{
    const f=await fixture(),catalog=new BackupCatalog(directory,{...f.storage,put:async()=>{}}),body=Readable.from(['x']);
    await assert.rejects(catalog.put(f.owner,f.id,'0.bin',body,1,sha('x')),/complete backup part/);assert.equal(body.destroyed,true);assert.equal((await part(f)).state,'uploading');
  });
  for(const data of ['','xx','y'])await t.test(`invalid stream ${JSON.stringify(data)} cannot publish its declared part`,async()=>{
    const f=await fixture(),body=Readable.from([data]);await assert.rejects(f.catalog.put(f.owner,f.id,'0.bin',body,1,sha('x')),/integrity|exceeded/);
    assert.equal(body.destroyed,true);assert.equal((await part(f)).state,'uploading');
  });
  await t.test('revocation during admission lock wait blocks storage dispatch',async()=>{
    const f=await fixture(),acquired=latch(),release=latch();
    const held=directory.transaction(async client=>{await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);acquired.resolve();await release.promise;await client.query("UPDATE tenants SET state='deleting',generation=generation+1 WHERE id=$1",[f.tenant]);});
    await acquired.promise;const denied=assert.rejects(f.put(),/Backup unavailable/);setTimeout(release.resolve,40);await Promise.all([held,denied]);assert.equal(f.puts(),0);
  });
  await t.test('retention admitted during upload blocks publication and waits for the writer',async()=>{
    const f=await fixture();f.after(async()=>{await assert.rejects(f.catalog.prune(f.tenant),/cleanup is pending/);});
    await assert.rejects(f.put(),/authorization changed/);assert.equal(f.removes(),0);await expire(f);await f.catalog.prune(f.tenant);assert.equal(f.removes(),1);
  });
});
