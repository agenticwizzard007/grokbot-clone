// Full HTTP server → hosted PTY or standalone bridge → fake CLI → Bot chat, without live credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cli-chat-'));
const children = [];
let logs = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await new Promise((resolve) => {
  const server = http.createServer().listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
});
const base = `http://127.0.0.1:${port}`;
function start(args, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  return child;
}
async function until(fn) {
  for (let n = 0; n < 150; n++) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error('Timed out waiting for CLI integration.');
}

try {
  const cli = path.join(root, 'fake-cli.mjs');
  await fs.writeFile(cli, `#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'})); process.exit(0); }
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) {
 let r; try {r=JSON.parse(line);} catch {}
 const method=r?.method??r?.request?.subtype;
 if (!method) {prompt+=line+'\\n';continue;}
 const codex=args[0]==='app-server';
 const reply=value=>console.log(JSON.stringify(codex?{id:r.id,result:value}:{type:'control_response',response:{subtype:'success',request_id:r.request_id,response:value}}));
 if(method==='initialize')reply(codex?{}:{account:{subscriptionType:'max'},models:['account-vision','account-alternate'].map(value=>({value,displayName:value,supportsEffort:true,supportedEffortLevels:['low','high']}))});
 if(method==='account/read')reply({account:{type:'chatgpt',planType:'pro'}});
 if(method==='model/list')reply({data:['account-vision','account-alternate'].map((model,i)=>({model,displayName:model,isDefault:i===0,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low'})),nextCursor:null});
 if(method==='account/rateLimits/read')reply({rateLimits:{primary:{usedPercent:19,windowDurationMins:300}}});
 if(method==='get_usage')reply({subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:23,resets_at:null}}});
}
fs.appendFileSync(${JSON.stringify(path.join(root, 'generations.jsonl'))}, JSON.stringify({args})+'\\n');
const reply = {text:'Subscription bridge integration reply.',tool_calls:[]};
if (args[0] === 'exec') {
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify(reply));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:42,output_tokens:8}}));
} else console.log(JSON.stringify({type:'result',subtype:'success',structured_output:reply,usage:{input_tokens:42,output_tokens:8}}));
`, { mode: 0o700 });
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_CLI_CODEX_PATH: cli, SWARM_CLI_CLAUDE_PATH: cli,
    DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'isolated-cli-chat-test',
    COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(port), APP_URL: base, SERVER_URL: base,
    DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', COMPOSIO_API_KEY: '', INKBOX_API_KEY: '', INKBOX_ADMIN_API_KEY: '',
    DIRECT_BASE_URL: 'http://127.0.0.1:1/v1', OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1',
    SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
  });
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok, () => false));
  const script = await fetch(`${base}/api/cli/script`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /export async function startBridge/);
  assert.equal((await fetch(`${base}/api/cli`)).status, 401);
  const login = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'cli-e2e@example.com' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().filter(value => value.startsWith('swarm_session=')).at(-1)?.split(';')[0];
  assert.ok(cookie, 'login issues a session cookie after clearing the previous session');
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(base + '/api' + url, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  };
  const pair = await api('/cli/pair', 'POST');
  const token = pair.command.match(/--token '([^']+)'/)?.[1];
  assert.ok(token);
  start(['companion/cli-bridge.mjs', '--server', base, '--token', token, '--codex-path', cli, '--claude-path', cli]);
  await until(async () => { const s = await api('/cli'); return s.connected && s.providers.codex.subscription && s.providers.claude.subscription; });
  const bot = (await api('/bots')).bots.find((b) => b.isPrimary);
  for (const provider of ['codex', 'claude']) {
    const selected = await api('/cli', 'PUT', { provider });
    assert.equal(selected.selected, provider);
    const catalog=await api('/models');assert.equal(catalog.billing,'plan');assert.equal(catalog.models.length,2);
    for (const model of catalog.models) {
      await api(`/bots/${bot.id}`,'PATCH',{model:model.id,effort:'high'});
      const sent = (await api(`/bots/${bot.id}/messages`, 'POST', { text: `Reply through ${model.id}.` })).row;
      const reply = await until(async () => (await api(`/bots/${bot.id}/rows`)).rows.find((r) => r.seq > sent.seq && r.body.role === 'assistant' && !r.body.streaming));
      assert.equal(reply.body.text, 'Subscription bridge integration reply.');
    }
  }
  const report = await api('/usage?range=today');
  assert.equal(report.totals.costUsd, 0);
  assert.ok(report.totals.requests >= 2);
  const revoked = await api('/cli/pair', 'DELETE');
  assert.equal(revoked.connected, false);
  assert.equal(revoked.selected, 'claude');
  const blocked = await api(`/bots/${bot.id}/messages`, 'POST', { text: 'This must remain blocked, not switch to an API.' });
  await until(async () => (await api(`/bots/${bot.id}/rows`)).rows.some((r) => r.seq > blocked.row.seq && /CLI bridge is offline/.test(JSON.stringify(r.body))));
  for (const provider of ['codex', 'claude']) {
    const terminal = await api('/cli/login', 'POST', { provider, cols: 90, rows: 25 });
    await until(async () => {
      const current = await api(`/cli/login/${terminal.id}`);
      if (current.state === 'failed') throw new Error(current.error);
      return current.state === 'connected';
    });
    const status = await api('/cli');
    assert.equal(status.runtime, 'server');
    assert.equal(status.selected, provider);
    assert.equal(status.providers[provider].subscription, true);
    const catalog=await api('/models');assert.equal(catalog.billing,'plan');assert.equal(catalog.models.length,2);
    for (const model of catalog.models) {
      await api(`/bots/${bot.id}`,'PATCH',{model:model.id,effort:'high'});
      const sent = (await api(`/bots/${bot.id}/messages`, 'POST', { text: `Hosted ${model.id} reply.` })).row;
      const reply = await until(async () => (await api(`/bots/${bot.id}/rows`)).rows.find((r) => r.seq > sent.seq && r.body.role === 'assistant' && !r.body.streaming));
      assert.equal(reply.body.text, 'Subscription bridge integration reply.');
    }
  }
  assert.equal((await fs.readdir(path.join(root, 'cli-profiles'))).length, 1);
  const disconnected = await api('/cli/pair', 'DELETE');
  assert.equal(disconnected.runtime, 'server');
  assert.equal(disconnected.selected, 'claude');
  assert.equal(disconnected.connected, false);
  assert.deepEqual(await fs.readdir(path.join(root, 'cli-profiles')), []);
  const generations=(await fs.readFile(path.join(root,'generations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const model of ['account-vision','account-alternate']) assert.equal(generations.filter(g=>g.args[g.args.indexOf('--model')+1]===model).length,4,'each discovered model is used by both providers through both runtimes');
  for(const {args} of generations) assert.ok(args.includes('--effort') ? args[args.indexOf('--effort')+1]==='high' : args.includes('model_reasoning_effort="high"'));
  console.log('PASS: actual catalog selections/efforts across both hosted login terminals and bridge CLIs, Bot chat, subscription accounting, offline no-fallback behavior, and hosted profile deletion.');
} catch (error) {
  console.error(logs.slice(-5000));
  throw error;
} finally {
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exitCode !== null ? null : new Promise((resolve) => child.once('exit', resolve))));
  await fs.rm(root, { recursive: true, force: true });
}
