// Maintained regression coverage for native Hermes/Quinn boundary behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quinn-boundaries-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(root, 'audit.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'isolated-audit-fixture', COMPUTER_PROVIDER: 'local',
  DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'http://127.0.0.1:9/v1',
  LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
});
const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js'); initSubagents();
const { initRooms } = await import('../server/src/agent/rooms.js'); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow } = await import('../server/src/store.js');
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { withUsage } = await import('../server/src/usage.js');
const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
const { testMcpServer, closeMcpSessions } = await import('../server/src/mcp/client.js');
const { initProactive, fireCheckin } = await import('../server/src/proactive.js');
let sequence = 0;
let model: (body: any) => any[] = () => [];
const message = (text: string) => ({ type: 'message', id: `msg_${++sequence}`, role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (name: string, args: unknown) => ({ type: 'function_call', call_id: `call_${++sequence}`, name, arguments: JSON.stringify(args) });
const client = withUsage({ userId: 'audit' }, () => llmClient(360_000));
mock.method(client.responses, 'create', async (body: any) => {
  const output = model(body);
  return (async function* () {
    for (const item of output) {
      yield { type: 'response.output_item.added', item };
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content[0].text };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output, usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } };
  })();
});
mock.method(Client.prototype, 'connect', async () => {});
mock.method(Client.prototype, 'close', async () => {});
mock.method(Client.prototype, 'listTools', async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }] }));
let writes = 0;
mock.method(Client.prototype, 'callTool', async () => { writes++; return { content: [{ type: 'text', text: 'Saved' }] }; });
function fixture(label: string) {
  const userId = `audit-${label}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, label, Date.now());
  const chief = createBot(userId, { name: 'Quinn', isPrimary: true });
  const worker = createBot(userId, { name: 'Nia' });
  db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(worker.id);
  return { userId, chief, worker };
}
after(async () => { await settleAgentJobs(); await closeMcpSessions(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('background peer update preserves an unresolved approval', async () => {
  const f = fixture('approval');
  const server = (await testMcpServer(saveMcpServer(f.userId, { name: 'Audit write', transport: 'http', url: 'https://fixture.example/mcp', botIds: [f.worker.id] })))!;
  model = () => [call(mcpToolName(server, 'write'), { value: 1 })];
  enqueue(f.worker.id, { type: 'user', text: 'Save the requested record.' });
  await settleAgentJobs();
  const approval = db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").get(f.worker.id) as any;
  assert.ok(approval, 'fixture must have a pending approval');
  assert.equal(writes, 0);
  model = () => [message('Internal progress acknowledgement.')];
  enqueue(f.worker.id, { type: 'bot', fromBotId: f.chief.id, fromName: 'Quinn', text: 'Status update only.', depth: 1 });
  await settleAgentJobs();
  const actual = (db.prepare('SELECT status FROM approvals WHERE id=?').get(approval.id) as any).status;
  console.log(JSON.stringify({ scenario: 'peer_update_during_approval', approvalStatus: actual, pendingTurnExists: !!db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(f.worker.id), writes }));
  assert.equal(actual, 'pending');
});

test('queue rejection leaves no delivered-looking peer message', async () => {
  const f = fixture('capacity');
  for (let i = 0; i < 63; i++) acceptJob(f.worker.id, { type: 'system', text: `Held fixture ${i}` });
  model = body => body.input.at(-1)?.type === 'function_call_output' ? [message('Dispatch attempt ended.')] : [call('send_to_bot', { bot_name: 'Nia', message: 'Internal assignment must be durable before delivery.' })];
  enqueue(f.chief.id, { type: 'user', text: 'Ask Nia to inspect the assignment.' });
  await settleAgentJobs();
  const count = (db.prepare("SELECT count(*) n FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.from.kind')='bot'").get(f.worker.id) as any).n;
  const accepted = (db.prepare("SELECT count(*) n FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.type')='bot'").get(f.worker.id) as any).n;
  console.log(JSON.stringify({ scenario: 'full_queue_peer_dispatch', visiblePeerMessages: count, acceptedPeerJobs: accepted }));
  assert.equal(accepted, 0, 'fixture must reject peer queue admission');
  assert.equal(count, 0);
});

test('internal messages cannot suppress Quinn check-ins as recent human activity', () => {
  const f = fixture('checkin');
  const queued: unknown[] = [];
  initProactive((_botId, trigger) => { queued.push(trigger); });
  fireCheckin(f.userId);
  assert.equal(queued.length, 1, 'baseline with no human activity must schedule a check-in');
  queued.length = 0;
  appendRow(f.worker.id, 'message', { type: 'message', role: 'user', text: 'Internal background status.', from: { kind: 'bot', id: f.chief.id, name: 'Quinn' } });
  fireCheckin(f.userId);
  console.log(JSON.stringify({ scenario: 'internal_message_checkin_suppression', checkinsQueued: queued.length, humanMessages: 0 }));
  assert.equal(queued.length, 1);
});

test('deleting the only primary requires a replacement', async () => {
  const f = fixture('primary');
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const { computers } = await import('../server/src/computers/index.js');
  mock.method(computers, 'resetScreen', async () => {});
  const token = 'audit-primary-session';
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token, f.userId, Date.now(), Date.now() + 60000);
  const app = new Hono().route('/api', api);
  const response = await app.request(`/api/bots/${f.chief.id}`, { method: 'DELETE', headers: { cookie: `swarm_session=${token}` } });
  const remaining = (db.prepare('SELECT count(*) n FROM bots WHERE user_id=? AND is_primary=1').get(f.userId) as any).n;
  console.log(JSON.stringify({ scenario: 'delete_only_primary', responseStatus: response.status, primariesRemaining: remaining }));
  assert.equal(remaining, 1);
});
