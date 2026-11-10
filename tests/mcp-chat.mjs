// Browser setup -> MCP discovery -> model tool -> approval -> actual MCP result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-mcp-chat-'));
const children=[], logs=[];let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function start(args,env={}){const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(p);p.stdout.on('data',d=>logs.push(String(d)));p.stderr.on('data',d=>logs.push(String(d)));return p;}
async function until(fn){for(let i=0;i<200;i++){const v=await fn();if(v)return v;await sleep(100);}throw new Error('Timed out');}
const apiPort=await port(), mockPort=await port(), mcpPort=await port();
const base=`http://127.0.0.1:${apiPort}`;
try{
 start(['tests/mock-provider.mjs',String(mockPort)]);start(['tests/fixtures/mcp-server.mjs',String(mcpPort)]);
 start(['--import','tsx','server/src/index.ts'],{DB_PATH:path.join(root,'app.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'mcp-test',COMPUTER_PROVIDER:'local',DEV_LOGIN:'1',PORT:String(apiPort),APP_URL:base,SERVER_URL:base,DIRECT_API_KEY:'mock-key',DIRECT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,OPENROUTER_API_KEY:'',COMPOSIO_API_KEY:'',LLM_PROVIDER:'direct',SWARM_NO_SCHEDULER:'1',WHATSAPP_DISABLED:'1',MEMORY_CONSOLIDATE_IDLE_MINUTES:'0',ADMIN_EMAILS:''});
 await until(()=>fetch(base+'/api/health').then(r=>r.ok).catch(()=>false));
 const login=await fetch(base+'/api/auth/dev',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'mcp-test@example.com'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 async function api(url,method='GET',body){const r=await fetch(base+'/api'+url,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.ok(r.ok,`${method} ${url}: ${r.status} ${text}`);return JSON.parse(text);}
 const chief=(await api('/bots')).bots.find(b=>b.isPrimary);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies([{name:'swarm_session',value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base+'/#settings/mcp');
 await page.getByRole('button',{name:'Add MCP server',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Research MCP');
 await page.getByLabel('Server URL',{exact:true}).fill(`http://127.0.0.1:${mcpPort}/mcp`);
 await page.getByText('Authentication & headers',{exact:true}).click();
 await page.getByLabel('Bearer token (optional)').fill('secret-fixture-token');
 await page.getByLabel('Custom headers (JSON, optional)').fill('{"X-Fixture":"header-secret"}');
 await page.getByRole('button',{name:'Save & test connection'}).click();
 const card=page.getByRole('region',{name:'Research MCP',exact:true});
 await card.getByText('Connection verified · 2 tools',{exact:true}).waitFor();
 await card.getByText('Available tools (2)',{exact:true}).click();await card.getByText('Echoes the supplied message.',{exact:true}).waitFor();
 await card.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('Agent access').selectOption('selected');
 await page.getByRole('group',{name:'Agents with access'}).getByRole('checkbox',{name:/Quinn/}).check();
 await page.getByRole('button',{name:'Save & test connection'}).click();
 await card.getByText('Remote HTTP · 1 selected agent',{exact:true}).waitFor();
 let server=(await api('/mcp/servers')).servers[0];assert.equal(server.hasBearerToken,true);
 await page.reload();await card.getByText('Connection verified · 2 tools',{exact:true}).waitFor();
 assert.ok(!await page.getByText('header-secret',{exact:true}).count());
 fs.mkdirSync('.context/shots',{recursive:true});await page.screenshot({path:'.context/shots/custom-mcp.png',animations:'disabled'});
 const tool=server.tools.find(t=>t.name==='echo').toolName;
 await page.getByRole('button',{name:'Back to Bots'}).click();
 async function send(text){return (await api(`/bots/${chief.id}/messages`,'POST',{text})).row;}
 async function after(seq){return (await api(`/bots/${chief.id}/rows`)).rows.filter(r=>r.seq>seq);}
 const message=await send(`mock: ${tool} {"message":"from agent chat"} | say Result: {last}`);
 await until(async()=>(await after(message.seq)).some(r=>r.body.card==='approval'&&r.body.status==='pending'));
 const approval=page.locator('.approval-card').filter({hasText:'use echo on Research MCP'});await approval.getByText('Research MCP',{exact:true}).waitFor();
 await approval.getByRole('button',{name:'Allow',exact:true}).click();
 const reply=await until(async()=>(await after(message.seq)).find(r=>r.body.role==='assistant'&&!r.body.streaming));assert.match(reply.body.text,/MCP says: from agent chat/);
 const requests=await (await fetch(`http://127.0.0.1:${mockPort}/_requests`)).json();assert.ok(JSON.stringify(requests).includes(tool));assert.ok(!JSON.stringify(requests).includes('secret-fixture-token'));
 // Revocation during an approval must prevent the pending call from executing.
 const pending=await send(`mock: ${tool} {"message":"must not run"} | say Result: {last}`);
 const pendingCard=await until(async()=>(await after(pending.seq)).find(r=>r.body.card==='approval'&&r.body.status==='pending'));
 await api('/mcp/servers/'+server.id,'PATCH',{enabled:false});await api('/approvals/'+pendingCard.body.approvalId,'POST',{decision:'allow'});
 const revoked=await until(async()=>(await after(pending.seq)).find(r=>r.body.role==='assistant'&&!r.body.streaming));assert.match(revoked.body.text,/no longer enabled/);
 // A fabricated operational MCP call from an onboarding agent stays blocked.
 const {bot:draft}=await api('/bots','POST',{name:'Draft'});await api('/mcp/servers/'+server.id,'PATCH',{enabled:true,botIds:null});
 const draftMessage=(await api(`/bots/${draft.id}/messages`,'POST',{text:`mock: ${tool} {"message":"not activated"} | say Done`})).row;
 await until(async()=>{const rows=(await api(`/bots/${draft.id}/rows`)).rows;return rows.some(r=>r.seq>draftMessage.seq&&r.body.name===tool&&r.body.status==='denied');});
 await page.goto(base+'/#settings/mcp');await card.getByRole('button',{name:'Remove',exact:true}).click();await card.getByRole('button',{name:'Remove server',exact:true}).click();await until(async()=>(await api('/mcp/servers')).servers.length===0);
 assert.deepEqual(errors,[]);console.log('PASS MCP browser: create, authenticated test, edit, reload, discovery, agent call, approval, immediate revocation, setup boundary and removal.');
}catch(e){console.error(logs.join('').slice(-10000));throw e;}finally{await browser?.close();for(const c of children)c.kill();await sleep(500);fs.rmSync(root,{recursive:true,force:true});}
