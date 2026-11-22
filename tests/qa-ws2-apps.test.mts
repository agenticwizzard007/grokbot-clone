// QA master fix, work stream 2: approval cards only for connected app accounts (MF-005). Fake Composio, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-qa-ws2-apps-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'qa-ws2-apps',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', DIRECT_API_KEY: 'test', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async (input: unknown) => {
  const host = new URL(String(input)).hostname;
  if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (host === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Unexpected real provider request.');
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { composio } = await import('../server/src/composio.js');
const { createBot } = await import('../server/src/bots.js');
const { listRows, loadHistory } = await import('../server/src/store.js');
const { enqueue, settleAgentJobs, activeAppAccount } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.com', 'owner', Date.now());
const bot = createBot('owner', { name: 'Sender', isPrimary: true });
let accounts: any[] = [{ id: 'ca_gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }];
mock.method(composio().connectedAccounts, 'list', async () => ({ items: accounts, nextCursor: null }));
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const sendArgs = { connectionId: 'ca_slack', revision: 1, tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'general', text: 'hello' } };
function scripted() {
  let n = 0;
  return mock.method(llmClient(360_000).responses, 'create', async () => (async function* () {
    const item = n++ === 0
      ? { type: 'function_call', id: 'fc_1', call_id: `call_${n}`, name: 'SWARM_APPS_EXECUTE', arguments: JSON.stringify(sendArgs), status: 'completed' }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Slack is not connected.', annotations: [] }] };
    if (item.type === 'message') yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })());
}

test('MF-005: no approval card for an app account that is not connected; the tool output says so', async () => {
  const create = scripted();
  try { enqueue(bot.id, { type: 'user', text: 'Post hello to Slack' }); await settleAgentJobs(); } finally { create.mock.restore(); }
  assert.equal((db.prepare('SELECT count(*) n FROM approvals').get() as any).n, 0);
  assert.ok(!listRows(bot.id).some((r) => r.body.type === 'card'));
  const output = loadHistory(bot.id).find((i: any) => i.type === 'function_call_output');
  assert.match(String(output.output), /not connected/);
  const toolRow = listRows(bot.id).find((r) => r.body.type === 'tool-call')!;
  assert.equal((toolRow.body as any).status, 'denied');
});

test('MF-005: an inactive or disabled account is treated as not connected', async () => {
  accounts = [{ id: 'ca_slack', toolkit: { slug: 'slack' }, status: 'EXPIRED' }];
  assert.equal((await activeAppAccount('owner', sendArgs)).ok, false);
  accounts = [{ id: 'ca_slack', toolkit: { slug: 'slack' }, status: 'ACTIVE', isDisabled: true }];
  assert.equal((await activeAppAccount('owner', sendArgs)).ok, false);
  accounts = [{ id: 'ca_slack', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }];
  assert.equal((await activeAppAccount('owner', sendArgs)).ok, false, 'account must belong to the tool app');
});

test('MF-005: a connected account still asks first, and the card shows the app and account label, not the raw id', async () => {
  accounts = [{ id: 'ca_slack', toolkit: { slug: 'slack' }, status: 'ACTIVE' }];
  const create = scripted();
  try { enqueue(bot.id, { type: 'user', text: 'Post hello to Slack again' }); await settleAgentJobs(); } finally { create.mock.restore(); }
  assert.equal((db.prepare("SELECT count(*) n FROM approvals WHERE status='pending'").get() as any).n, 1);
  const card = listRows(bot.id).find((r) => r.body.type === 'card')!.body as any;
  assert.equal(card.card, 'approval');
  assert.match(card.detail, /App: Slack/);
  assert.match(card.detail, /Account: Connected Slack account/);
  assert.doesNotMatch(card.detail, /ca_/);
});
