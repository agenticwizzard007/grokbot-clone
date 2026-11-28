import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeFly } from './fixtures/fly-tenants.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tenantMeterTransport, TenantMeterReporter, applyMeterAllowance, startTenantMeter } from '../server/src/runtime/tenant-meter.js';
import { tenantMeteringEnabled } from '../server/src/runtime/meter-contract.js';
import type { PlanUsageSummary } from '../server/src/plan-usage-types.js';

const report={version:1 as const,tenant:'usr_fixture_meter',at:Date.now(),days:[{day:'2026-11-28',modelSpendUsd:2,computerMinutes:3,voiceMinutes:4}]};
const allowance={month:'2026-11',allowanceUsd:10,spendUsd:2,percentUsed:20,softLimitExceeded:false,source:'tenant' as const,reportedAt:'2026-11-28T00:00:00Z'};

test('meter flag defaults off, rejects typos and never starts a standalone reporter',async()=>{
  assert.equal(tenantMeteringEnabled('0'),false);assert.equal(tenantMeteringEnabled('1'),true);
  const previous=process.env.TENANT_METERING;delete process.env.TENANT_METERING;
  try{assert.equal(tenantMeteringEnabled(),false);process.env.TENANT_METERING='1';assert.equal(await startTenantMeter(),undefined);}finally{if(previous===undefined)delete process.env.TENANT_METERING;else process.env.TENANT_METERING=previous;}
  assert.throws(()=>tenantMeteringEnabled('true'));
});
test('runtime meter transport rotates runtime tokens, uses HTTPS and refuses redirects/errors',async()=>{
  let token='first',calls=0;
  const request:typeof fetch=async(url,init)=>{
    calls++;assert.equal(init?.redirect,'error');assert.ok(init?.signal);assert.equal((init!.headers as any).authorization,`Bearer ${token}`);
    if(calls===1){assert.equal(String(url),'https://platform.example/internal/runtime/meter');assert.deepEqual(JSON.parse(init!.body as string),report);return new Response(null,{status:204});}
    assert.equal(String(url),'https://platform.example/internal/runtime/meter/allowance');return Response.json(allowance);
  };
  const client=tenantMeterTransport('https://platform.example','unused',request,async()=>token);
  await client.report(report);token='rotated';assert.deepEqual(await client.allowance(),allowance);
  for(const origin of ['http://platform.example','https://user:password@platform.example'])assert.throws(()=>tenantMeterTransport(origin,'unused'));
  for(const status of [302,401,503])await assert.rejects(tenantMeterTransport('https://platform.example','unused',async()=>new Response(null,{status}),async()=>'token').report(report));
});
test('runtime allowance responses are bounded and report cancellation cannot hang',async()=>{
  const client=tenantMeterTransport('https://platform.example','unused',async()=>new Response('x'.repeat(2049)),async()=>'token');
  await assert.rejects(client.allowance(),/Oversized/);
  let cancelled=false;
  await tenantMeterTransport('https://platform.example','unused',async()=>new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}})),async()=>'token').report(report);
  assert.ok(cancelled);
});
test('reporter serializes overlapping ticks and sends fresh cumulative snapshots after lost responses',async()=>{
  let release!:()=>void,calls=0,snapshots=0;
  const gate=new Promise<void>(r=>{release=r;});
  const reporter=new TenantMeterReporter(()=>({...report,at:++snapshots}),async()=>{calls++;if(calls===1){await gate;throw Error('lost response');}});
  const pending=reporter.tick();const failed=assert.rejects(pending);await reporter.tick();assert.equal(snapshots,1);release();await failed;
  await reporter.tick();assert.equal(snapshots,2);assert.equal(calls,2);
});
test('allowance summary uses money, UTC months and a soft flag while none preserves No limit',()=>{
  const summary={plan:{},week:{days:[]},computedAt:1} as unknown as PlanUsageSummary;
  const result=applyMeterAllowance(summary,allowance);
  assert.equal(result.plan.usedCents,200);assert.equal(result.plan.limitCents,1000);assert.equal(result.plan.percentUsed,20);assert.equal(result.plan.softLimit,true);
  assert.equal(result.plan.periodStart,Date.parse('2026-11-01'));assert.equal(result.plan.periodEnd,Date.parse('2026-12-01'));assert.equal(result.plan.source,'tenant');
  const none=applyMeterAllowance(summary,{...allowance,allowanceUsd:null,percentUsed:null});assert.equal(none.plan.limitCents,null);assert.equal(none.plan.percentUsed,null);
  const over=applyMeterAllowance(summary,{...allowance,spendUsd:12,percentUsed:120,softLimitExceeded:true});assert.equal(over.plan.percentUsed,120);assert.equal(over.plan.softLimitExceeded,true);
  assert.deepEqual(summary.plan,{});assert.throws(()=>applyMeterAllowance(summary,{...allowance,spendUsd:NaN}));
});


test('tenant usage summary reads its authenticated allowance, preserves no limit and reports outages without revoking sessions',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tenant-meter-summary-')),tenant='usr_meter_summary',manifest=path.join(root,'manifest.json'),tokenFile=path.join(root,'runtime-token');
  fs.writeFileSync(manifest,JSON.stringify({tenantId:tenant,volumeId:'volume-fixture'}));fs.writeFileSync(tokenFile,'runtime-fixture-token');
  const script=`
    import assert from 'node:assert/strict';
    import {Hono} from 'hono';
    let calls=0,mode='allowance';
    globalThis.fetch=async(url,init)=>{
      calls++;assert.equal(String(url),'https://platform.test/internal/runtime/meter/allowance');
      assert.equal(init.headers.authorization,'Bearer runtime-fixture-token');assert.equal(init.redirect,'error');
      if(mode==='outage')return Response.json({error:'secret-sentinel'},{status:503});
      return Response.json({month:'2026-11',allowanceUsd:mode==='none'?null:10,spendUsd:12,percentUsed:120,softLimitExceeded:mode!=='none',source:'tenant',reportedAt:null});
    };
    const {db}=await import('./server/src/db.ts');
    const {usageApi}=await import('./server/src/routes-usage.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('${tenant}','fixture@example.test','Tenant fixture',Date.now());
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('session-fixture','${tenant}',Date.now(),Date.now()+3600000);
    const app=new Hono();app.route('/api/usage',usageApi);
    const read=()=>app.request('/api/usage/summary',{headers:{cookie:'swarm_session=session-fixture'}});
    const off=await read();assert.equal(off.status,200);assert.equal(calls,0);assert.equal((await off.json()).plan.softLimit,undefined);
    process.env.TENANT_METERING='1';
    const enabled=await read();assert.equal(enabled.status,200);const summary=await enabled.json();
    assert.equal(summary.plan.percentUsed,120);assert.equal(summary.plan.softLimitExceeded,true);assert.equal(summary.plan.usedCents,1200);
    mode='none';assert.equal((await (await read()).json()).plan.limitCents,null);
    mode='outage';const outage=await read();assert.equal(outage.status,503);assert.doesNotMatch(await outage.text(),/secret-sentinel|runtime-fixture/);
    assert.equal(db.prepare('SELECT count(*) n FROM auth_sessions').get().n,1);
    assert.equal((await app.request('/api/usage/summary',{headers:{cookie:'swarm_session=foreign'}})).status,401);
    db.close();console.log('tenant allowance path verified');
  `;
  const childEnv:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',SWARM_ROLE:'tenant',SWARM_TENANT_ID:tenant,SWARM_VOLUME_ID:'volume-fixture',TENANT_MANIFEST_FILE:manifest,TENANT_DATA_KEY_FILE:path.join(root,'unused-key'),
    DB_PATH:path.join(root,'tenant.db'),FILES_DIR:path.join(root,'files'),PLATFORM_URL:'https://platform.test',RUNTIME_TOKEN_FILE:tokenFile,COMPUTER_PROVIDER:'local',SESSION_SECRET:'fixture',INKBOX_TUNNEL:'0',TENANT_METERING:'0'};
  for(const name of ['COMPOSIO_API_KEY','COMPOSIO_WEBHOOK_SECRET','FLY_API_TOKEN','DATABASE_URL','MIGRATION_DATABASE_URL','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','INKBOX_ADMIN_API_KEY','INKBOX_API_KEY','DIRECT_API_KEY','OPENROUTER_API_KEY','XAI_API_KEY','GOOGLE_CLIENT_SECRET','APPLE_PRIVATE_KEY'])delete childEnv[name];
  try{assert.match(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:childEnv,encoding:'utf8',timeout:15000}),/tenant allowance path verified/);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('provisioner passes the meter flag to new hosts only on explicit opt-in',async()=>{
  const previous=process.env.TENANT_METERING,tenant='usr_meter_flag';
  try{
    for(const value of ['0','1']){
      process.env.TENANT_METERING=value;const fly=new FakeFly();
      const {app}=await fly.ensureApp(tenant),volume=await fly.ensureVolume(app,tenant,'iad');
      const machine=await fly.ensureMachine(app,tenant,volume.id,'registry.test/host@sha256:'+'a'.repeat(64),'iad','1');
      assert.equal(machine.config.env.TENANT_METERING,value==='1'?'1':undefined);
      assert.equal(machine.config.services.length,0);
    }
  }finally{if(previous===undefined)delete process.env.TENANT_METERING;else process.env.TENANT_METERING=previous;}
});
