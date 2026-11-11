import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Cron } from 'croner';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tool-integrity-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'tool-integrity-test', COMPUTER_PROVIDER: 'cloudvm', VM_DRIVER: 'fake',
  DIRECT_API_KEY: 'unused-fixture-key', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture-app-key',
  INKBOX_TUNNEL: '0', CAPTCHA_AUTOPASS_SEC: '0', CAPTCHA_WAIT_MIN: '0',
});
// SDK background metadata is stubbed too; no test may reach a live endpoint.
const network: string[] = [];
mock.method(globalThis, 'fetch', async (input: any) => {
  const url = new URL(String(input?.url ?? input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  network.push(url.origin);
  throw new Error('Unexpected network access in tool integrity regression');
});
const { db } = await import('../server/src/db.js');
const { computers } = await import('../server/src/computers/index.js');
const { TOOLS } = await import('../server/src/agent/tools.js');
const { initSubagents, createSubagent } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
const { createBot } = await import('../server/src/bots.js');
const { enqueue, settleAgentJobs, turnSignal } = await import('../server/src/agent/loop.js');
const { listRows } = await import('../server/src/store.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { nativeToolHandler } = await import('../server/src/cli/native-tools.js');
const { scheduleRoutine, unscheduleRoutine } = await import('../server/src/routines.js');
const { initTriggers } = await import('../server/src/triggers.js');
const { composio } = await import('../server/src/composio.js');
initSubagents(); initRooms();
await initTriggers(() => {});
mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
for (const id of ['owner', 'foreign']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
const actor = createBot('owner', { name: 'Actor', isPrimary: true });
const context = { userId: 'owner', botId: actor.id, depth: 0, enqueueBotMessage() {} };
const tool = (name: string) => TOOLS.find(value => value.name === name)!;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const provider = llmClient(360_000).responses;
after(async () => {
  await settleAgentJobs();
  assert.deepEqual(network, [], 'all application/provider network access must remain mocked');
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

for (const owner of ['owner', 'foreign']) test(`stop_subagent cannot interrupt an unrelated running ${owner} Bot`, async t => {
  const target = createBot(owner, { name: 'Unrelated running Bot', isPrimary: true });
  const started = deferred(), release = deferred();
  t.mock.method(provider, 'create', async () => {
    started.resolve(); await release.promise;
    return (async function* () { yield { type: 'response.completed', response: { output: [] } }; })();
  });
  enqueue(target.id, { type: 'user', text: 'Wait in the local model fixture.' });
  await started.promise;
  const signal = turnSignal(target.id)!;
  try {
    const result = await tool('stop_subagent').impl({ subagent_id: target.id }, context);
    assert.equal(signal.aborted, false, 'ownership must be checked before touching the target abort controller');
    assert.equal(result.output, 'No such subagent.');
    assert.ok(db.prepare('SELECT 1 FROM bots WHERE id=?').get(target.id));
  } finally { release.resolve(); await settleAgentJobs(); }
});

test('stop_subagent still removes its own child and rejects an unknown target', async () => {
  const child = createSubagent(actor.id, 'Owned helper');
  assert.equal((await tool('stop_subagent').impl({ subagent_id: child.id }, context)).output, 'Stopped and removed.');
  assert.equal(db.prepare('SELECT 1 FROM bots WHERE id=?').get(child.id), undefined);
  assert.equal((await tool('stop_subagent').impl({ subagent_id: 'missing' }, context)).output, 'No such subagent.');
});

for (const owner of ['owner', 'foreign']) test(`delete_routine preserves another ${owner} Bot's schedule and provider trigger`, async t => {
  const target = createBot(owner, { name: 'Routine owner', isPrimary: true });
  const id = `routine-${owner}`;
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,trigger_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, target.id, 'Protected routine', 'Local fixture', '0 0 1 1 *', 'UTC', `trigger-${id}`, Date.now());
  scheduleRoutine({ id, botId: target.id, name: 'Protected routine', prompt: 'Local fixture', schedule: '0 0 1 1 *', timezone: 'UTC' });
  const stop = t.mock.method(Cron.prototype, 'stop');
  const remove = t.mock.method(composio().triggers, 'delete', async () => ({}));
  try {
    const result = await tool('delete_routine').impl({ routine_id: id }, context);
    assert.equal(stop.mock.callCount(), 0, 'a foreign routine must not be unscheduled');
    assert.equal(remove.mock.callCount(), 0, 'a foreign routine must not reach its provider');
    assert.equal(result.output, 'No such routine.');
    assert.ok(db.prepare('SELECT 1 FROM routines WHERE id=? AND bot_id=?').get(id, target.id));
  } finally { stop.mock.restore(); unscheduleRoutine(id); }
});

test('delete_routine removes its own scheduled routine and provider trigger once, and rejects an unknown ID', async t => {
  const id = 'owned-routine';
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,trigger_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, actor.id, 'Owned routine', 'Local fixture', '0 0 1 1 *', 'UTC', 'owned-trigger', Date.now());
  scheduleRoutine({ id, botId: actor.id, name: 'Owned routine', prompt: 'Local fixture', schedule: '0 0 1 1 *', timezone: 'UTC' });
  const stop = t.mock.method(Cron.prototype, 'stop');
  const remove = t.mock.method(composio().triggers, 'delete', async () => ({}));
  assert.equal((await tool('delete_routine').impl({ routine_id: id }, context)).output, 'Deleted.');
  assert.equal(stop.mock.callCount(), 1);
  assert.deepEqual(remove.mock.calls.map(call => call.arguments), [['owned-trigger']]);
  assert.equal(db.prepare('SELECT 1 FROM routines WHERE id=?').get(id), undefined);
  assert.equal((await tool('delete_routine').impl({ routine_id: 'missing' }, context)).output, 'No such routine.');
  assert.equal(remove.mock.callCount(), 1);
});

for (const native of [false, true]) for (const isError of [false, true]) test(`${native ? 'native callback' : 'API'} browser ${isError ? 'failure' : 'success'} preserves row, journal and tool-result status`, async t => {
  const bot = createBot('owner', { name: 'Browser fixture', isPrimary: true });
  const text = isError ? 'Timeout waiting for element' : 'Clicked the requested button';
  t.mock.method(computers, 'screen', async () => ({ browser: async () => ({ isError, content: [{ type: 'text', text }] }) }) as any);
  let generations = 0, nativeResult: any;
  t.mock.method(provider, 'create', async () => {
    const first = generations++ === 0;
    if (first && native) nativeResult = await nativeToolHandler('owner')!({ id: 'browser-request', name: 'browser_click', arguments: { target: 'e1' } });
    return (async function* () {
      yield { type: 'response.completed', response: { output: first && !native ? [{ type: 'function_call', call_id: 'browser-call', name: 'browser_click', arguments: '{"target":"e1"}' }] : [] } };
    })();
  });
  enqueue(bot.id, { type: 'user', text: 'Use the fixture browser.' });
  await settleAgentJobs();
  const row = listRows(bot.id).find(row => row.body.type === 'tool-call')!.body as any;
  assert.equal(row.status, isError ? 'error' : 'done');
  const dispatch = db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(bot.id, row.callId) as any;
  assert.equal(dispatch.state, isError ? 'uncertain' : 'completed');
  if (native) {
    assert.equal(nativeResult.isError, isError, 'the provider must receive the original MCP failure status');
    assert.ok(String(nativeResult.output).startsWith(text), 'the original tool text must survive appended browser recovery guidance');
  }
});
