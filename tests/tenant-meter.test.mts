import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { TunnelBroker } from '../server/src/platform/tunnel.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Directory } from '../server/src/platform/directory.js';
import { RuntimeIdentity } from '../server/src/platform/runtime-identity.js';
import { setHostIntent, HostControl } from '../server/src/platform/host-control.js';
import { TenantMeter, pruneTenantMeter, setMeterAllowance, noteMeterTunnel } from '../server/src/platform/meter.js';
import { meterRoutes } from '../server/src/platform/meter-routes.js';
import { observeMeterResource, InfrastructureMeter, machineMeterResource, volumeMeterResource } from '../server/src/platform/meter-infrastructure.js';
import { meterCommand, tenantMeterHealth, exportTenantMeter } from '../server/src/platform/meter-cli.js';
import { tenantRequestLog, tenantWorkerLog, bindTenantLog, tenantHash } from '../server/src/platform/tenant-logs.js';
import { utcDay } from '../server/src/runtime/meter-contract.js';
import { LifecycleWorker } from '../server/src/platform/lifecycle-worker.js';
import { FakeFly } from './fixtures/fly-tenants.mjs';
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve=r; }), resolve: () => resolve() }; };
const near = (a: number, b: number) => assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('tenant meter ledger and authority with disposable PostgreSQL', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const admin = new Pool({connectionString:process.env.TEST_DATABASE_URL}), schema=`test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(url.href); await directory.migrate(); await directory.migrate();
  const keys=await generateKeyPair('EdDSA',{extractable:true});
  const identity=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
  const meter=new TenantMeter(directory,identity), app=meterRoutes(meter,identity,true);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'meter-'));
  Object.assign(process.env,{SESSION_SECRET:'test-only',DB_PATH:path.join(root,'db'),FILES_DIR:path.join(root,'files'),COMPUTER_PROVIDER:'local',SWARM_NO_SCHEDULER:'1',COMPOSIO_API_KEY:''});
  const {platformRequestMiddleware}=await import('../server/src/platform/server.js');
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();fs.rmSync(root,{recursive:true,force:true});});
  async function fixture() {
    const tenant=await directory.identity('google',randomUUID(),{name:'Meter fixture',email:'private@example.test'}),machine='machine_'+randomUUID(),volume='vol_'+randomBytes(6).toString('hex');
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=$2,volume_id=$3 WHERE id=$1",[tenant,machine,volume]);
    await directory.transaction(c=>setHostIntent(c,{tenant,machine,generation:'1'},'run'));
    const token=await identity.sign({sub:tenant,machine,generation:'1'},'swarm-runtime','5m');
    const input={version:1 as const,tenant,at:Date.now(),days:[{day:utcDay(Date.now()),modelSpendUsd:2.5,computerMinutes:12,voiceMinutes:3}]};
    const post=(body:unknown=input,bearer=token)=>app.request('/',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(body)});
    const rows=async()=>(await directory.pool.query('SELECT * FROM tenant_meter WHERE tenant_id=$1 ORDER BY day,metric',[tenant])).rows;
    return {tenant,machine,volume,token,input,post,rows};
  }
  const ageReport=(tenant:string)=>directory.pool.query("UPDATE tenant_meter_status SET reported_at=clock_timestamp()-interval '30 seconds' WHERE tenant_id=$1",[tenant]);
  await t.test('cumulative daily reports replace claims without adding them twice',async()=>{
    const f=await fixture(); assert.equal((await f.post()).status,204); await ageReport(f.tenant);
    f.input.at=Date.now(); assert.equal((await f.post()).status,204);
    const rows=await f.rows(); assert.equal(rows.length,3);
    assert.deepEqual(rows.map(r=>[r.metric,Number(r.quantity),r.source]),[['computer_minutes',12,'tenant'],['model_spend_usd',2.5,'tenant'],['voice_minutes',3,'tenant']]);
    assert.equal(rows[0].cost_usd,null); assert.equal(Number(rows[1].cost_usd),2.5);
  });
  await t.test('cross-tenant reports, host-audience tokens and forged tokens are rejected',async()=>{
    const a=await fixture(),b=await fixture();
    assert.equal((await a.post({...a.input,tenant:b.tenant})).status,409);
    const host=await identity.sign({sub:a.tenant,machine:a.machine,generation:'1'},'swarm-host');
    assert.equal((await a.post(a.input,host)).status,401); assert.equal((await a.post(a.input,'forged')).status,401);
    assert.equal((await a.rows()).length+(await b.rows()).length,0);
  });
  await t.test('replays remain rejected after token rotation and concurrent delivery',async()=>{
    const f=await fixture(); const responses=await Promise.all([f.post(),f.post()]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[204,409]); await ageReport(f.tenant);
    const next=await identity.sign({sub:f.tenant,machine:f.machine,generation:'1'},'swarm-runtime','5m');
    assert.equal((await f.post(f.input,next)).status,409);
    assert.equal((await f.post({...f.input,at:f.input.at-1},next)).status,409); assert.equal((await f.rows()).length,3);
  });
  await t.test('malformed, nonfinite, negative, stale, future, duplicate and excess days leave no claims',async()=>{
    const f=await fixture();
    for(const body of [{...f.input,source:'provisioner'},{...f.input,at:Date.now()+60000},{...f.input,at:Date.now()-60001},
      {...f.input,days:[{...f.input.days[0],modelSpendUsd:-1}]},{...f.input,days:[{...f.input.days[0],voiceMinutes:Infinity}]},
      {...f.input,days:[{...f.input.days[0],day:'2026-02-31'}]},{...f.input,days:[{...f.input.days[0],day:'2000-01-01'}]},
      {...f.input,days:[f.input.days[0],f.input.days[0]]},{...f.input,days:Array(33).fill(f.input.days[0])}]) assert.equal((await f.post(body)).status,409);
    assert.equal((await f.rows()).length,0);
  });
  await t.test('production middleware authenticates before reading, caps bodies and defaults off',async()=>{
    const f=await fixture();
    for(const enabled of [false,true]) {
      const stack=new Hono(); platformRequestMiddleware(stack);stack.route('/internal/runtime/meter',meterRoutes(meter,identity,enabled));
      let close!:()=>void;
      const body=new ReadableStream({start(c){c.enqueue(Buffer.from('{'));close=()=>c.close();}});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const response=await Promise.race([stack.request('/internal/runtime/meter',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'} as any),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Body consumed before auth')),500);})]);
        assert.equal(response.status,enabled?401:404);
      }finally{clearTimeout(timer);close();}
      assert.equal((await stack.request('/internal/runtime/meter',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:'x'.repeat(8193)})).status,enabled?400:404);
    }
  });
  await t.test('body timeout and revocation during body consumption cannot write',async()=>{
    const f=await fixture(),entered=deferred(),verify=identity.verify.bind(identity);
    identity.verify=async(...args)=>{const result=await verify(...args);entered.resolve();return result;};
    let release!:()=>void;
    const body=new ReadableStream({start(c){release=()=>{c.enqueue(Buffer.from(JSON.stringify(f.input)));c.close();};}});
    const pending=app.request('/',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body,duplex:'half'} as any);
    try {await entered.promise;await directory.revokeTenant(f.tenant);release();assert.equal((await pending).status,409);}finally{identity.verify=verify;}
    assert.equal((await f.rows()).length,0);
    const g=await fixture();let cancelled=false;
    const stalled=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}});
    assert.equal((await app.request('/',{method:'POST',headers:{authorization:`Bearer ${g.token}`,'content-type':'application/json'},body:stalled,duplex:'half'} as any)).status,400);
    assert.ok(cancelled);
  });
  await t.test('generation and host holds are rechecked after waiting on the tenant lock',async()=>{
    for(const change of ['generation','hold']) {
      const f=await fixture(),lock=await directory.pool.connect(); await lock.query('BEGIN');await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[f.tenant]);
      const pending=meter.accept(f.token,f.input);const rejected=assert.rejects(pending,/revoked/i);
      if(change==='generation')await lock.query('UPDATE tenants SET generation=2 WHERE id=$1',[f.tenant]);
      else await lock.query("UPDATE host_policies SET desired='hold' WHERE tenant_id=$1",[f.tenant]);
      await lock.query('COMMIT');lock.release();await rejected;assert.equal((await f.rows()).length,0);
    }
  });
  await t.test('infrastructure cursor transactions split UTC days, handle size changes and ignore replay',async()=>{
    const f=await fixture(),at=Date.parse('2026-11-27T23:59:00Z');
    const observe=(time:number,state='started',size=10)=>directory.transaction(async c=>{
      await observeMeterResource(c,f.tenant,'1',machineMeterResource({id:f.machine,state}),time);
      await observeMeterResource(c,f.tenant,'1',volumeMeterResource({id:f.volume,size_gb:size}),time);
    });
    await observe(at);await Promise.all([observe(at+120000,'stopped',20),observe(at+120000,'stopped',20)]);await observe(at+60000);await observe(at+180000,'started',20);
    const rows=await f.rows(); assert.equal(rows.length,4);
    for(const day of ['2026-11-27','2026-11-28'])near(Number(rows.find(r=>r.day.toISOString().startsWith(day)&&r.metric==='machine_running_seconds').quantity),60);
    near(Number(rows.filter(r=>r.metric==='storage_gb_days').reduce((n,r)=>n+Number(r.quantity),0)),(10*120+20*60)/86400);
    assert.ok(rows.every(r=>r.cost_usd===null&&r.source==='provisioner'));
    const before=rows.map(r=>r.quantity);await observe(at+3600000);assert.deepEqual((await f.rows()).map(r=>r.quantity),before,'unknown gap must not be charged');
  });
  await t.test('allowance is tenant bound, optional, recurring and soft when exceeded',async()=>{
    const a=await fixture(),b=await fixture(); await a.post();
    const read=(token:string,path='/allowance')=>app.request(path,{headers:{authorization:`Bearer ${token}`}});
    assert.equal((await (await read(a.token)).json()).allowanceUsd,null);
    await setMeterAllowance(directory,a.tenant,2);
    const allowed=await (await read(a.token)).json();assert.equal(allowed.percentUsed,125);assert.equal(allowed.softLimitExceeded,true);assert.equal(allowed.source,'tenant');
    assert.equal((await (await read(b.token)).json()).allowanceUsd,null);
    assert.equal((await read(b.token,`/allowance?tenant=${a.tenant}`)).status,400);
    assert.equal((await identity.verify(a.token)).tenant,a.tenant,'soft limit never revokes');
    await assert.rejects(setMeterAllowance(directory,a.tenant,-1));await setMeterAllowance(directory,a.tenant,0.29);await assert.rejects(setMeterAllowance(directory,a.tenant,0.001));await setMeterAllowance(directory,a.tenant,null);
    assert.equal((await (await read(a.token)).json()).percentUsed,null);
  });
  await t.test('CSV and JSON export preserve source, precision, month and tenant filters',async()=>{
    const a=await fixture(),b=await fixture();await a.post();await b.post();
    const month=utcDay(Date.now()).slice(0,7),rows=JSON.parse(await meterCommand(['export','--month',month,'--tenant',a.tenant],directory));
    assert.equal(rows.length,3);assert.ok(rows.every((r:any)=>r.tenant_id===a.tenant&&r.source==='tenant'));
    assert.equal(rows.find((r:any)=>r.metric==='model_spend_usd').quantity,2.5);
    const csv=await meterCommand(['export','--month',month,'--tenant',a.tenant,'--format','csv'],directory);
    assert.equal(csv.trim().split('\n').length,4);assert.match(csv,/"2.5","USD","2.5","tenant"/);assert.doesNotMatch(csv,/private@example|Bearer|encrypted/);
    assert.deepEqual(await exportTenantMeter(directory,'2001-01',a.tenant),[]);
    for(const args of [['export','--month','2026-13'],['export','--month',month,'--format','xml'],['health','--tenant',a.tenant,'--tenant',b.tenant],['health','--secret','x']])await assert.rejects(meterCommand(args,directory));
    const set=JSON.parse(await meterCommand(['allowance','--tenant',a.tenant,'--usd','10.25'],directory));assert.equal(set.enforced,false);assert.equal(set.allowanceUsd,10.25);
  });
  await t.test('health includes historical tunnel/report time and failure counts without secrets',async()=>{
    const f=await fixture();await f.post();await noteMeterTunnel(directory,identity,f.token);
    await directory.pool.query("UPDATE lifecycle_jobs SET state='failed',attempts=3,error_code='secret-do-not-emit' WHERE tenant_id=$1",[f.tenant]);
    const [health]=await tenantMeterHealth(directory,f.tenant);
    assert.ok(health.last_tunnel_connection&&health.last_meter_report);assert.equal(health.machine_state,'unknown');assert.equal(health.lifecycle_job_failures,1);assert.equal(health.failed_job_attempts,3);
    assert.equal(health.tenant_hash,tenantHash(f.tenant));assert.doesNotMatch(JSON.stringify(health),/secret-do-not-emit|private@example/);
  });
  await t.test('real local WebSocket upgrade records authenticated connection history only when enabled',async()=>{
    const f=await fixture(),broker=new TunnelBroker(directory,identity,['https://platform.example'],'fixture-session-key-at-least-32-bytes');
    broker.setDirectoryReady(true);const server=createServer();broker.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
    const previous=process.env.TENANT_METERING,clients:WebSocket[]=[];
    try{
      for(const setting of ['0','1']){
        process.env.TENANT_METERING=setting;
        const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/internal/runtime/tunnel`,{headers:{authorization:`Bearer ${f.token}`}});clients.push(ws);await once(ws,'open');
        if(setting==='1'){
          for(let i=0;i<50&&!(await tenantMeterHealth(directory,f.tenant))[0].last_tunnel_connection;i++)await new Promise(r=>setTimeout(r,10));
          assert.ok((await tenantMeterHealth(directory,f.tenant))[0].last_tunnel_connection);
        }else assert.equal((await tenantMeterHealth(directory,f.tenant))[0].last_tunnel_connection,null);
      }
    }finally{
      if(previous===undefined)delete process.env.TENANT_METERING;else process.env.TENANT_METERING=previous;
      for(const ws of clients)ws.terminate();await new Promise<void>(r=>server.close(()=>r()));
    }
  });
  await t.test('retention removes old ledger rows but preserves replay cursors',async()=>{
    const f=await fixture();await f.post();await directory.pool.query("UPDATE tenant_meter SET day='2000-01-01' WHERE tenant_id=$1",[f.tenant]);
    await pruneTenantMeter(directory);assert.equal((await f.rows()).length,0);await ageReport(f.tenant);assert.equal((await f.post()).status,409);
  });
  await t.test('revokeTenant purges meters, allowance, observation and report metadata; late observations cannot recreate them',async()=>{
    const f=await fixture();await f.post();await setMeterAllowance(directory,f.tenant,10);await noteMeterTunnel(directory,identity,f.token);
    await directory.transaction(c=>observeMeterResource(c,f.tenant,'1',machineMeterResource({id:f.machine,state:'started'})));
    await directory.revokeTenant(f.tenant);
    await directory.transaction(c=>observeMeterResource(c,f.tenant,'1',machineMeterResource({id:f.machine,state:'started'})));
    for(const table of ['tenant_meter','tenant_allowances','tenant_meter_status','tenant_meter_resources'])assert.equal((await directory.pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`,[f.tenant])).rowCount,0);
    assert.equal((await f.post()).status,401);await assert.rejects(noteMeterTunnel(directory,identity,f.token));
  });
  await t.test('polling and lifecycle transitions observe the fake provider and delete without stale billing',async()=>{
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE state IN ('queued','failed')");
    const tenant=await directory.identity('google',randomUUID(),{name:'Lifecycle meter'}),fly=new FakeFly();
    const worker=new LifecycleWorker(directory,{fly,image:'registry.test/host@sha256:'+'a'.repeat(64),region:'iad',metering:true,envelopes:{create:async()=>{}},backups:{prune:async()=>{}}});
    assert.equal(await worker.tick(),'retry');
    const owner=(await directory.pool.query('SELECT * FROM tenants WHERE id=$1',[tenant])).rows[0],hosts=new HostControl(directory);
    const host={tenant,machine:owner.machine_id,generation:'1'},policy=await hosts.policy(host);await hosts.report(host,{revision:policy.revision,state:'running'});
    await directory.pool.query('UPDATE lifecycle_jobs SET retry_at=now() WHERE tenant_id=$1',[tenant]);assert.equal(await worker.tick(),'completed');
    const poller=new InfrastructureMeter(directory,fly);await poller.tick();
    const [health]=await tenantMeterHealth(directory,tenant);assert.equal(health.machine_state,'started');assert.ok(health.machine_observed_at);
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'suspend')",[randomUUID(),tenant]);assert.equal(await worker.tick(),'completed');
    assert.equal((await tenantMeterHealth(directory,tenant))[0].machine_state,'stopped');
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake')",[randomUUID(),tenant]);assert.equal(await worker.tick(),'retry');
    assert.equal((await tenantMeterHealth(directory,tenant))[0].machine_state,'started');
    await directory.revokeTenant(tenant);assert.equal(await worker.tick(),'completed');assert.equal((await tenantMeterHealth(directory,tenant))[0].state,'deleted');
    assert.equal((await directory.pool.query('SELECT 1 FROM tenant_meter WHERE tenant_id=$1',[tenant])).rowCount,0);
  });
  await t.test('provider poll rejects unverified sizes, records failure and cannot write after revocation',async()=>{
    const f=await fixture();await directory.pool.query('UPDATE tenants SET fly_app=$2 WHERE id=$1',[f.tenant,'fixture-'+randomUUID()]);
    const driver={inventory:async()=>({present:true,machines:[],volumes:[{id:f.volume,size_gb:NaN}]})};
    assert.equal(await new InfrastructureMeter(directory,driver).tick(),'retry');assert.equal((await tenantMeterHealth(directory,f.tenant))[0].poll_failed,true);
    await directory.pool.query("UPDATE tenant_meter_status SET last_poll_at=now()-interval '2 minutes' WHERE tenant_id=$1",[f.tenant]);
    driver.inventory=async()=>{await directory.revokeTenant(f.tenant);return {present:true,machines:[],volumes:[{id:f.volume,size_gb:10}]};};
    await new InfrastructureMeter(directory,driver).tick();assert.equal((await directory.pool.query('SELECT 1 FROM tenant_meter_resources WHERE tenant_id=$1',[f.tenant])).rowCount,0);
  });
  await t.test('request and worker logs bind verified hashes, isolate concurrent requests and omit sensitive input',async()=>{
    const a=await fixture(),b=await fixture(),lines:string[]=[],logged=new Hono();
    logged.use('*',tenantRequestLog('platform',line=>lines.push(line)));
    logged.get('*',async c=>{try{await identity.verify((c.req.header('authorization')??'').replace(/^Bearer /,''));return c.json({ok:true});}catch{return c.body(null,401);}});
    await Promise.all([a,b].map(f=>logged.request('/private@example.test?secret=value',{headers:{authorization:`Bearer ${f.token}`,'x-tenant-id':'spoof'}})));
    await logged.request('/'+a.tenant,{headers:{'x-tenant-id':a.tenant}});
    assert.deepEqual(lines.slice(0,2).map(s=>JSON.parse(s).tenant_hash).sort(),[tenantHash(a.tenant),tenantHash(b.tenant)].sort());
    assert.equal(JSON.parse(lines[2]).tenant_hash,null);
    await tenantWorkerLog('lifecycle',async()=>{bindTenantLog(a.tenant);return 'retry';},line=>lines.push(line));
    assert.equal(JSON.parse(lines[3]).ok,false);
    const session=await directory.createSession(a.tenant,undefined,'fixture');
    const bySession=new Hono();bySession.use('*',tenantRequestLog('platform',line=>lines.push(line)));
    bySession.get('/',async c=>{await directory.session(session);return c.json({ok:true});});await bySession.request('/');
    assert.equal(JSON.parse(lines.at(-1)!).tenant_hash,tenantHash(a.tenant));
    assert.doesNotMatch(lines.join('\n'),new RegExp(`${a.tenant}|${b.tenant}|private@example|secret|Bearer|spoof`));
  });
});
