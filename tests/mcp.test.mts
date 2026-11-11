import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-mcp-'));
process.env.APP_URL = 'https://preview.example.com';
Object.assign(process.env,{ DB_PATH:path.join(root,'test.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'mcp-isolated-tests',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',ADMIN_EMAILS:'',DIRECT_API_KEY:'parent-secret-not-for-children' });
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
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,authenticated_at) VALUES (session_hash(?),?,?,?,?)').run(id,id,Date.now(),Date.now()+60000,Date.now());
}
const chief=createBot('owner',{name:'Chief',isPrimary:true});
const excluded=createBot('owner',{name:'Excluded',isPrimary:true});
const foreign=createBot('other',{name:'Foreign',isPrimary:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1'); await once(listener,'listening');
const port=(listener.address() as net.AddressInfo).port; await new Promise<void>(r=>listener.close(()=>r()));
const fixture=spawn(process.execPath,['tests/fixtures/mcp-server.mjs',String(port)],{stdio:'ignore'});
const base=`http://127.0.0.1:${port}`;
for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{} await new Promise(r=>setTimeout(r,50));}
const req=(route='',method='GET',body?:unknown,user='owner')=>app.request('/api/mcp/servers'+route,{method,headers:{cookie:'swarm_session='+user,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
// The fixture fetch rewrites an already-validated public HTTPS URL only inside this test process.
// Production transport address validation remains enabled; SSRF tests exercise its actual connector separately.
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
 const request = new Request(input, init), url = new URL(request.url);
 if (url.hostname !== 'mcp-fixture.example') return realFetch(input, init);
 return realFetch(base + url.pathname + url.search, { method: request.method, headers: request.headers, body: ['GET','HEAD'].includes(request.method) ? undefined : request.body, signal: request.signal, duplex: 'half' } as RequestInit);
});
const remote=(transport='http')=>({name:'Fixture',transport,url:'https://mcp-fixture.example'+(transport==='sse'?'/sse':'/mcp'),bearerToken:'secret-fixture-token',headers:{'X-Fixture':'header-secret'},botIds:[chief.id]});
after(async()=>{await closeMcpSessions();mock.restoreAll();fixture.kill();await once(fixture,'exit');db.close();fs.rmSync(root,{recursive:true,force:true});});

test('signed-in owners manage only their own MCP connections',async()=>{
 const originRequest = (origin: string) => app.request('/api/mcp/servers', { method: 'POST', headers: { cookie: 'swarm_session=owner', 'content-type': 'application/json', origin }, body: JSON.stringify(remote()) });
 assert.equal((await originRequest('https://preview.example.com')).status, 201);
 assert.equal((await originRequest('https://untrusted.example.com')).status, 403);
 assert.equal((await req('','GET',undefined,'invalid')).status,401);
 const ownOther = await req('','POST',{...remote(),botIds:[]},'other');assert.equal(ownOther.status,201);const otherId=(await ownOther.json() as any).server.id;await req('/'+otherId,'DELETE',undefined,'other');
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
 assert.equal((await req('/'+server.id,'DELETE',undefined,'other')).status,404);
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
 assert.equal(policyFor('owner',name,{},chief.id).decision,'ask');
 db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run('owner',`${name}:bot:${chief.id}`);
 assert.equal(policyFor('owner',name,{},chief.id).decision,'allow');
 saveMcpServer('owner',{enabled:false},tested);
 assert.equal(policyFor('owner',name,{},chief.id).decision,'block');
 await assert.rejects(runMcpTool('owner',chief.id,name,{}),/no longer enabled/);
 const changed=saveMcpServer('owner',{enabled:true,url:'https://mcp-fixture.example/different'},getMcpServer('owner',server.id));
 assert.equal(changed.tools.length,0);assert.notEqual(mcpToolName(changed,'echo'),name);
});

test('local stdio requires an isolated runner and cannot execute on the application server',async()=>{
 const marker=path.join(root,'unexpected-execution');
 const s=saveMcpServer('owner',{name:'Local',transport:'stdio',command:'/usr/bin/touch',args:[marker],env:{MCP_FIXTURE_VALUE:'local-value'}});
 const tested=(await testMcpServer(s))!;assert.match(tested.error!,/isolated|Isolated/);
 assert.equal(fs.existsSync(marker),false);
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

test('folder picker exposes only owned Library folders and rejects foreign, missing and symlink paths identically', async () => {
 const files=path.join(root,'files');
 for(const bot of [chief,foreign])fs.mkdirSync(path.join(files,bot.id,'documents'),{recursive:true});
 fs.mkdirSync(path.join(root,'credentials'));fs.symlinkSync(path.join(root,'credentials'),path.join(files,chief.id,'escape'));
 const listed=await (await req('/folders')).json() as any;
 assert.ok(listed.folders.some((f:any)=>f.path===chief.id));assert.ok(!listed.folders.some((f:any)=>f.path===foreign.id));
 const children=await (await req('/folders?path='+chief.id)).json() as any;
 assert.deepEqual(children.folders,[{path:chief.id+'/documents',name:'documents'}]);
 const foreignResult=await req('/folders?path='+foreign.id);
 const missingResult=await req('/folders?path=unknown');
 assert.equal(foreignResult.status,404);assert.deepEqual(await foreignResult.json(),await missingResult.json());
 for(const location of [chief.id+'/escape',chief.id+'/../'+foreign.id,'/data',foreign.id+'/documents']) {
  assert.equal((await req('/folders?path='+encodeURIComponent(location))).status,404);
  assert.equal((await req('','POST',{name:'Forbidden folders',transport:'stdio',command:'server',folders:[location]})).status,400);
 }
});

test('explicit folder grants default to empty, are redacted to relative paths, and changes invalidate tools and old approvals', async () => {
 const input={name:'Shared files',transport:'stdio',command:'server',folders:[chief.id+'/documents']};
 const created=await req('','POST',input);assert.equal(created.status,201);
 const {server}=await created.json() as any;
 assert.deepEqual(server.folders,input.folders);assert.ok(!JSON.stringify(server).includes(root));
 let saved=getMcpServer('owner',server.id)!;
 db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{name:'read',inputSchema:{type:'object'}}]),server.id);
 saved=getMcpServer('owner',server.id)!;
 const oldName=mcpToolName(saved,'read');
 const removed=await req('/'+server.id,'PATCH',{folders:[]});assert.equal(removed.status,200);
 const current=getMcpServer('owner',server.id)!;
 assert.deepEqual(current.config.folders,[]);assert.deepEqual(current.tools,[]);assert.equal(current.revision,saved.revision+1);
 assert.notEqual(mcpToolName(current,'read'),oldName);
 assert.throws(()=>saveMcpServer('owner',{folders:input.folders},saved),/changed/);
 assert.equal((await req('','POST',{...remote(),folders:input.folders})).status,400);
 const empty=saveMcpServer('owner',{name:'No grant',transport:'stdio',command:'server'});assert.deepEqual(empty.config.folders,[]);
 await req('/'+server.id,'DELETE');
});

test('expired recent authentication cannot replace MCP credentials or grant folders', async () => {
 const server=saveMcpServer('owner',remote());
 db.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now()-11*60_000,'owner');
 try {
  for(const input of [{bearerToken:'replacement'}, {headers:{Authorization:'new'}}, {env:{TOKEN:'new'}}, {folders:[]}]) {
   const response=await req('/'+server.id,'PATCH',input);
   assert.equal(response.status,401);assert.equal((await response.json() as any).code,'reauth_required');
  }
  assert.equal((await req('/'+server.id,'PATCH',{name:'Harmless rename'})).status,200);
  assert.equal(getMcpServer('owner',server.id)!.config.bearerToken,'secret-fixture-token');
 }finally{db.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now(),'owner');}
});

test('session revocation while reading a configuration body prevents credential and folder writes', async () => {
 const server=saveMcpServer('owner',remote()),original=getMcpServer('owner',server.id)!;
 let release!:(chunk:Uint8Array)=>void,reading!:()=>void;
 const entered=new Promise<void>(done=>{reading=done;});
 const stream=new ReadableStream<Uint8Array>({start(controller){release=chunk=>{controller.enqueue(chunk);controller.close();};},pull(){reading();}});
 const pending=app.request('/api/mcp/servers/'+server.id,{method:'PATCH',headers:{cookie:'swarm_session=owner','content-type':'application/json'},body:stream,duplex:'half'} as any);
 await entered; await new Promise(done=>setTimeout(done,5));
 db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run('owner');
 release(Buffer.from(JSON.stringify({bearerToken:'revoked-write'})));
 assert.equal((await pending).status,401);assert.equal(getMcpServer('owner',server.id)!.revision,original.revision);
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,authenticated_at) VALUES (session_hash(?),?,?,?,?)').run('owner','owner',Date.now(),Date.now()+60000,Date.now());
});
