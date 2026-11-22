// node --import tsx --test --test-concurrency=1 tests/cli-concurrency.test.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-concurrency-'));
const apiRequests: string[] = [];
const server = createServer((req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unexpected paid API request' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'cli-concurrency-test-only',
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'configured-direct-test-key', DIRECT_BASE_URL: `${base}/direct`, DIRECT_MODEL: 'api-control-model',
  OPENROUTER_API_KEY: 'configured-openrouter-test-key', OPENROUTER_BASE_URL: `${base}/openrouter`, LLM_PROVIDER: 'direct',
});

// Every application import comes after the isolated DB and provider environment.
const { db } = await import('../server/src/db.js');
const { initSubagents, createSubagent, listSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/src/routes.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { attachCliSocket, disconnectCli, refreshCli } = await import('../server/src/cli/bridge.js');
const { selectedCli } = await import('../server/src/cli/store.js');
const { sessionHash } = await import('../server/src/lib/auth.js');
const { createBot } = await import('../server/src/bots.js');
const { enqueue, runInBotQueue, interrupt } = await import('../server/src/agent/loop.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { getLive, listRows, loadHistory } = await import('../server/src/store.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { toolSchemaHash } = await import('../server/src/agent/tool-catalog.js');
const { listInternalRequests, drainInternalRequests } = await import('../server/src/coordination/index.js');
attachCliSocket(server);
const app = new Hono().route('/api/cli', cliApi).route('/api', api);

type Provider = 'codex' | 'claude';
type Rpc = { id: string; method: 'status' | 'generate' | 'cancel'; params?: any; type?: string; callId?: string; result?: { output: string; isError?: boolean }; error?: string };
type Job = { id: string; user_id: string; bot_id: string; trigger: string; state: string; started_at: number | null; finished_at: number | null };
let owner: string, cookie: string, sequence = 0;
const bots = new Set<string>();
const bridges = new Set<HeldBridge>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jobs = () => db.prepare('SELECT * FROM agent_jobs WHERE user_id=? ORDER BY created_at,rowid').all(owner) as Job[];
const jobFor = (text: string) => jobs().find(job => JSON.parse(job.trigger).text === text)!;
const usage = () => db.prepare('SELECT * FROM usage_events WHERE user_id=?').all(owner) as any[];

async function until(check: () => boolean, description: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), `${description}; durable states: ${JSON.stringify(jobs().map(job => job.state))}`);
}
function request(url: string, method = 'GET', body?: unknown) {
  return app.request(`/api${url}`, {
    method, headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function newBot(name: string) {
  const bot = createBot(owner, { name, isPrimary: true, model: 'api/model-that-must-not-run' });
  bots.add(bot.id);
  return bot;
}
async function message(botId: string, text: string) {
  const response = await request(`/bots/${botId}/messages`, 'POST', { text });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).row.botId, botId);
}
function conversation(rpc: Rpc): any[] {
  const marker = '\n\nConversation:\n';
  const offset = rpc.params.prompt.indexOf(marker);
  assert.ok(offset >= 0, 'bridge receives the real Responses adapter prompt');
  return JSON.parse(rpc.params.prompt.slice(offset + marker.length));
}
function lastUserText(rpc: Rpc): string {
  return conversation(rpc).filter(item => item.role === 'user').at(-1)?.content;
}

class HeldBridge {
  ws = new WebSocket(base.replace('http:', 'ws:') + '/api/cli-bridge');
  closed = new Promise<void>(resolve => this.ws.once('close', () => resolve()));
  welcome = false;
  automatic = false;
  requests: Rpc[] = [];
  held = new Map<string, Rpc>();
  cancelled: string[] = [];
  constructor() {
    bridges.add(this);
    this.ws.on('error', () => {});
    this.ws.on('message', raw => {
      const rpc = JSON.parse(raw.toString());
      if (rpc.type === 'welcome') { this.welcome = true; return; }
      this.requests.push(rpc);
      if (rpc.method === 'status') this.ws.send(JSON.stringify({ id: rpc.id, result: {
        codex: { installed: true, authenticated: true, subscription: true },
        claude: { installed: true, authenticated: true, subscription: true },
      } }));
      if (rpc.method === 'generate') {
        this.held.set(rpc.id, rpc);
        if (this.automatic) this.finish(rpc, `cleanup ${lastUserText(rpc)}`);
      }
      if (rpc.method === 'cancel') {
        this.cancelled.push(rpc.id);
        this.held.delete(rpc.id);
      }
    });
  }
  get generations() { return this.requests.filter(rpc => rpc.method === 'generate'); }
  async tool(rpc: Rpc, name: string, args: Record<string, unknown>) {
    const tool = toolMap.get(name)!;
    const callId = randomUUID();
    this.ws.send(JSON.stringify({ id: rpc.id, type: 'tool_call', call: { id: callId, name: 'tool_call', arguments: {
      tool_name: name, schema_hash: toolSchemaHash({ type: 'function', name, parameters: tool.parameters }), arguments: args,
    } } }));
    await until(() => this.requests.some(frame => frame.type === 'tool_result' && frame.callId === callId), `${name} returns through native MCP`);
    const result = this.requests.find(frame => frame.type === 'tool_result' && frame.callId === callId)!;
    assert.equal(result.error, undefined);
    assert.ok(result.result && !result.result.isError, JSON.stringify(result));
    return result.result.output;
  }
  async forAssignment(text: string) {
    await until(() => this.generations.some(rpc => lastUserText(rpc).includes(text)), `generation starts for ${text}`);
    return this.generations.find(rpc => lastUserText(rpc).includes(text))!;
  }
  forText(text: string) {
    const rpc = this.generations.find(candidate => lastUserText(candidate) === text);
    assert.ok(rpc, `no generation for ${text}`);
    return rpc;
  }
  finish(rpc: Rpc, text: string) {
    assert.ok(this.held.delete(rpc.id), 'only a pending request can be completed');
    this.ws.send(JSON.stringify({ id: rpc.id, result: {
      text: JSON.stringify({ text, tool_calls: [] }), usage: { input_tokens: 41, output_tokens: 7 },
    } }));
  }
  releaseAll() {
    this.automatic = true;
    for (const rpc of [...this.held.values()]) this.finish(rpc, `cleanup ${lastUserText(rpc)}`);
  }
}

async function selectedBridge(provider: Provider) {
  const paired = await request('/cli/pair', 'POST');
  assert.equal(paired.status, 200, await paired.clone().text());
  const secret = /--token '([^']+)'$/.exec((await paired.json()).command)?.[1];
  assert.ok(secret);
  const bridge = new HeldBridge();
  await once(bridge.ws, 'open');
  bridge.ws.send(JSON.stringify({ type: 'hello', version: 1, nativeMcp: true, codexExecOnly: true, noGenerationDeadline: true, token: secret, device: 'Held concurrency fixture' }));
  await until(() => bridge.welcome, 'bridge authenticates');
  await refreshCli(owner);
  const selected = await request('/cli', 'PUT', { provider });
  assert.equal(selected.status, 200, await selected.clone().text());
  assert.equal((await selected.json()).selected, provider);
  return bridge;
}
async function drain() { await Promise.all([...bots].map(botId => runInBotQueue(botId, async () => {}))); }
function assertCompleted(count: number, provider: Provider) {
  assert.equal(jobs().length, count);
  assert.ok(jobs().every(job => job.state === 'completed' && job.started_at !== null && job.finished_at !== null));
  assert.equal(usage().length, count);
  assert.ok(usage().every(event => event.user_id === owner && event.provider === `${provider}-cli` && event.cost_source === 'subscription' && event.cost_usd === 0));
  assert.deepEqual([...new Set(usage().map(event => event.bot_id))].sort(), [...bots].sort());
}

beforeEach(() => {
  owner = `usr_cli_concurrency_${++sequence}`;
  const rawSession = randomUUID();
  cookie = `swarm_session=${rawSession}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(owner, `${owner}@example.test`, owner, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (?,?,?,?,?,?)')
    .run(sessionHash(rawSession), owner, Date.now(), Date.now() + 3_600_000, Date.now(), Date.now());
  apiRequests.length = 0;
});
afterEach(async () => {
  // A failed overlap assertion must also release future work behind any old
  // serial barrier, so regression failures cannot leave a hung test process.
  for (const bridge of bridges) bridge.releaseAll();
  await drain();
  disconnectCli(owner);
  for (const bridge of bridges) if (bridge.ws.readyState !== WebSocket.CLOSED) bridge.ws.terminate();
  await Promise.all([...bridges].map(bridge => bridge.closed));
  bridges.clear(); bots.clear();
  db.prepare('DELETE FROM users WHERE id=?').run(owner);
  assert.deepEqual(apiRequests, [], 'concurrency must not enable API fallback or a token-pricing request');
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: ten same-account Bots overlap through one selected CLI and complete independently`, { timeout: 20_000 }, async () => {
  const bridge = await selectedBridge(provider);
  const team = Array.from({ length: 10 }, (_, i) => newBot(`Parallel ${provider} ${i}`));
  const texts = team.map(bot => `parallel-request:${bot.id}`);
  await Promise.all(team.map((bot, i) => message(bot.id, texts[i])));
  await until(() => bridge.generations.length === team.length, 'all ten Bots reach the bridge before any response is released');
  assert.equal(bridge.held.size, team.length);
  assert.ok(jobs().every(job => job.state === 'running'), 'no CLI work is held behind an account capacity queue');
  assert.ok(team.every(bot => getLive(bot.id).isRunning));
  assert.ok(bridge.generations.every(rpc => rpc.params.provider === provider));
  assert.ok(bridge.generations.every(rpc => rpc.params.nativeTools?.length > 0), 'parallel Bots retain their native MCP manifests');
  assert.equal(usage().length, 0);

  // Finish a later arrival while the first request is still held.
  const independent = team.length - 1;
  bridge.finish(bridge.forText(texts[independent]), `finished:${texts[independent]}`);
  await runInBotQueue(team[independent].id, async () => {});
  assert.equal(jobFor(texts[independent]).state, 'completed');
  assert.ok(jobs().filter(job => job.bot_id !== team[independent].id).every(job => job.state === 'running'));
  assert.equal(bridge.held.size, team.length - 1);
  for (let i = team.length - 2; i >= 0; i--) bridge.finish(bridge.forText(texts[i]), `finished:${texts[i]}`);
  await drain();
  assertCompleted(team.length, provider);
  for (const [i, bot] of team.entries()) {
    const replies = listRows(bot.id).filter(row => row.body.type === 'message' && row.body.role === 'assistant');
    assert.equal(replies.length, 1);
    assert.equal((replies[0].body as any).text, `finished:${texts[i]}`);
    assert.ok(!listRows(bot.id).some(row => row.body.type === 'notice' && row.body.tone === 'error'));
  }
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: more than four helpers run alongside their parent through the same subscription`, { timeout: 20_000 }, async () => {
  const bridge = await selectedBridge(provider);
  const parent = newBot('Delegating parent');
  const helpers = Array.from({ length: 8 }, (_, i) => {
    const helper = createSubagent(parent.id, `Independent task ${i}`);
    bots.add(helper.id);
    assert.equal(helper.userId, owner);
    return helper;
  });
  assert.equal(listSubagents(parent.id).length, helpers.length);
  for (const bot of [parent, ...helpers]) enqueue(bot.id, { type: 'user', text: `delegated:${bot.id}` });
  await until(() => bridge.held.size === 9, 'parent and all eight helpers reach the CLI while every response is held');
  assert.ok(jobs().every(job => job.state === 'running'));
  for (const rpc of [...bridge.generations].reverse()) bridge.finish(rpc, `finished:${lastUserText(rpc)}`);
  await drain();
  assertCompleted(9, provider);
});

test('API mode retains its four-helper admission limit', () => {
  const parent = newBot('API helper control');
  assert.equal(selectedCli(owner), null);
  for (let i = 0; i < 4; i++) bots.add(createSubagent(parent.id, `API task ${i}`).id);
  assert.throws(() => createSubagent(parent.id, 'API fifth helper'), /already has 4 subagents/);
  assert.equal(listSubagents(parent.id).length, 4);
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: native helpers spawn seven levels deep and return correlated results without a reply loop`, { timeout: 30_000 }, async () => {
  const bridge = await selectedBridge(provider);
  const root = newBot('Nested parent');
  db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Keep source references in every result.', root.id);
  await message(root.id, 'nested-root-assignment');
  let current = await bridge.forAssignment('nested-root-assignment');
  const chain = [{ id: root.id, name: root.name, rpc: current }];
  for (let level = 1; level <= 7; level++) {
    const text = `nested-assignment-${level}`;
    const result = JSON.parse(await bridge.tool(current, 'spawn_subagent', {
      goal: text, label: `Level ${level}`, merge_instructions: `Return evidence for branch ${level}; reconcile it with the parent result.`,
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    bots.add(result.subagent_id);
    current = await bridge.forAssignment(text);
    chain.push({ id: result.subagent_id, name: result.name, rpc: current });
    const child = db.prepare('SELECT * FROM bots WHERE id=?').get(result.subagent_id) as any;
    assert.equal(child.parent_bot_id, chain[level - 1].id);
    assert.match(child.instructions, /Keep source references/);
    assert.match(child.instructions, new RegExp(`Return evidence for branch ${level}`));
    if (level > 1) assert.ok(!child.instructions.includes(`nested-assignment-${level - 1}`), 'ancestor assignment is not inherited as a new task');
  }
  assert.equal(bridge.held.size, 8, 'all generations overlap without waiting for the parent');
  let requests = listInternalRequests(owner).requests;
  const assignments = requests.filter(r => r.kind === 'request');
  assert.deepEqual(assignments.map(r => r.depth), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(assignments.every(r => r.correlationId === assignments[0].id));
  for (let level = 1; level < assignments.length; level++) assert.equal(assignments[level].parentRequestId, assignments[level - 1].id);

  // The deepest helper can also send a later consolidated result through the
  // actual native send_to_bot path, even though the old depth guard was three.
  const sent = await bridge.tool(current, 'send_to_bot', { bot_name: chain[6].name, message: 'Deep consolidated evidence' });
  assert.match(sent, /Request recorded/);
  requests = listInternalRequests(owner).requests;
  const deepReply = requests.find(r => r.text === 'Deep consolidated evidence')!;
  assert.equal(deepReply.kind, 'result', 'an upward helper report is not a new work request');
  assert.equal(deepReply.depth, 8);
  assert.equal(deepReply.parentRequestId, assignments.at(-1)!.id);
  assert.equal(deepReply.correlationId, assignments[0].id);
  bridge.finish(current, 'Deep leaf final evidence');
  await runInBotQueue(chain[7].id, async () => {});
  const result = listInternalRequests(owner).requests.find(r => r.kind === 'result' && r.parentRequestId === assignments.at(-1)!.id && r.text.startsWith('[Internal result'))!;
  assert.equal(result.depth, 8, 'subscription result lineage is not clamped to four');
  assert.equal(result.toBotId, chain[6].id);
  assert.equal(result.status, 'deferred', 'a helper result cannot interrupt its parent generation');
  assert.match(result.text, /Deep leaf final evidence/);

  bridge.releaseAll();
  await until(() => { drainInternalRequests(); return jobs().every(j => j.state === 'completed'); }, 'all original turns and result receipts finish');
  await drain();
  requests = listInternalRequests(owner).requests;
  for (const assignment of assignments) assert.equal(requests.filter(r => r.kind === 'result' && r.parentRequestId === assignment.id && r.text.startsWith('[Internal result')).length, 1, 'one automatic result per original assignment');
  assert.ok(requests.filter(r => r.text.startsWith('[Consolidated helper result')).every(r => {
    const source = db.prepare('SELECT parent_bot_id FROM bots WHERE id=?').get(r.fromBotId) as any;
    return source.parent_bot_id === r.toBotId;
  }), 'late consolidations only travel up the helper tree');
  assert.ok(requests.every(r => r.status === 'completed'));
  const count = bridge.generations.length;
  drainInternalRequests(); await drain();
  assert.equal(bridge.generations.length, count, 'settled results do not start an automatic conversation loop');
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: parent receives parallel branch results in order and can consolidate both`, { timeout: 25_000 }, async () => {
  const bridge = await selectedBridge(provider), parent = newBot('Consolidating parent');
  await message(parent.id, 'parent-consolidation-task');
  const original = await bridge.forAssignment('parent-consolidation-task');
  const children: { id: string; rpc: Rpc }[] = [];
  for (const label of ['A', 'B']) {
    const result = JSON.parse(await bridge.tool(original, 'spawn_subagent', {
      goal: `independent-branch-${label}`, label, merge_instructions: 'Combine A and B after both return evidence. Resolve disagreements before finalizing.',
    }));
    assert.equal(result.ok, true); bots.add(result.subagent_id);
    children.push({ id: result.subagent_id, rpc: await bridge.forAssignment(`independent-branch-${label}`) });
  }
  assert.equal(bridge.held.size, 3);
  bridge.finish(original, 'My independent work is ready; waiting for both branches.');
  await runInBotQueue(parent.id, async () => {});
  bridge.finish(children[1].rpc, 'Branch B evidence');
  const firstReturn = await bridge.forAssignment('Branch B evidence');
  assert.ok(bridge.held.has(children[0].rpc.id), 'B returns while A is still working');
  bridge.finish(firstReturn, 'B is available; A is still pending.');
  await runInBotQueue(parent.id, async () => {});
  bridge.finish(children[0].rpc, 'Branch A evidence');
  const secondReturn = await bridge.forAssignment('Branch A evidence');
  const history = JSON.stringify(conversation(secondReturn));
  assert.match(history, /Branch B evidence/);
  assert.match(history, /Branch A evidence/);
  assert.match(history, /My independent work is ready/);
  assert.match(history, /Combine A and B after both return evidence/);
  bridge.finish(secondReturn, 'Combined outcome supported by A and B evidence.');
  await until(() => jobs().every(j => j.state === 'completed'), 'both branches and ordered parent continuations complete');
  await drain();
  assert.ok(JSON.stringify(loadHistory(parent.id)).includes('Combined outcome supported by A and B evidence.'));
  assert.equal(listInternalRequests(owner).requests.length, 4, 'two assignments and their two result receipts');
});

test('API depth guard still rejects nested spawn before writing a helper', async () => {
  const parent = newBot('API nested control');
  const result = await toolMap.get('spawn_subagent')!.impl({ goal: 'Forbidden nested API helper' }, {
    userId: owner, botId: parent.id, depth: 2, enqueueBotMessage: () => { throw new Error('must not enqueue'); },
  });
  assert.match(result.output as string, /Subagents cannot start more/);
  assert.equal(listSubagents(parent.id).length, 0);
});

test('failed helper dispatch rolls back the newly created bot', async () => {
  await selectedBridge('claude');
  const parent = newBot('Rejected assignment');
  const result = await toolMap.get('spawn_subagent')!.impl({ goal: 'Reject this assignment' }, {
    userId: owner, botId: parent.id, depth: 9, enqueueBotMessage: () => { throw new Error('Assignment admission refused'); },
  });
  assert.match(result.output as string, /Assignment admission refused/);
  assert.equal(listSubagents(parent.id).length, 0);
});

test('stopping a helper cancels its entire running subtree and preserves parallel siblings', { timeout: 20_000 }, async () => {
  const bridge = await selectedBridge('claude'), parent = newBot('Stop tree parent');
  const child = createSubagent(parent.id, 'First branch'), sibling = createSubagent(parent.id, 'Unrelated sibling');
  const grandchild = createSubagent(child.id, 'Nested branch'), leaf = createSubagent(grandchild.id, 'Deep branch');
  for (const bot of [child, sibling, grandchild, leaf]) bots.add(bot.id);
  for (const bot of [parent, child, sibling, grandchild, leaf]) enqueue(bot.id, { type: 'user', text: `tree-stop:${bot.id}` });
  await until(() => bridge.held.size === 5, 'whole tree and sibling are working');
  const queued = enqueue(leaf.id, { type: 'user', text: 'must-not-run-after-subtree-stop' });
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(queued) as any).state, 'queued');
  const cancelled = [child, grandchild, leaf].map(bot => bridge.forText(`tree-stop:${bot.id}`).id);
  const siblingRequest = bridge.forText(`tree-stop:${sibling.id}`);
  const result = await bridge.tool(bridge.forText(`tree-stop:${parent.id}`), 'stop_subagent', { subagent_id: child.id });
  assert.match(result, /Stopped and removed/);
  await until(() => cancelled.every(id => bridge.cancelled.includes(id)), 'every descendant CLI request is cancelled');
  assert.deepEqual([...bridge.cancelled].sort(), [...cancelled].sort());
  for (const bot of [child, grandchild, leaf]) assert.equal(db.prepare('SELECT id FROM bots WHERE id=?').get(bot.id), undefined);
  assert.equal(db.prepare('SELECT id FROM agent_jobs WHERE id=?').get(queued), undefined);
  // A cancelled CLI may still deliver a final frame; it cannot resurrect work.
  bridge.ws.send(JSON.stringify({ id: cancelled.at(-1), result: { text: 'Late cancelled output' } }));
  assert.ok(bridge.held.has(siblingRequest.id));
  assert.ok(db.prepare('SELECT id FROM bots WHERE id=?').get(sibling.id));
  bridge.releaseAll(); await drain();
  assert.ok(jobs().every(job => job.state === 'completed'));
  assert.ok(bridge.generations.every(rpc => lastUserText(rpc) !== 'must-not-run-after-subtree-stop'));
});

test('same-Bot turns stay ordered while another Bot runs and finishes alongside the first turn', { timeout: 20_000 }, async () => {
  const bridge = await selectedBridge('codex');
  const a = newBot('Ordered A'), b = newBot('Independent B');
  const first = 'ordered-A-first', second = 'ordered-A-second', other = 'independent-B';
  await message(a.id, first);
  await message(a.id, second);
  await message(b.id, other);
  await until(() => bridge.generations.length === 2, 'first A turn and independent B turn overlap');
  assert.equal(jobFor(first).state, 'running');
  assert.equal(jobFor(second).state, 'queued');
  assert.equal(jobFor(other).state, 'running');
  assert.ok(bridge.generations.every(rpc => lastUserText(rpc) !== second));
  bridge.finish(bridge.forText(other), 'B completed while A is held');
  await runInBotQueue(b.id, async () => {});
  assert.equal(jobFor(second).state, 'queued');
  assert.equal(bridge.generations.length, 2);

  bridge.finish(bridge.forText(first), 'A first result');
  await until(() => bridge.generations.length === 3, 'second A turn starts after its first response');
  assert.equal(jobFor(first).state, 'completed');
  assert.equal(jobFor(second).state, 'running');
  const next = bridge.forText(second);
  const history = conversation(next);
  const previousReply = history.findIndex(item => item.role === 'assistant' && JSON.stringify(item.content).includes('A first result'));
  const newMessage = history.findIndex(item => item.role === 'user' && item.content === second);
  assert.ok(previousReply >= 0 && newMessage > previousReply, 'the next turn sees the committed earlier assistant result before its own input');
  bridge.finish(next, 'A second result');
  await drain();
  assertCompleted(3, 'codex');
  assert.deepEqual(loadHistory(a.id).filter(item => item.role === 'user').map(item => item.content), [first, second]);
  assert.deepEqual(listRows(a.id).filter(row => row.body.type === 'message' && row.body.role === 'assistant').map(row => (row.body as any).text), ['A first result', 'A second result']);
});

test('seventy selected-CLI jobs are admitted durably and all start without a per-account capacity wait', { timeout: 40_000 }, async () => {
  const bridge = await selectedBridge('claude');
  const team = Array.from({ length: 70 }, (_, i) => newBot(`Admission ${i}`));
  assert.doesNotThrow(() => {
    for (const bot of team) enqueue(bot.id, { type: 'user', text: `admitted:${bot.id}` });
  }, 'the 65th and later CLI tasks must be accepted');
  assert.equal(jobs().length, team.length);
  assert.ok(jobs().every(job => job.state === 'queued'), 'all accepted jobs are durable before scheduling microtasks run');
  // Preparing seventy real prompts can exceed eight seconds on shared CI hosts.
  // Every response stays held, so a concurrency cap still cannot satisfy this check.
  await until(() => bridge.generations.length === team.length, 'all seventy CLI jobs reach the bridge while every earlier response remains held', 25_000);
  assert.equal(bridge.held.size, team.length);
  assert.ok(jobs().every(job => job.state === 'running'));
  assert.equal(usage().length, 0);
  for (const rpc of [...bridge.generations].reverse()) bridge.finish(rpc, `finished:${lastUserText(rpc)}`);
  await drain();
  assertCompleted(team.length, 'claude');
});

test('interrupting one overlapping Bot cancels only its bridge request and leaves the other turn running', { timeout: 20_000 }, async () => {
  const bridge = await selectedBridge('codex');
  const a = newBot('Cancelled A'), b = newBot('Surviving B');
  enqueue(a.id, { type: 'user', text: 'cancel-only-A' });
  enqueue(b.id, { type: 'user', text: 'keep-B-running' });
  await until(() => bridge.generations.length === 2, 'both turns are in flight before cancellation');
  const stopped = bridge.forText('cancel-only-A'), survivor = bridge.forText('keep-B-running');
  interrupt(a.id);
  await runInBotQueue(a.id, async () => {});
  await until(() => bridge.cancelled.includes(stopped.id), 'interrupt sends cancellation for A');
  assert.deepEqual(bridge.cancelled, [stopped.id]);
  assert.ok(bridge.held.has(survivor.id));
  assert.equal(jobFor('keep-B-running').state, 'running');
  assert.equal(getLive(b.id).isRunning, true);
  assert.ok(listRows(a.id).some(row => row.body.type === 'notice' && row.body.text === 'Stopped.'));
  bridge.finish(survivor, 'B survived cancellation');
  await drain();
  assert.equal(selectedCli(owner), 'codex');
  assert.equal(jobFor('keep-B-running').state, 'completed');
  assert.equal(usage().length, 1);
  assert.equal(usage()[0].bot_id, b.id);
  assert.equal((listRows(b.id).find(row => row.body.type === 'message' && row.body.role === 'assistant')?.body as any).text, 'B survived cancellation');
});

test('API mode retains its 64 pending-job admission limit', () => {
  const bot = newBot('API admission control');
  assert.equal(selectedCli(owner), null);
  for (let i = 0; i < 64; i++) acceptJob(bot.id, { type: 'user', text: `api-pending-${i}` });
  assert.equal(jobs().length, 64);
  assert.throws(() => acceptJob(bot.id, { type: 'user', text: 'api-over-capacity' }), /task queue is full/);
  assert.equal(jobs().length, 64, 'rejected API admission writes no job');
});

test('API mode retains account ordering across different Bots', { timeout: 20_000 }, async (t) => {
  // MF-011 lets Bots of one account run side by side (default 2). With one slot, order is strict.
  process.env.SWARM_ACCOUNT_CONCURRENCY = '1';
  t.after(() => { delete process.env.SWARM_ACCOUNT_CONCURRENCY; });
  const a = newBot('API ordered A'), b = newBot('API ordered B');
  type ApiCall = { body: any; finish: (text: string) => void };
  const calls: ApiCall[] = [];
  let automatic = false;
  const create = t.mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
    let finish!: (text: string) => void;
    const held = new Promise<string>(resolve => { finish = resolve; });
    calls.push({ body, finish });
    if (automatic) finish('API cleanup');
    return (async function* () {
      const text = await held;
      const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
      yield { type: 'response.output_item.added', item };
      yield { type: 'response.output_text.delta', delta: text };
      yield { type: 'response.output_item.done', item };
      yield { type: 'response.completed', response: { id: randomUUID(), output: [item], usage: { input_tokens: 1, output_tokens: 1, cost: 0 } } };
    })();
  });
  try {
    enqueue(a.id, { type: 'user', text: 'API-first' });
    enqueue(b.id, { type: 'user', text: 'API-second' });
    await until(() => calls.length === 1, 'first API request starts');
    assert.equal(jobFor('API-first').state, 'running');
    assert.equal(jobFor('API-second').state, 'queued');
    assert.equal(calls[0].body.model, 'api-control-model');
    calls[0].finish('API first result');
    await until(() => calls.length === 2, 'second API request starts after the first completes');
    assert.equal(jobFor('API-first').state, 'completed');
    assert.equal(jobFor('API-second').state, 'running');
    calls[1].finish('API second result');
    await drain();
    assert.ok(jobs().every(job => job.state === 'completed'));
  } finally {
    automatic = true;
    for (const call of calls) call.finish('API cleanup');
    await drain();
    create.mock.restore();
  }
});
