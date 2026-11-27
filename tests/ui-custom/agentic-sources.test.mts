import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agentic-sources-'));
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(temp,'app.db'),FILES_DIR:path.join(temp,'files'),CLI_PROFILES_DIR:path.join(temp,'profiles'),SWARM_ROLE:'standalone',SWARM_NO_SCHEDULER:'1',SESSION_SECRET:'fixture',COMPUTER_PROVIDER:'local',INKBOX_TUNNEL:'0',DIRECT_API_KEY:'',OPENROUTER_API_KEY:'',COMPOSIO_API_KEY:''});
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No provider calls');};
const { seedDashboard }=await import('../fixtures/dashboard.seed.mts');const fixture=await seedDashboard();
const { db }=await import('../../server/src/db.js');
await import('../../server/src/handoffs/db.js');
const { DataExecutor }=await import('../../server/src/ui/sources/executor.js');const data=new DataExecutor();
const { SOURCES }=await import('../../server/src/ui-config/registry-sources.js');
after(()=>{data.close();db.close();globalThis.fetch=originalFetch;fs.rmSync(temp,{recursive:true,force:true});});
for (const [i,user] of fixture.users.entries()) {
  const bot=`${user.id}-bot-0`, other=`${user.id}-bot-1`;
  for(let n=0;n<(i?2:12);n++) {
    const output=`out-${i}-${n}`,loop=`loop-${i}-${n}`,handoff=`handoff-${i}-${n}`;
    db.prepare("INSERT INTO run_outputs(id,user_id,bot_id,source,status,title,summary,manifest,provenance,content_hash,created_at) VALUES(?,?,?,'run','final',?,'FORBIDDEN_SUMMARY','[]','{}','fixture',?)").run(output,user.id,bot,`Fixture ${i} result ${n}`,100+n);
    db.prepare("INSERT INTO loops(id,user_id,owner_bot_id,name,spec,status,iteration,initiated_by,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'{}','running',2,'user',?,100,?)").run(loop,user.id,bot,`Fixture ${i} loop ${n}`,loop,100+n);
    db.prepare("INSERT INTO handoffs(id,user_id,from_bot_id,to_bot_id,source_output_id,initiated_by,instruction,status,idempotency_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,'user','FORBIDDEN_INSTRUCTION','running',?,'fixture',100,?)").run(handoff,user.id,bot,other,output,handoff,100+n);
  }
  db.prepare("INSERT INTO mcp_servers(id,user_id,config,tools,checked_at,created_at) VALUES(?,?,?,'[]',100,100)").run(`mcp-${i}`,user.id,JSON.stringify({name:`Fixture ${i} connection`,enabled:true,bearerToken:'FORBIDDEN_CREDENTIAL',headers:{},env:{}}));
}
for (const id of ['handoffs.list','loops.list','outputs.recent','connectors.status']) test(`${id} uses owned database rows and exposes only registered fields`,async()=>{
  const [a,b]=await Promise.all(fixture.users.map(user=>data.execute(user.id,{key:id,source:id,params:{}})));
  assert.ok(a.ok && b.ok,JSON.stringify([a,b]));if(!a.ok||!b.ok)return;
  assert.equal(a.available,true);assert.equal(b.available,true);
  assert.equal(a.count,id==='connectors.status'?1:12);assert.equal(b.count,id==='connectors.status'?1:2);
  assert.equal(a.rows!.length,id==='connectors.status'?1:10);
  assert.doesNotMatch(JSON.stringify(a),/Fixture 1|FORBIDDEN/);assert.doesNotMatch(JSON.stringify(b),/Fixture 0|FORBIDDEN/);
  const fields=SOURCES.find(s=>s.id===id)!.fields;
  for(const row of [...a.rows!,...b.rows!])assert.ok(Object.keys(row).every(key=>fields.includes(key)));
});
test('new Bot-scoped sources reject another account even with warm caches',async()=>{
  for(const source of ['handoffs.list','outputs.recent']) {
    const result=await data.execute(fixture.users[0].id,{key:source,source,params:{botId:`${fixture.users[1].id}-bot-0`}});
    assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,'not_found');
  }
});
test('email, calendar and CRM have honest unavailable states and 60 second cache',async()=>{
  let clock=100000;const cached=new DataExecutor(()=>clock);
  try{for(const source of ['email.recent','calendar.upcoming','crm.deals']){
    const request={key:source,source,params:{}};
    const first=await cached.execute(fixture.users[0].id,request);assert.ok(first.ok && first.available===false);if(first.ok)assert.deepEqual(first.rows,[]);
    clock+=59000;assert.deepEqual(await cached.execute(fixture.users[0].id,request),first);
    clock+=1001;assert.notEqual((await cached.execute(fixture.users[0].id,request)).fetchedAt,first.fetchedAt);
  }}finally{cached.close();}
});
