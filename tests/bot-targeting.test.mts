import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-targeting-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
  NODE_ENV: 'development', DEV_LOGIN: '1', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1',
  SESSION_SECRET: 'local-targeting-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'http://127.0.0.1:9/v1', LLM_PROVIDER: 'direct',
  OPENROUTER_API_KEY: '', COMPOSIO_API_KEY: 'fixture-toolkit',
});
const localFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in local fixture'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
const { initRooms, createRoom, roomMembers } = await import('../server/src/agent/rooms.js');
initRooms();
const { createBot, resolveBotTarget } = await import('../server/src/bots.js');
const { createTeammate, replicateTeammate, retryTeammate } = await import('../server/src/agent/teammates.js');
const { getSetup } = await import('../server/src/bot-setup.js');
const { toolMap, functionSchemas } = await import('../server/src/agent/tools.js');
const { systemPrompt } = await import('../server/src/agent/prompt.js');
const { appendRow, listRows } = await import('../server/src/store.js');
const { computers } = await import('../server/src/computers/index.js');
const { composio } = await import('../server/src/composio.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { withUsage } = await import('../server/src/usage.js');
const { settleAgentJobs } = await import('../server/src/agent/loop.js');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
const screens: string[] = [];
mock.method(computers, 'screen', async (_userId, botId) => {
  screens.push(botId);
  return { screenshot: async () => ({ image: '', mime: 'image/png', width: 1, height: 1 }) } as any;
});
let sequence = 0;
const decode = (result: any) => JSON.parse(result.output);
const run = (name: string, args: unknown, ctx: any) => toolMap.get(name)!.impl(args, ctx);
function fixture() {
  const userId = `target-owner-${++sequence}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture account', Date.now());
  const primary = createBot(userId, { name: 'Coordinator', isPrimary: true });
  const first = createBot(userId, { name: 'Notes', label: 'Research notes', instructions: 'Use research sources.' });
  const second = createBot(userId, { name: 'nOtEs', label: 'Meeting notes', instructions: 'Use meeting notes.' });
  const unique = createBot(userId, { name: 'Reports' });
  const sent: unknown[][] = [];
  const ctx = { userId, botId: primary.id, depth: 0, enqueueBotMessage: (...args: unknown[]) => { sent.push(args); } };
  return { userId, primary, first, second, unique, sent, ctx };
}
function choices(error: unknown) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Multiple Bots match.*retry with bot_id/);
  return JSON.parse(error.message.split('Choices: ')[1]);
}
after(async () => {
  await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('P-06: ambiguous delegation returns owned choices without enqueueing work', async () => {
  const f = fixture(), foreign = fixture();
  const hidden = createBot(f.userId, { name: 'Notes' });
  db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(hidden.id);
  createRoom(f.userId, 'Notes', [f.first.id, f.second.id]);
  for (const name of ['Notes', ' NOTES ', 'notes']) {
    await assert.rejects(run('send_to_bot', { bot_name: name, message: 'Summarize the supplied notes.' }, f.ctx), error => {
      const matches = choices(error);
      assert.deepEqual(matches.map((b: any) => b.bot_id).sort(), [f.first.id, f.second.id].sort());
      assert.deepEqual(matches.map((b: any) => b.label).sort(), ['Meeting notes', 'Research notes']);
      assert.ok(!JSON.stringify(matches).includes(foreign.first.id));
      return true;
    });
  }
  assert.deepEqual(f.sent, []);
});

test('P-06: IDs select either duplicate and remain stable after rename', async () => {
  const f = fixture();
  db.prepare('UPDATE bots SET name=? WHERE id=?').run('Notes', f.second.id);
  await run('send_to_bot', { bot_id: f.first.id, message: 'First assignment' }, f.ctx);
  await run('send_to_bot', { bot_id: f.second.id, message: 'Second assignment' }, f.ctx);
  db.prepare('UPDATE bots SET name=? WHERE id=?').run('Archived notes', f.second.id);
  await run('send_to_bot', { bot_id: f.second.id, bot_name: 'Notes', message: 'Renamed assignment' }, f.ctx);
  assert.deepEqual(f.sent.map(args => args[1]), [f.first.id, f.second.id, f.second.id]);
  await run('send_to_bot', { bot_name: ' reports ', message: 'Legacy assignment' }, f.ctx);
  assert.equal(f.sent.at(-1)![1], f.unique.id);
});

test('P-06: foreign, hidden, room, deleted and unknown IDs never fall back to a valid name', async () => {
  const f = fixture(), foreign = fixture();
  const hidden = createBot(f.userId, { name: 'Hidden notes' });
  db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(hidden.id);
  const room = createRoom(f.userId, 'Team room', [f.first.id, f.second.id]);
  const deleted = createBot(f.userId, { name: 'Deleted notes' });
  db.prepare('DELETE FROM bots WHERE id=?').run(deleted.id);
  const before = screens.length;
  for (const bot_id of [foreign.first.id, hidden.id, room, deleted.id, 'bot_missing']) {
    const args = { bot_id, bot_name: f.unique.name };
    assert.equal((await run('send_to_bot', { ...args, message: 'Do not dispatch' }, f.ctx)).isError, true);
    await assert.rejects(retryTeammate(args, f.ctx), /No such teammate/);
    await assert.rejects(replicateTeammate({ ...args, new_name: 'Replica' }, f.ctx), /No saved setup/);
  }
  for (const args of [{}, { bot_id: '', bot_name: 'Reports' }, { bot_name: ' ' }, { bot_id: null, bot_name: 'Reports' }]) {
    await assert.rejects(run('send_to_bot', { ...args, message: 'Do not dispatch' }, f.ctx), /Provide/);
  }
  assert.deepEqual(f.sent, []);
  assert.equal(screens.length, before);
});

test('P-06: only eligible matches count for legacy name compatibility', async () => {
  const f = fixture();
  const hidden = createBot(f.userId, { name: 'Reports' });
  db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(hidden.id);
  createRoom(f.userId, 'Reports', [f.first.id, f.second.id]);
  assert.equal(resolveBotTarget(f.userId, { bot_name: 'REPORTS' }).id, f.unique.id);
});

test('P-06: replication and setup retry reject ambiguity before any side effects', async () => {
  const f = fixture(), before = screens.length;
  const count = () => (db.prepare('SELECT count(*) n FROM bots WHERE user_id=?').get(f.userId) as any).n;
  const originalCount = count();
  for (const name of ['replicate_bot', 'retry_bot_setup']) {
    await assert.rejects(run(name, { bot_name: 'notes', new_name: 'Replica' }, f.ctx), error => {
      assert.equal(choices(error).length, 2); return true;
    });
  }
  assert.equal(count(), originalCount);
  assert.equal(screens.length, before);
  const replica = decode(await replicateTeammate({ bot_id: f.second.id, new_name: 'Replica' }, f.ctx)).bot;
  assert.equal(replica.instructions, f.second.instructions);
  assert.equal(getSetup(f.first.id)!.computer.status, 'pending');
  assert.equal(decode(await retryTeammate({ bot_id: f.second.id }, f.ctx)).bot_id, f.second.id);
  assert.deepEqual(screens.slice(before), [replica.id, f.second.id]);
  assert.equal(decode(await retryTeammate({ bot_name: 'reports' }, f.ctx)).bot_id, f.unique.id);
});

test('P-06: group membership resolves all IDs and fails atomically on ambiguous names', async () => {
  const f = fixture();
  db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id IN (?,?,?)").run(f.first.id, f.second.id, f.unique.id);
  const roomCount = () => (db.prepare("SELECT count(*) n FROM bots WHERE user_id=? AND kind='room'").get(f.userId) as any).n;
  await assert.rejects(run('create_group', { name: 'Review', bot_names: ['Reports', 'Notes'] }, f.ctx), /Multiple Bots match/);
  assert.equal(roomCount(), 0);
  const result = decode(await run('create_group', { name: 'Review', bot_ids: [f.first.id, f.second.id], bot_names: ['Notes'] }, f.ctx));
  assert.deepEqual(roomMembers(result.group_id).map(b => b.id), [f.first.id, f.second.id]);
  for (const bot_ids of [[f.first.id, f.first.id], [f.first.id, f.second.id, 'bot_missing']]) {
    assert.equal((await run('create_group', { name: 'Invalid review', bot_ids }, f.ctx)).isError, true);
  }
  assert.equal(roomCount(), 1);
});

test('P-06: creation does not reuse an arbitrary duplicate and stable request retries still work', async () => {
  const f = fixture();
  const row = appendRow(f.primary.id, 'message', { type: 'message', role: 'user', text: 'Summarize supplied notes, with no external actions.' });
  const spec = { name: 'Notes', purpose: 'Summarize supplied notes', responsibilities: ['Summarize supplied notes'], out_of_scope: ['External actions'], success_criteria: ['Accurate summary'], context_summary: 'Use only supplied notes.', source_message_seqs: [row.seq] };
  const before = screens.length;
  await assert.rejects(createTeammate(spec, f.ctx), /Multiple Bots match/);
  assert.equal(screens.length, before);
  const request = { ...spec, name: 'Summary', creation_request_id: 'stable-request' };
  const saved = decode(await createTeammate(request, f.ctx));
  createBot(f.userId, { name: 'Summary' });
  const retried = decode(await createTeammate(request, f.ctx));
  assert.equal(retried.bot.id, saved.bot.id);
  assert.equal(retried.already_created, true);
});

test('P-06: roster and tool schemas expose IDs with role details', async () => {
  const f = fixture();
  const prompt = await systemPrompt(f.userId, f.primary.id);
  for (const bot of [f.first, f.second]) {
    assert.ok(prompt.includes(`"bot_id":"${bot.id}"`));
    assert.ok(prompt.includes(`"label":"${bot.label}"`));
  }
  for (const name of ['send_to_bot', 'replicate_bot', 'retry_bot_setup']) {
    const schema = functionSchemas(f.primary.id).find(t => t.name === name)!.parameters as any;
    assert.equal(schema.properties.bot_id.type, 'string');
    assert.ok(!schema.required.includes('bot_name'));
  }
});

test('P-06: local dev login and mocked model dispatch preserve choices and target only the selected ID', async t => {
  const f = fixture();
  db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(f.second.id);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await localFetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${f.userId}@example.test` }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  let target: any = { bot_name: 'Notes' };
  let dispatchNext = false;
  const outputs: string[] = [];
  const client = withUsage({ userId: f.userId }, () => llmClient(360_000));
  mock.method(client.responses, 'create', async (body: any) => {
    const prior = body.input.at(-1);
    if (prior?.type === 'function_call_output') outputs.push(prior.output);
    const item = !dispatchNext
      ? { type: 'message', id: `msg_${++sequence}`, role: 'assistant', content: [{ type: 'output_text', text: 'Request inspected.' }] }
      : { type: 'function_call', call_id: `call_${++sequence}`, name: 'send_to_bot', arguments: JSON.stringify({ ...target, message: 'Summarize the supplied notes.' }) };
    dispatchNext = false;
    return (async function* () {
      yield { type: 'response.output_item.added', item };
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content![0].text };
      yield { type: 'response.output_item.done', item };
      yield { type: 'response.completed', response: { output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } };
    })();
  });
  async function chat() {
    dispatchNext = true;
    const response = await localFetch(`${base}/api/bots/${f.primary.id}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Summarize my supplied notes.' }) });
    assert.equal(response.status, 200);
    await settleAgentJobs();
  }
  const peerJobs = () => db.prepare("SELECT bot_id FROM agent_jobs WHERE user_id=? AND json_extract(trigger,'$.type')='bot' AND json_extract(trigger,'$.fromBotId')=?").all(f.userId, f.primary.id) as any[];
  await chat();
  assert.equal(peerJobs().length, 0);
  assert.ok(outputs.some(output => output.includes(f.first.id) && output.includes(f.second.id)));
  assert.ok(listRows(f.primary.id).some(row => row.body.type === 'tool-call' && row.body.name === 'send_to_bot' && row.body.status === 'error'));
  target = { bot_id: f.second.id };
  await chat();
  assert.deepEqual(peerJobs().map(job => job.bot_id), [f.second.id], JSON.stringify(outputs));
});
