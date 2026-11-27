import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { seedDashboardData } from '../dashboard-fixture.mjs';

export async function agenticFixture() {
  const root = path.resolve(new URL('../../..', import.meta.url).pathname);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-agent-demo-'));
  async function port() { const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value; }
  const apiPort = await port(), uiPort = await port(), modelPort = await port(), scriptedPort = await port();
  const base = `http://127.0.0.1:${uiPort}`, api = `http://127.0.0.1:${apiPort}`, model = `http://127.0.0.1:${modelPort}`;
  const scripts = new Map(), answers = new Map();
  const scripted = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      if (req.method === 'POST' && req.url === '/v1/responses') {
        const body = JSON.parse(raw), user = [...(body.input ?? [])].reverse().find(item => item.role === 'user');
        if (user && typeof user.content === 'string' && answers.has(user.content)) {
          const spec = answers.get(user.content), outputs = (body.input ?? []).filter(item => item.type === 'function_call_output');
          let answer = outputs.length ? JSON.parse(outputs.at(-1).output) : null;
          // Model formatting uses live source values and omits internal record metadata.
          if (answer?.kind === 'list') answer.rows = answer.rows.map(row => ({ title: row.title, ...(row.status ? { status: ({ working: 'Working', needs_input: 'Needs input', done: 'Done' })[row.status] ?? row.status } : {}) }));
          if (answer?.kind === 'text' && spec.source === 'tasks_counts') answer = { kind: 'stat', value: String(JSON.parse(answer.text).total), label: 'Tasks' };
          if (answer && spec.actions && answer.kind === 'list') answer.rows = answer.rows.slice(0, 3).map((row, i) => ({ ...row, action: i === 0 ? { type: 'open', route: '#tasks' } : i === 1 ? { type: 'send', botId: spec.botId, text: `Draft next steps for ${row.title}.` } : { type: 'approve', itemId: spec.approvalId } }));
          user.content = `mock-delay:300\nmock: read_${spec.source} {} | say ${JSON.stringify(answer)}`;
        } else if (user && typeof user.content === 'string' && scripts.has(user.content)) user.content = scripts.get(user.content);
        else if (user && Array.isArray(user.content)) for (const item of user.content) if (scripts.has(item.text)) item.text = scripts.get(item.text);
        raw = JSON.stringify(body);
      }
      const response = await fetch(model + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' }, ...(req.method === 'POST' ? { body: raw } : {}) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      for await (const part of response.body) res.write(part); res.end();
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  scripted.listen(scriptedPort, '127.0.0.1'); await once(scripted, 'listening');
  const fixtureFile = path.join(temp, 'fixture.json');
  // Same seed and isolated credential policy as tests/layout-fixture.mjs.
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', PHONE_QA_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'ui-agent-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `http://127.0.0.1:${scriptedPort}/v1`, DIRECT_MODEL: 'gpt-4.1' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input);if(['localhost','127.0.0.1'].includes(u.hostname))return local(input,init);return Promise.resolve(Response.json({data:[],items:[]}));};`);
  const children = [], logs = [];
  const entry = path.join(temp, 'dashboard-entry.mts');
  fs.writeFileSync(entry, `import ${JSON.stringify(path.join(root,'server/src/index.ts'))};
import {createBot} from ${JSON.stringify(path.join(root,'server/src/bots.ts'))};
import {createCliPairing,selectCli} from ${JSON.stringify(path.join(root,'server/src/cli/store.ts'))};
import {refreshCli} from ${JSON.stringify(path.join(root,'server/src/cli/bridge.ts'))};
import {platformState} from ${JSON.stringify(path.join(root,'server/src/agent/platform-state.ts'))};
process.on('message',async ({id,op,userId,botId})=>{try {let result;
if(op==='bot')result=createBot(userId,{name:'Coordinator',isPrimary:true});
if(op==='pair')result=createCliPairing(userId);
if(op==='meter'){await refreshCli(userId);selectCli(userId,'claude');await platformState(userId,botId);result=true;}
process.send?.({id,result});}catch(error){process.send?.({id,error:String(error)});}});`);
  const viteEntry = path.join(temp, 'dashboard-vite.mjs');
  fs.writeFileSync(viteEntry, `import {createServer} from ${JSON.stringify(path.join(root,'web/node_modules/vite/dist/node/index.js'))};
const server=await createServer({root:${JSON.stringify(path.join(root,'web'))},cacheDir:${JSON.stringify(path.join(temp,'vite-cache'))},server:{host:'127.0.0.1',port:${uiPort},strictPort:true}});
await server.listen();`);
  const start = (args, cwd = root, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  const ready = async (url, child) => { for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Fixture did not start: ${logs.join('')}`); };
  const close = async () => { scripted.closeAllConnections(); await new Promise(resolve => scripted.close(resolve)); for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit'))); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    await ready(`${model}/_requests`, start(['tests/mock-provider.mjs', String(modelPort)]));
    const seed = start(['--import', preload, '--import', 'tsx', 'tests/fixtures/layout.seed.mts']);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    const child = start(['--import', preload, '--import', 'tsx', entry]);
    await ready(`${api}/api/health`, child);
    await ready(base, start([viteEntry], path.join(root, 'web'), { SWARM_API: api }));
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const db = new Database(env.DB_PATH);
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    let controlId = 0, accountId = 0; const contexts = [], sockets = [], transcript = [];
    const control = input => new Promise((resolve, reject) => {
      const id = ++controlId, timer = setTimeout(() => { child.off('message', receive); reject(new Error('Fixture control timed out')); }, 10000);
      const receive = message => { if (message.id === id) { clearTimeout(timer); child.off('message', receive); message.error ? reject(new Error(message.error)) : resolve(message.result); } };
      child.on('message', receive); child.send({ id, ...input });
    });
    const request = async (account, method, route, input, revision) => {
      const response = await fetch(`${api}/api${route}`, { method, headers: { cookie: `swarm_session=${account.token}`, origin: base, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() };
    };
    const wait = async condition => { for (let n=0;n<300;n++) { const value=await condition(); if(value)return value; await new Promise(resolve=>setTimeout(resolve,100)); } throw new Error(`Fixture timed out: ${logs.slice(-10).join('')}`); };
    return { base, api, model, scripts, answers, db, logs, browser, transcript, request, wait,
      async account({ bot = false } = {}) {
        const userId = `qa-temp-dashboard-${++accountId}`, token = `fixture-session-${accountId}`, at=Date.now();
        db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,'Alex Example',at);
        db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),userId,at,at+3600000);
        return { userId, token, ...(bot ? { bot: await control({op:'bot',userId}) } : {}) };
      },
      async page(account, width=1280) {
        const context=await browser.newContext({ viewport:{width,height:width <= 760 ? 844 : 900},reducedMotion:'reduce',colorScheme:'light' }); contexts.push(context);
        await context.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
        await context.addCookies([{name:'swarm_session',value:account.token,url:base}]);
        const page=await context.newPage(); page.setDefaultTimeout(15000); await page.goto(`${base}/#bots`);
        await page.locator('.shell-header').waitFor();
        await page.waitForFunction(async ()=>(await import('/src/customization/store.ts')).useCustomization.getState().status==='ready');
        return page;
      },
      seed(account) {
        seedDashboardData(db, account);
        const names = ['Draft the launch email', 'Acme renewal', 'Review the launch plan', 'Daily summary'];
        const tasks = db.prepare('SELECT id FROM tasks WHERE bot_id=? ORDER BY id').all(account.bot.id);
        tasks.forEach((task, i) => db.prepare('UPDATE tasks SET title=? WHERE id=?').run(names[i % names.length], task.id));
        db.prepare('DELETE FROM usage_events WHERE user_id=?').run(account.userId);
        db.prepare('UPDATE routines SET name=? WHERE bot_id=?').run('Daily summary', account.bot.id);
        db.prepare("DELETE FROM rows WHERE bot_id=? AND kind='card'").run(account.bot.id);
      },
      seedApproval(account) {
        const id = `approval-${account.userId}`, row = db.prepare('SELECT next_seq,generation FROM bots WHERE id=?').get(account.bot.id), at = Date.now();
        db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run(account.bot.id,row.generation,row.next_seq,row.next_seq,'card',JSON.stringify({type:'card',card:'approval',approvalId:id,status:'pending',tool:'save_file',title:'Approve the launch plan',args:{path:'launch-plan.txt',content:'Launch plan'}}),at);
        db.prepare('UPDATE bots SET next_seq=next_seq+1,rev=rev+1 WHERE id=?').run(account.bot.id);
        db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id,account.bot.id,row.next_seq,id,'save_file','pending',at);
        return `approval:${id}`;
      },
      async seedMeter(account) {
        const token=await control({op:'pair',userId:account.userId});
        const socket=new WebSocket(`${api.replace('http:','ws:')}/api/cli-bridge`); sockets.push(socket);
        socket.on('message',raw=>{const message=JSON.parse(String(raw)); if(!message.id)return;
          socket.send(JSON.stringify({id:message.id,result:message.method==='status' ? {claude:{installed:true,authenticated:true,subscription:true},codex:{installed:false,authenticated:false,subscription:false}} : {models:[],defaultModel:null,plan:null,usage:{available:true,checkedAt:Date.now(),windows:[{label:'Fixture weekly limit',usedPercent:37,resetsAt:null}]}}}));
        });
        await once(socket,'open'); socket.send(JSON.stringify({type:'hello',version:1,codexExecOnly:true,token,device:'QA-Temp-Fixture'}));
        await new Promise(resolve=>setTimeout(resolve,100)); await control({op:'meter',userId:account.userId,botId:account.bot.id});
      },
      async propose(account, tool, args, chat, goal = 'Create a dashboard for my work.') {
        const before=db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM rows WHERE bot_id=?").get(account.bot.id).seq;
        const text = goal; scripts.set(goal, `mock: ${tool} ${JSON.stringify(args)} | say Review this dashboard change.`);
        if (chat) { await chat.locator('.composer__input:not([disabled])').fill(text); await chat.getByRole('button',{name:'Send',exact:true}).click(); }
        else { const sent=await request(account,'POST',`/bots/${account.bot.id}/messages`,{text}); assert.equal(sent.status,200,JSON.stringify(sent)); }
        const row=await wait(()=>db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND seq>? AND kind='card' AND json_extract(body,'$.card')='ui_preview' ORDER BY seq DESC LIMIT 1").get(account.bot.id,before));
        const card=JSON.parse(row.body);
        await wait(()=>db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(card.jobId)?.state==='completed');
        const calls=db.prepare("SELECT body FROM rows WHERE bot_id=? AND seq>? AND kind='tool-call'").all(account.bot.id,before).map(row=>JSON.parse(row.body));
        assert.ok(calls.some(call=>call.name===tool),`registered ${tool} executed`);
        const preview=(await request(account,'GET',`/ui/previews/${card.previewId}`)).body;
        transcript.push({tool,args,card,calls}); return {card,preview};
      },
      async apply(account, card) {
        const config=(await request(account,'GET','/ui/config')).body;
        const applied=await request(account,'POST',`/ui/previews/${card.previewId}/apply`,{},config.revision);
        assert.equal(applied.status,200,JSON.stringify(applied)); return (await request(account,'GET','/ui/config')).body;
      },
      close: async () => { for(const socket of sockets) socket.terminate(); for(const context of contexts) await context.close(); await browser.close(); db.close(); await close(); },
    };
  } catch (error) { await close(); throw error; }
}
