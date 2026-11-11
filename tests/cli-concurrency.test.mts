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
attachCliSocket(server);
const app = new Hono().route('/api/cli', cliApi).route('/api', api);

type Provider = 'codex' | 'claude';
type Rpc = { id: string; method: 'status' | 'generate' | 'cancel'; params?: any };
type Job = { id: string; user_id: string; bot_id: string; trigger: string; state: string; started_at: number | null; finished_at: number | null };
let owner: string, cookie: string, sequence = 0;
const bots = new Set<string>();
const bridges = new Set<HeldBridge>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jobs = () => db.prepare('SELECT * FROM agent_jobs WHERE user_id=? ORDER BY created_at,rowid').all(owner) as Job[];
const jobFor = (text: string) => jobs().find(job => JSON.parse(job.trigger).text === text)!;
const usage = () => db.prepare('SELECT * FROM usage_events WHERE user_id=?').all(owner) as any[];

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
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
  bridge.ws.send(JSON.stringify({ type: 'hello', version: 1, nativeMcp: true, token: secret, device: 'Held concurrency fixture' }));
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

test('seventy selected-CLI jobs are admitted durably and all start without a per-account capacity wait', { timeout: 25_000 }, async () => {
  const bridge = await selectedBridge('claude');
  const team = Array.from({ length: 70 }, (_, i) => newBot(`Admission ${i}`));
  assert.doesNotThrow(() => {
    for (const bot of team) enqueue(bot.id, { type: 'user', text: `admitted:${bot.id}` });
  }, 'the 65th and later CLI tasks must be accepted');
  assert.equal(jobs().length, team.length);
  assert.ok(jobs().every(job => job.state === 'queued'), 'all accepted jobs are durable before scheduling microtasks run');
  await until(() => bridge.generations.length === team.length, 'all seventy CLI jobs reach the bridge while every earlier response remains held');
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
