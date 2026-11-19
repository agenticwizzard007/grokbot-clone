import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {Hono} from 'hono';
import {generateKeyPair,exportPKCS8,exportSPKI,decodeJwt} from 'jose';
import {HostUsageCollector,cpuCounters,memoryPressure,volumeUsedBytes,filesystemUsage,validateFilesystems,readHostUsage,intervalUsage,hostUsageTransport,usageCollectionEnabled,type UsageSnapshot,type HostUsageReport,type HostFilesystems} from '../server/src/runtime/host-usage.js';
import {HostUsage,hostUsageRoutes,exportHostUsage,exportHostPressure,pruneHostUsage} from '../server/src/platform/host-usage.js';
import {Directory} from '../server/src/platform/directory.js';
import {RuntimeIdentity} from '../server/src/platform/runtime-identity.js';
import {HostControl,hostControlRoutes,setHostIntent} from '../server/src/platform/host-control.js';
import {capacityCommand} from '../server/src/platform/capacity-cli.js';
import {recommendCapacity,setCapacityPolicy,type CapacityPolicy} from '../server/src/platform/tenant-capacity.js';
import {FlyTenants} from '../server/src/platform/fly-tenants.js';

import {planEnvironmentOperation,queueEnvironmentOperation} from '../server/src/platform/environment-operations.js';
import {infrastructureGates} from '../server/src/platform/release-policy.js';

const filesystems=(usedBytes=2*1024**3):HostFilesystems=>({
  root:{totalBytes:30*1024**3,availableBytes:1024,totalInodes:10000,freeInodes:1},
  data:{totalBytes:10*1024**3,availableBytes:10*1024**3-usedBytes,totalInodes:100000,freeInodes:90000},
});
const snapshot=(at:number):UsageSnapshot=>({at,monotonic:at,cpu:[at,0,0,at,0,0,0,0],memory:.5,usedBytes:1024,filesystems:filesystems(1024)});
const report=():HostUsageReport=>({version:1,volume:'vol_a',stream:randomUUID(),sequence:1,at:Date.now()-100,intervalMs:30000,cpu:.9,memory:.5,usedBytes:2*1024**3});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('whole-VM measurements exclude guest double counting and account for reserved disk blocks',()=>{
  assert.deepEqual(cpuCounters('cpu 100 2 3 400 5 6 7 8 99 1\ncpu0 1 2'),[100,2,3,400,5,6,7,8]);
  assert.equal(memoryPressure('MemTotal: 10000 kB\nMemFree: 1 kB\nMemAvailable: 3000 kB\n'),.7);
  assert.equal(volumeUsedBytes({blocks:100,bfree:40,bavail:30,bsize:4096}),70*4096);
  assert.deepEqual(intervalUsage(snapshot(1000),snapshot(31000)),{intervalMs:30000,cpu:.5});
  for(const text of ['', 'cpu 1 2','cpu 1 2 3 4 5 6 7 nan','cpu 1 2 3 4 5 6 7 999999999999999999'])assert.throws(()=>cpuCounters(text));
  for(const text of ['MemTotal: 0 kB\nMemAvailable: 0 kB','MemTotal: 1 kB\nMemAvailable: 2 kB','MemTotal: 2 kB\nMemAvailable: 1 kB\nMemAvailable: 1 kB'])assert.throws(()=>memoryPressure(text));
  assert.throws(()=>volumeUsedBytes({blocks:100,bfree:40,bavail:50,bsize:4096}));
  for(const current of [snapshot(1001),snapshot(62000),{...snapshot(31000),monotonic:35000},{...snapshot(31000),cpu:[0,0,0,0,0,0,0,0]}])assert.throws(()=>intervalUsage(snapshot(1000),current));
});

test('filesystem counters preserve actual zero free inodes and distinguish unsupported accounting',()=>{
  const disk={blocks:100,bfree:40,bavail:30,bsize:4096,files:1000,ffree:0};
  assert.deepEqual(filesystemUsage(disk),{totalBytes:409600,availableBytes:122880,totalInodes:1000,freeInodes:0});
  assert.deepEqual(filesystemUsage({...disk,files:0}),{totalBytes:409600,availableBytes:122880,totalInodes:null,freeInodes:null});
  for(const changed of [{files:0,ffree:1},{ffree:-1},{ffree:1001},{files:1.5},{blocks:Number.MAX_SAFE_INTEGER},{bavail:41}])assert.throws(()=>filesystemUsage({...disk,...changed}));
  const absent=filesystems();absent.root.totalInodes=null;absent.root.freeInodes=null;validateFilesystems(absent);
  for(const changed of [{freeInodes:null},{totalInodes:0},{availableBytes:31*1024**3},{totalInodes:'10000'},{path:'/host'}])assert.throws(()=>validateFilesystems({...filesystems(),root:{...filesystems().root,...changed}}));
});

test('production reader measures fixed root/data paths and refuses unsupported Docker mount layouts',async()=>{
  let dataDev=2,dockerDev=1,symlink=false,failRoot=false;
  const calls:string[]=[],rootDisk={blocks:100,bfree:1,bavail:0,bsize:4096,files:1000,ffree:0};
  const dataDisk={blocks:200,bfree:100,bavail:80,bsize:4096,files:2000,ffree:1500};
  const io={
    async readFile(file:string){calls.push(file);if(file==='/proc/stat')return 'cpu 10 0 0 10 0 0 0 0';assert.equal(file,'/proc/meminfo');return 'MemTotal: 1000 kB\nMemAvailable: 500 kB';},
    async lstat(file:string){calls.push(file);assert.ok(['/data','/var/lib/docker'].includes(file));return {dev:file==='/data'?dataDev:dockerDev,isDirectory:()=>true,isSymbolicLink:()=>symlink};},
    async stat(file:string){calls.push(file);assert.equal(file,'/');return {dev:1};},
    async statfs(file:string){calls.push(file);assert.ok(['/','/data'].includes(file));if(failRoot&&file==='/')throw Error('unavailable');return file==='/'?rootDisk:dataDisk;},
  };
  const sample=await readHostUsage(io);
  assert.deepEqual(sample.filesystems,{root:filesystemUsage(rootDisk),data:filesystemUsage(dataDisk)});
  assert.equal(sample.usedBytes,120*4096);assert.equal(sample.filesystems.root.freeInodes,0);assert.equal(sample.filesystems.root.availableBytes,0);
  assert.deepEqual(calls.sort(),['/proc/stat','/proc/meminfo','/data','/','/var/lib/docker','/data','/'].sort());
  dataDev=1;await assert.rejects(readHostUsage(io),/mounted tenant volume/);dataDev=2;
  dockerDev=3;await assert.rejects(readHostUsage(io),/Docker data/);dockerDev=1;
  symlink=true;await assert.rejects(readHostUsage(io));symlink=false;
  failRoot=true;await assert.rejects(readHostUsage(io),/unavailable/);
});

test('collector serializes ticks and discards windows across epoch changes, pauses and failures',async()=>{
  let epoch:number|undefined=1,at=1000,fail=false;
  const sent:HostUsageReport[]=[];
  const collector=new HostUsageCollector('vol_a',()=>epoch,async v=>{if(fail)throw Error('lost acknowledgement');sent.push(v);},async()=>snapshot(at));
  await collector.tick();at+=30000;await collector.tick();at+=30000;await collector.tick();
  assert.deepEqual(sent.map(s=>s.sequence),[1,2]);assert.equal(sent[0].stream,sent[1].stream);
  assert.equal(sent[0].version,2);assert.deepEqual(sent[0].version===2&&sent[0].filesystems,filesystems(1024));
  epoch=undefined;at+=30000;await collector.tick();epoch=2;at+=30000;await collector.tick();at+=30000;await collector.tick();
  assert.equal(sent[2].sequence,1);assert.notEqual(sent[2].stream,sent[0].stream);
  fail=true;at+=30000;await assert.rejects(collector.tick());fail=false;at+=30000;await collector.tick();at+=30000;await collector.tick();
  assert.equal(sent[3].sequence,1);assert.notEqual(sent[3].stream,sent[2].stream);
  const gate=deferred();let reads=0;
  const blocked=new HostUsageCollector('vol_a',()=>epoch,async()=>assert.fail('No complete interval.'),async()=>{reads++;await gate.promise;return snapshot(at);});
  const pending=blocked.tick();await blocked.tick();assert.equal(reads,1);epoch=3;gate.resolve();await pending;
  await blocked.tick();assert.equal(reads,2);
});

test('usage transport uses only the host credential, requires TLS, rejects redirects and discards response bodies',async()=>{
  let token='first',calls=0,cancelled=0;
  const send=hostUsageTransport('https://platform.example','/run/swarm-host/host-token',async(url,init)=>{
    calls++;assert.equal(String(url),'https://platform.example/internal/host/usage');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string,string>).authorization,`Bearer ${token}`);
    assert.deepEqual(JSON.parse(String(init?.body)),input);
    // A refused response may stall forever; cancellation must not hold up the collector.
    if(calls===2)return new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{status:503});
    return new Response(null,{status:204});
  },async()=>token);
  const input=report();await send(input);token='rotated';await assert.rejects(send(input));assert.equal(calls,2);assert.equal(cancelled,1);
  for(const origin of ['http://platform.example','https://user:secret@platform.example'])assert.throws(()=>hostUsageTransport(origin,'/run/swarm-host/host-token'));
  assert.throws(()=>hostUsageTransport('https://platform.example','/run/swarm/runtime-token'));
  assert.equal(usageCollectionEnabled(undefined),false);assert.equal(usageCollectionEnabled('0'),false);assert.equal(usageCollectionEnabled('1'),true);assert.throws(()=>usageCollectionEnabled('yes'));
});

test('provisioning opt-in reaches only the host; default sizing and workload env are unchanged',async()=>{
  const previous=process.env.TENANT_USAGE_COLLECTION;
  try{
    for(const setting of [undefined,'0','1']){
      if(setting===undefined)delete process.env.TENANT_USAGE_COLLECTION;else process.env.TENANT_USAGE_COLLECTION=setting;
      const fly=new FlyTenants('fixture','fixture');let created:any;
      fly.request=async(method,_route,body)=>method==='GET'?[]:(created={id:'machine',config:(body as any).config,state:'created'});
      await fly.ensureMachine(fly.name('usr_testusage'), 'usr_testusage','vol_a',`registry.test/host@sha256:${'a'.repeat(64)}`,'iad','1');
      assert.equal(created.config.env.TENANT_USAGE_COLLECTION,setting==='1'?'1':undefined);
      assert.deepEqual(created.config.guest,{cpu_kind:'shared',cpus:2,memory_mb:4096});
    }
  }finally{if(previous===undefined)delete process.env.TENANT_USAGE_COLLECTION;else process.env.TENANT_USAGE_COLLECTION=previous;}
});

test('authenticated, bounded host usage collection with real PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema=`test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(url.href);await directory.migrate();await directory.migrate();
  const keys=await generateKeyPair('EdDSA',{extractable:true}),identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
  const usage=new HostUsage(directory,identity),app=hostUsageRoutes(usage,identity,true),control=new HostControl(directory);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-usage-'));
  Object.assign(process.env,{SESSION_SECRET:'collector-test-only',DB_PATH:path.join(root,'app.db'),FILES_DIR:path.join(root,'files'),COMPUTER_PROVIDER:'local',SWARM_NO_SCHEDULER:'1',COMPOSIO_API_KEY:''});
  const {platformRequestMiddleware}=await import('../server/src/platform/server.js');
  const stack=(enabled:boolean)=>{const h=new Hono();platformRequestMiddleware(h);h.route('/internal/host/usage',hostUsageRoutes(usage,identity,enabled));return h;};
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  async function fixture(){
    const tenant=await directory.identity('google',randomUUID(),{name:'Usage fixture'}),machine=`machine_${randomBytes(4).toString('hex')}`,volume=`vol_${randomBytes(4).toString('hex')}`;
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=$2,volume_id=$3 WHERE id=$1",[tenant,machine,volume]);
    const owner={tenant,machine,generation:'1'};
    await directory.transaction(c=>setHostIntent(c,owner,'run'));await control.report(owner,{revision:'1',state:'running'});
    const sign=(audience='swarm-host',lifetime='5m')=>identity.sign({sub:tenant,machine,generation:'1'},audience,lifetime);
    // Model an already-running host; no production clock/admission override.
    await directory.pool.query("UPDATE host_policies SET usage_not_before=clock_timestamp()-interval '2 hours' WHERE tenant_id=$1",[tenant]);
    const token=await sign(),input={...report(),volume};
    const post=(body:unknown=input,bearer=token)=>app.request('/',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(body)});
    const rows=async()=>(await directory.pool.query('SELECT * FROM host_usage_samples WHERE tenant_id=$1 ORDER BY at',[tenant])).rows;
    return {tenant,machine,volume,owner,sign,token,input,post,rows};
  }
  // Historical fixtures move committed timestamps and receipt times together. No
  // fake clock or alternate admission path is used by production code.
  async function ageWindow(tenant:string){
    // Move through unused negative keys within a transaction so PostgreSQL's
    // immediate uniqueness checks cannot depend on the heap's update order.
    await directory.transaction(async c=>{
      await c.query('UPDATE host_usage_samples SET at=-at WHERE tenant_id=$1',[tenant]);
      await c.query("UPDATE host_usage_samples SET at=-at-30000,received_at=received_at-interval '30 seconds' WHERE tenant_id=$1",[tenant]);
    });
  }
  async function historicalWindow(f:Awaited<ReturnType<typeof fixture>>,count=5,input:HostUsageReport=f.input){
    input.at=Date.now()-100;
    await directory.pool.query("UPDATE host_policies SET usage_not_before=clock_timestamp()-interval '2 hours' WHERE tenant_id=$1",[f.tenant]);
    await usage.accept(f.token,input);
    for(let n=1;n<count;n++){
      await ageWindow(f.tenant);
      await usage.accept(f.token,{...input,sequence:n+1});
    }
  }
  async function waitBlocked(pid:number){
    for(let i=0;i<400;i++){
      if((await directory.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount)return;
      await delay(5);
    }
    assert.fail('The expected real PostgreSQL lock wait was not observed.');
  }

  await t.test('audience, current owner, volume, exact fields and global opt-in are enforced',async()=>{
    const f=await fixture(),other=await fixture();
    assert.equal((await f.post(undefined,await f.sign('swarm-runtime'))).status,401);
    assert.equal((await f.post(undefined,other.token)).status,409);
    for(const body of [{...f.input,tenant:other.tenant},{...f.input,volume:other.volume},{...f.input,cpu:'1'},{...f.input,memory:2},{...f.input,usedBytes:-1},{...f.input,sequence:0},{...f.input,intervalMs:60001},{...f.input,at:Date.now()+60000},{...f.input,at:Date.now()-16000}])assert.equal((await f.post(body)).status,409);
    assert.equal((await hostUsageRoutes(usage,identity,false).request('/',{method:'POST'})).status,404);
    assert.equal((await f.post()).status,204);assert.equal((await f.rows()).length,1);
    const row=(await f.rows())[0];assert.equal(row.tenant_id,f.tenant);assert.equal(row.machine_id,f.machine);assert.equal(row.volume_id,f.volume);assert.equal(row.generation,'1');
    assert.equal((await other.rows()).length,0);
    assert.equal((await directory.pool.query("SELECT 1 FROM environment_operations WHERE tenant_id=$1",[f.tenant])).rowCount,0);
  });
  await t.test('version two reports strictly validate nested filesystem counters, preserve legacy absence and re-run migrations safely',async()=>{
    const f=await fixture(),v2={...f.input,version:2 as const,filesystems:filesystems()};
    const invalid=[{...v2,version:3},{...v2,filesystems:undefined},{...v2,version:1},
      {...v2,usedBytes:1},{...v2,filesystems:{...v2.filesystems,extra:1}},
      ...[{freeInodes:-1},{freeInodes:10001},{totalInodes:null},{availableBytes:31*1024**3},{totalBytes:'1000'},{device:'/dev/vda'}].map(root=>({...v2,filesystems:{...v2.filesystems,root:{...v2.filesystems.root,...root}}}))];
    for(const input of invalid)assert.equal((await f.post(input)).status,409);
    assert.equal((await f.rows()).length,0);
    assert.ok(Buffer.byteLength(JSON.stringify(v2))<2048);assert.equal((await f.post(v2)).status,204);
    assert.deepEqual((await f.rows())[0].filesystems,v2.filesystems);
    const legacy=await fixture();assert.equal((await legacy.post()).status,204);assert.equal((await legacy.rows())[0].filesystems,null);
    await directory.migrate();await directory.migrate();
    assert.deepEqual((await f.rows())[0].filesystems,v2.filesystems);assert.equal((await legacy.rows())[0].filesystems,null);
  });
  await t.test('old-schema rows upgrade to explicitly unknown filesystem data without losing the usage window',async()=>{
    // Exercise the actual migration from PR55's table shape in a disposable schema.
    const before=await fixture();await historicalWindow(before);
    await directory.pool.query('ALTER TABLE host_usage_samples DROP COLUMN filesystems');
    await directory.migrate();
    assert.equal((await before.rows()).length,5);assert.ok((await before.rows()).every(r=>r.filesystems===null));
    assert.equal((await exportHostUsage(directory,before.tenant)).length,5);
    await assert.rejects(exportHostPressure(directory,before.tenant),/unavailable/);
  });
  await t.test('actual body read is bounded and rechecks identity after awaiting the body',async()=>{
    const f=await fixture(),entered=deferred(),verify=identity.verify.bind(identity);
    identity.verify=async(...args)=>{const value=await verify(...args);entered.resolve();return value;};
    let release!:(value:unknown)=>void;
    const stream=new ReadableStream<Uint8Array>({start(c){release=value=>{c.enqueue(Buffer.from(JSON.stringify(value)));c.close();};}});
    const pending=app.request('/',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:stream,duplex:'half'} as any);
    try{await entered.promise;await directory.pool.query('UPDATE tenants SET generation=2 WHERE id=$1',[f.tenant]);release(f.input);assert.equal((await pending).status,409);assert.equal((await f.rows()).length,0);}
    finally{identity.verify=verify;}
    const g=await fixture();assert.equal((await g.post('x'.repeat(3000))).status,400);
    let cancelled=false;
    const stalled=new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise(()=>{});}}),start=performance.now();
    const response=await app.request('/',{method:'POST',headers:{authorization:`Bearer ${g.token}`,'content-type':'application/json'},body:stalled,duplex:'half'} as any);
    assert.equal(response.status,400);assert.ok(cancelled);assert.ok(performance.now()-start>=1900&&performance.now()-start<5000);assert.equal((await g.rows()).length,0);
  });
  await t.test('production middleware rejects disabled/unauthorized chunked usage before consuming the body',async()=>{
    for(const enabled of [false,true]){
      let release!:()=>void;
      const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{'));release=()=>c.close();}});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const result=await Promise.race([stack(enabled).request('/internal/host/usage',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'} as any),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('outer middleware buffered the unclosed stream')),500);})]);
        assert.equal(result.status,enabled?401:404);
      }finally{clearTimeout(timer);release();}
    }
    const f=await fixture();assert.equal((await stack(true).request('/internal/host/usage',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:'x'.repeat(2049)})).status,400);
    assert.equal((await stack(true).request('/ordinary',{method:'POST',headers:{'content-length':String(11*1024**2)},body:'x'})).status,413);
  });
  await t.test('readiness held/error reports expiring during a correlated policy lock wait change nothing',async()=>{
    const route=hostControlRoutes(control,identity);
    for(const state of ['held','running'] as const){
      const f=await fixture();await historicalWindow(f);
      const prior=(await directory.pool.query('SELECT * FROM host_policies WHERE tenant_id=$1',[f.tenant])).rows[0],samples=await f.rows();
      const lock=await directory.pool.connect();let pending:Promise<Response>|undefined;
      try{
        await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT tenant_id FROM host_policies WHERE tenant_id=$1 FOR UPDATE',[f.tenant]);
        const token=await f.sign('swarm-host','2s');
        pending=route.request('/state',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({revision:'1',state,...(state==='running'?{error:'host_requires_reconciliation'}:{})})});
        await waitBlocked(pid);await delay(Math.max(0,decodeJwt(token).exp!*1000-Date.now()+50));
        assert.ok(Date.now()>=decodeJwt(token).exp!*1000);
        await lock.query('COMMIT');assert.equal((await pending).status,409);
        assert.deepEqual((await directory.pool.query('SELECT * FROM host_policies WHERE tenant_id=$1',[f.tenant])).rows[0],prior);assert.deepEqual(await f.rows(),samples);
      }finally{await lock.query('ROLLBACK');lock.release();await pending;}
    }
  });
  await t.test('hold/resume at the same revision rejects delayed pre-hold intervals and accepts fresh ones',async()=>{
    const f=await fixture(),delayed={...f.input};await usage.accept(f.token,f.input);
    await control.report(f.owner,{revision:'1',state:'held'});assert.equal((await f.rows()).length,0);
    await control.report(f.owner,{revision:'1',state:'running'});
    const boundary=(await directory.pool.query('SELECT usage_not_before FROM host_policies WHERE tenant_id=$1',[f.tenant])).rows[0].usage_not_before;
    await assert.rejects(usage.accept(f.token,delayed),/readiness or freshness/);assert.equal((await f.rows()).length,0);
    await control.report(f.owner,{revision:'1',state:'running'});
    assert.equal((await directory.pool.query('SELECT usage_not_before FROM host_policies WHERE tenant_id=$1',[f.tenant])).rows[0].usage_not_before.getTime(),boundary.getTime());
    await delay(Math.max(0,boundary.getTime()+15100-Date.now()));
    let fresh={...f.input,stream:randomUUID(),at:Date.now()-1,intervalMs:15000};
    await usage.accept(f.token,fresh);
    for(let sequence=2;sequence<=3;sequence++){
      await delay(15100);const at=Date.now()-1;
      fresh={...fresh,sequence,at,intervalMs:at-fresh.at};await usage.accept(f.token,fresh);
    }
    assert.equal((await exportHostUsage(directory,f.tenant)).length,3);
  });
  await t.test('queued capacity journals omit raw samples and old copies are erased on revoke, prune and upgrade',async()=>{
    const image=`registry.test/host@sha256:${'a'.repeat(64)}`;
    for(const name of [...infrastructureGates,'tenant-capacity-resize'])await directory.pool.query('INSERT INTO release_gates(name,evidence_uri,image_digest,approved_at) VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING',[name,'test-fixture://local-only',image]);
    for(const cleanup of ['revoke','prune','migrate']){
      const f=await fixture();await historicalWindow(f);
      await directory.pool.query("UPDATE tenants SET image_digest=$2,region='iad',fly_app=id WHERE id=$1",[f.tenant,image]);
      const policy:CapacityPolicy={version:1,enabled:true,tiers:[{cpu_kind:'shared',cpus:2,memory_mb:4096},{cpu_kind:'shared',cpus:4,memory_mb:8192}],maxVolumeGb:40,volumeStepGb:10,cpuThreshold:.8,memoryThreshold:.85,diskThreshold:.8,reserveGb:2,windowSeconds:120,cooldownSeconds:300};
      await directory.transaction(c=>setCapacityPolicy(c,f.tenant,policy));const samples=await exportHostUsage(directory,f.tenant),source={guest:policy.tiers[0],volumeGb:10};
      const capacity={policyRevision:'1',source,target:recommendCapacity(policy,source,samples,{...f.owner,volume:f.volume}),samples,evidence:{uri:'https://evidence.test/usage',sha256:'a'.repeat(64),reviewer:'fixture'},maintenanceAcknowledged:true as const};
      const plan=await planEnvironmentOperation(directory,{tenant:f.tenant,kind:'update',image,capacity}),queued=await queueEnvironmentOperation(directory,plan);
      const get=async()=>(await directory.pool.query('SELECT * FROM environment_operations WHERE id=$1',[queued.id])).rows[0];
      const original=await get();assert.equal('samples' in original.capacity_change,false);assert.deepEqual(original.capacity_change.evidence,capacity.evidence);
      // Simulate an operation admitted by an older replica before rollout.
      await directory.pool.query('UPDATE environment_operations SET capacity_change=$2 WHERE id=$1',[queued.id,capacity]);
      if(cleanup==='revoke')await directory.revokeTenant(f.tenant);
      else if(cleanup==='prune'){
        await directory.pool.query("UPDATE host_usage_samples SET received_at=clock_timestamp()-interval '2 hours' WHERE tenant_id=$1",[f.tenant]);await pruneHostUsage(directory);
      }else {await directory.migrate();await directory.migrate();}
      const after=await get();assert.equal('samples' in after.capacity_change,false);assert.deepEqual(after.capacity_change,original.capacity_change);
      assert.equal(after.id,original.id);assert.equal(after.source_volume,original.source_volume);
      if(cleanup!=='migrate')assert.equal((await f.rows()).length,0);
    }
  });
  await t.test('duplicate, concurrent and skipped samples do not inflate a usage window',async()=>{
    const f=await fixture();const results=await Promise.all([f.post(),f.post()]);assert.deepEqual(results.map(r=>r.status).sort(),[204,409]);
    assert.equal((await f.post({...f.input,sequence:2})).status,409);
    await ageWindow(f.tenant);
    assert.equal((await f.post({...f.input,sequence:3})).status,409);
    assert.equal((await f.post({...f.input,sequence:2,intervalMs:31000})).status,409);
    assert.equal((await f.post({...f.input,sequence:2})).status,204);assert.equal((await f.rows()).length,2);
  });
  await t.test('telemetry bursts have a bounded queue that releases slots after rejection',async()=>{
    const f=await fixture(),release:Array<()=>void>=[];
    const pending=Array.from({length:32},()=>app.request('/',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},
      body:new ReadableStream<Uint8Array>({start(c){release.push(()=>{c.enqueue(Buffer.from(JSON.stringify(f.input)));c.close();});}}),duplex:'half'} as any));
    assert.equal((await f.post()).status,503);
    release.forEach(fn=>fn());const results=await Promise.all(pending);
    assert.equal(results.filter(r=>r.status===204).length,1);assert.equal(results.filter(r=>r.status===409).length,31);
    assert.equal((await f.post()).status,409);assert.equal((await f.rows()).length,1);
  });
  await t.test('host holds, readiness errors, stale acknowledgements and changed environment deny samples and exports',async()=>{
    for(const update of ["state='suspended'","state='deleting'","generation=generation+1","machine_id='replacement'","volume_id='vol_replacement'"]){
      const f=await fixture();await historicalWindow(f);await directory.pool.query(`UPDATE tenants SET ${update} WHERE id=$1`,[f.tenant]);
      assert.ok([401,409].includes((await f.post()).status));await assert.rejects(exportHostUsage(directory,f.tenant));
    }
    for(const update of ["usage_not_before=clock_timestamp()","desired='hold'","observed='held'","acknowledged_revision=NULL","error_code='host_requires_reconciliation'","reported_at=now()-interval '5 minutes'"]){
      const f=await fixture();await historicalWindow(f);await directory.pool.query(`UPDATE host_policies SET ${update} WHERE tenant_id=$1`,[f.tenant]);
      assert.equal((await f.post()).status,409);await assert.rejects(exportHostUsage(directory,f.tenant));
    }
  });
  await t.test('hold acknowledgement, revised run intent and account deletion erase stored windows',async()=>{
    const f=await fixture();await historicalWindow(f);await control.report(f.owner,{revision:'1',state:'held'});assert.equal((await f.rows()).length,0);
    await control.report(f.owner,{revision:'1',state:'running'});await assert.rejects(exportHostUsage(directory,f.tenant));await historicalWindow(f);
    await directory.transaction(c=>setHostIntent(c,f.owner,'run',true));assert.equal((await f.rows()).length,0);
    await control.report(f.owner,{revision:'2',state:'running'});await historicalWindow(f);await directory.revokeTenant(f.tenant);assert.equal((await f.rows()).length,0);
  });
  await t.test('tenant and policy lock waits revalidate expiry, readiness and measured time',async()=>{
    for(const kind of ['token-expiry','sample-expiry','policy-hold'] as const){
      const f=await fixture(),lock=await directory.pool.connect();
      try{
        await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await lock.query('SELECT tenant_id FROM host_policies WHERE tenant_id=$1 FOR UPDATE',[f.tenant]);
        const token=kind==='token-expiry'?await f.sign('swarm-host','2s'):f.token;
        const input={...f.input,at:kind==='sample-expiry'?Date.now()-14000:f.input.at};
        const pending=assert.rejects(usage.accept(token,input));await waitBlocked(pid);
        if(kind==='policy-hold')await lock.query("UPDATE host_policies SET desired='hold' WHERE tenant_id=$1",[f.tenant]);
        else if(kind==='token-expiry')await delay(Math.max(0,decodeJwt(token).exp!*1000-Date.now()+50));
        else await delay(1100);
        await lock.query('COMMIT');await pending;assert.equal((await f.rows()).length,0);
      }finally{await lock.query('ROLLBACK');lock.release();}
    }
  });
  await t.test('input mutation during the actual tenant row wait cannot change the admitted sample',async()=>{
    const f=await fixture(),lock=await directory.pool.connect();
    try{
      await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);
      const input={...f.input},pending=usage.accept(f.token,input);await waitBlocked(pid);input.memory=0;input.volume='vol_other';
      await lock.query('COMMIT');await pending;assert.equal((await f.rows())[0].memory,.5);
    }finally{await lock.query('ROLLBACK');lock.release();}
  });
  await t.test('nested measurements are detached before a correlated PostgreSQL lock wait',async()=>{
    const f=await fixture(),lock=await directory.pool.connect();
    try{
      await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);
      const input={...f.input,version:2 as const,filesystems:filesystems()},pending=usage.accept(f.token,input);
      await waitBlocked(pid);input.filesystems.root.availableBytes=input.filesystems.root.totalBytes;input.filesystems.data.freeInodes=0;
      await lock.query('COMMIT');await pending;
      assert.deepEqual((await f.rows())[0].filesystems,filesystems());
    }finally{await lock.query('ROLLBACK');lock.release();}
  });
  await t.test('private pressure export keeps root exhaustion out of volume recommendations and refuses stale or foreign windows',async()=>{
    const f=await fixture(),other=await fixture(),v2={...f.input,version:2 as const,filesystems:filesystems()};
    await historicalWindow(f,5,v2);
    const output=path.join(root,'pressure.json');let cloudReads=0;
    const result=await capacityCommand(['export-pressure','--tenant',f.tenant,'--output',output],directory,{async capacity(){cloudReads++;throw Error('Unexpected cloud read.');}});
    assert.equal(cloudReads,0);assert.equal(result.queued,false);assert.equal(fs.statSync(output).mode&0o777,0o600);
    const bytes=fs.readFileSync(output),samples=JSON.parse(bytes.toString());
    assert.equal((result as any).sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(samples.length,5);
    assert.ok(samples.every((s:any)=>s.tenant===f.tenant&&s.machine===f.machine&&s.volume===f.volume));
    assert.deepEqual(samples[0].filesystems,filesystems());
    await assert.rejects(capacityCommand(['export-pressure','--tenant',f.tenant,'--output',output],directory),/EEXIST/);
    await assert.rejects(exportHostPressure(directory,other.tenant));
    const usageSamples=await exportHostUsage(directory,f.tenant);assert.ok(usageSamples.every(s=>!Object.hasOwn(s,'filesystems')));
    const policy:CapacityPolicy={version:1,enabled:true,tiers:[{cpu_kind:'shared',cpus:2,memory_mb:4096},{cpu_kind:'shared',cpus:4,memory_mb:8192}],maxVolumeGb:40,volumeStepGb:10,cpuThreshold:.8,memoryThreshold:.85,diskThreshold:.8,reserveGb:2,windowSeconds:120,cooldownSeconds:300};
    assert.equal(recommendCapacity(policy,{guest:policy.tiers[0],volumeGb:10},usageSamples,{...f.owner,volume:f.volume}).volumeGb,10);
    assert.equal((await directory.pool.query('SELECT 1 FROM environment_operations WHERE tenant_id=$1',[f.tenant])).rowCount,0);
    assert.equal((await directory.pool.query('SELECT 1 FROM tenant_capacity_policies WHERE tenant_id=$1',[f.tenant])).rowCount,0);
    await directory.pool.query('UPDATE host_usage_samples SET at=at-61000 WHERE tenant_id=$1',[f.tenant]);await assert.rejects(exportHostPressure(directory,f.tenant));
  });
  await t.test('legacy and partial pressure windows never fabricate missing filesystem measurements',async()=>{
    const f=await fixture();await historicalWindow(f);await assert.rejects(exportHostPressure(directory,f.tenant),/unavailable/);
    await ageWindow(f.tenant);
    await usage.accept(f.token,{...f.input,version:2,sequence:6,filesystems:filesystems()});
    await assert.rejects(exportHostPressure(directory,f.tenant),/unavailable/);
    await ageWindow(f.tenant);
    const unknown=filesystems();unknown.root.totalInodes=null;unknown.root.freeInodes=null;
    await historicalWindow(f,3,{...f.input,version:2,stream:randomUUID(),filesystems:unknown});
    const samples=await exportHostPressure(directory,f.tenant);assert.ok(samples.every(s=>s.filesystems.root.freeInodes===null));
    await control.report(f.owner,{revision:'1',state:'held'});await assert.rejects(exportHostPressure(directory,f.tenant));assert.equal((await f.rows()).length,0);
  });
  await t.test('private export feeds the existing policy recommender without queueing or granting approval',async()=>{
    const f=await fixture();await historicalWindow(f);
    const output=path.join(root,'usage.json'),result=await capacityCommand(['export-usage','--tenant',f.tenant,'--output',output],directory);
    assert.equal(result.queued,false);assert.equal(fs.statSync(output).mode&0o777,0o600);
    const bytes=fs.readFileSync(output);assert.equal((result as any).sha256,createHash('sha256').update(bytes).digest('hex'));
    const policy:CapacityPolicy={version:1,enabled:true,tiers:[{cpu_kind:'shared',cpus:2,memory_mb:4096},{cpu_kind:'shared',cpus:4,memory_mb:8192}],maxVolumeGb:40,volumeStepGb:10,cpuThreshold:.8,memoryThreshold:.85,diskThreshold:.8,reserveGb:2,windowSeconds:120,cooldownSeconds:300};
    assert.deepEqual(recommendCapacity(policy,{guest:policy.tiers[0],volumeGb:10},JSON.parse(bytes.toString()),{...f.owner,volume:f.volume}),{guest:policy.tiers[1],volumeGb:10});
    await assert.rejects(capacityCommand(['export-usage','--tenant',f.tenant,'--output',output],directory),/EEXIST/);
    await directory.pool.query('UPDATE host_usage_samples SET at=at-61000 WHERE tenant_id=$1',[f.tenant]);await assert.rejects(exportHostUsage(directory,f.tenant));
  });
  await t.test('new streams replace old windows; bounded retention removes stale and revoked identity data',async()=>{
    const f=await fixture();await historicalWindow(f,123);assert.ok((await f.rows()).length<=120);
    await ageWindow(f.tenant);
    await usage.accept(f.token,{...f.input,stream:randomUUID()});assert.equal((await f.rows()).length,1);
    const other=await fixture();await historicalWindow(other);
    await directory.pool.query("UPDATE host_usage_samples SET received_at=now()-interval '2 hours' WHERE tenant_id=$1",[f.tenant]);
    await directory.pool.query('UPDATE tenants SET generation=2 WHERE id=$1',[other.tenant]);await pruneHostUsage(directory);
    assert.equal((await f.rows()).length,0);assert.equal((await other.rows()).length,0);
  });
});
