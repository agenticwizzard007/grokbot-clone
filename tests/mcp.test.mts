import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'grokbot-mcp-'));
process.env.APP_URL = 'https://preview.example.com';
Object.assign(process.env,{ DB_PATH:path.join(root,'test.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'mcp-isolated-tests',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',ADMIN_EMAILS:'',XAI_API_KEY:'parent-secret-not-for-children' });
const { db }=await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents }=await import('../server/src/agent/subagents.js'); initSubagents();
const { initRooms }=await import('../server/src/agent/rooms.js'); initRooms();
const { createBot }=await import('../server/src/bots.js');
const { mcpApi }=await import('../server/src/mcp/routes.js');
const { saveMcpServer,getMcpServer,mcpServerView,mcpToolName }=await import('../server/src/mcp/store.js');
const { testMcpServer,mcpSchemas,runMcpTool,closeMcpSessions }=await import('../server/src/mcp/client.js');
const { policyFor }=await import('../server/src/agent/tools.js');
const { Hono }=await import('hono');
const app=new Hono().route('/api/mcp/servers',mcpApi);
for(const id of ['owner','other']) {
 db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id,id+'@example.com',id,Date.now());
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(id,id,Date.now(),Date.now()+60000);
}
const chief=createBot('owner',{name:'Chief',isPrimary:true});
const excluded=createBot('owner',{name:'Excluded',isPrimary:true});
const foreign=createBot('other',{name:'Foreign',isPrimary:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1'); await once(listener,'listening');
const port=(listener.address() as net.AddressInfo).port; await new Promise<void>(r=>listener.close(()=>r()));
const fixture=spawn(process.execPath,['tests/fixtures/mcp-server.mjs',String(port)],{stdio:'ignore'});
const base=`http://127.0.0.1:${port}`;
for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{} await new Promise(r=>setTimeout(r,50));}
const req=(route='',method='GET',body?:unknown,user='owner')=>app.request('/api/mcp/servers'+route,{method,headers:{cookie:'grokbot_session='+user,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const remote=(transport='http')=>({name:'Fixture',transport,url:base+(transport==='sse'?'/sse':'/mcp'),bearerToken:'secret-fixture-token',headers:{'X-Fixture':'header-secret'},botIds:[chief.id]});
after(async()=>{await closeMcpSessions();fixture.kill();await once(fixture,'exit');db.close();fs.rmSync(root,{recursive:true,force:true});});

test('owner-only mutation, authentication, validation and tenant isolation',async()=>{
 const originRequest = (origin: string) => app.request('/api/mcp/servers', { method: 'POST', headers: { cookie: 'grokbot_session=owner', 'content-type': 'application/json', origin }, body: JSON.stringify(remote()) });
 assert.equal((await originRequest('https://preview.example.com')).status, 201);
 assert.equal((await originRequest('https://untrusted.example.com')).status, 403);
 assert.equal((await req('','GET',undefined,'invalid')).status,401);
 assert.equal((await req('','POST',remote(),'other')).status,403);
 assert.equal((await req('','POST',{...remote(),botIds:[foreign.id]})).status,400);
 assert.equal((await req('','POST',{...remote(),url:'file:///etc/passwd'})).status,400);
 assert.equal((await req('','POST',{...remote(),headers:{Host:'other'}})).status,400);
 const r=await req('','POST',remote());assert.equal(r.status,201);
 const {server}=await r.json() as any;
 assert.equal(server.hasBearerToken,true);assert.deepEqual(server.headerNames,['X-Fixture']);
 assert.ok(!JSON.stringify(server).includes('secret-fixture-token'));assert.ok(!JSON.stringify(server).includes('header-secret'));
 assert.equal((await req('','GET',undefined,'other')).status,200);
 assert.deepEqual((await (await req('','GET',undefined,'other')).json() as any).servers,[]);
 const update=await req('/'+server.id,'PATCH',{name:'Renamed'});assert.equal(update.status,200);
 assert.equal(getMcpServer('owner',server.id)!.config.bearerToken,'secret-fixture-token');
 assert.equal((await req('/'+server.id,'DELETE',undefined,'other')).status,403);
});
for(const transport of ['http','sse'] as const) test(`${transport}: initialization, paginated discovery, credentials, tool execution, redacted errors`,async()=>{
 const server=saveMcpServer('owner',remote(transport));
 const tested=(await testMcpServer(server))!;assert.equal(tested.error,null);assert.equal(tested.tools.length,2);
 const name=mcpToolName(tested,'echo');
 assert.ok(mcpSchemas('owner',chief.id).some(t=>t.name===name));
 assert.ok(!mcpSchemas('owner',excluded.id).some(t=>t.name===name));
 const result=await runMcpTool('owner',chief.id,name,{message:'hello'});assert.match(JSON.stringify(result.output),/MCP says: hello/);
 await assert.rejects(runMcpTool('owner',excluded.id,name,{}),/no longer enabled/);
 await assert.rejects(runMcpTool('other',foreign.id,name,{}),/no longer enabled/);
 await assert.rejects(runMcpTool('owner',chief.id,mcpToolName(tested,'fail'),{}),e=>{assert.ok(String(e).includes('[redacted]'));assert.ok(!String(e).includes('secret-fixture-token'));return true;});
 assert.equal(policyFor('owner',name,{}).decision,'ask');
 db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run('owner',name);
 assert.equal(policyFor('owner',name,{}).decision,'allow');
 saveMcpServer('owner',{enabled:false},tested);
 assert.equal(policyFor('owner',name,{}).decision,'block');
 await assert.rejects(runMcpTool('owner',chief.id,name,{}),/no longer enabled/);
 const changed=saveMcpServer('owner',{enabled:true,url:base+'/different'},getMcpServer('owner',server.id));
 assert.equal(changed.tools.length,0);assert.notEqual(mcpToolName(changed,'echo'),name);
});

test('local stdio uses explicit environment without inheriting app API keys',async()=>{
 const s=saveMcpServer('owner',{name:'Local',transport:'stdio',command:process.execPath,args:[path.resolve('tests/fixtures/mcp-server.mjs'),'stdio'],env:{MCP_FIXTURE_VALUE:'local-value'}});
 const tested=(await testMcpServer(s))!;assert.equal(tested.error,null);
 const result=await runMcpTool('owner',chief.id,mcpToolName(tested,'echo'),{message:'local'});
 assert.match(JSON.stringify(result.output),/env=local-value; inherited=false/);
 assert.deepEqual(mcpServerView(tested).envNames,['MCP_FIXTURE_VALUE']);
});

test('failed connection is visible and never advertised as verified',async()=>{
 const s=saveMcpServer('owner',{...remote(),bearerToken:'wrong'});
 const result=await (await req('/'+s.id+'/test','POST')).json() as any;
 assert.ok(result.server.error);assert.equal(result.server.tools.length,0);
 const local=saveMcpServer('owner',{name:'Missing',transport:'stdio',command:'/missing-mcp-command'});
 assert.ok((await testMcpServer(local))!.error);
 await req('/'+s.id,'DELETE');assert.equal(getMcpServer('owner',s.id),undefined);
});
