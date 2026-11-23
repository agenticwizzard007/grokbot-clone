import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-empty-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'stop-empty-fixture',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '',
  LLM_PROVIDER: 'direct', DIRECT_BASE_URL: 'http://127.0.0.1:1', INKBOX_TUNNEL: '0',
});
const { executions } = await import('./fixtures/stop-voice-backends.mjs');
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { api } = await import('../server/src/routes.js');
const { createBot } = await import('../server/src/bots.js');
const { listRows, getLive } = await import('../server/src/store.js');
const { enqueue, interrupt, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const app = new Hono().route('/api', api);
const login = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stop-fixture@example.test', name: 'QA account' }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { user } = await (await app.request('/api/auth/me', { headers: { cookie } })).json() as any;
db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run(user.id, 'GMAIL_FETCH_EMAILS');
let mode = 'slow', calls = 0;
mock.method(llmClient(360_000).responses, 'create', async () => (async function* () {
  const output = mode === 'empty' ? [] : calls++ === 0 ? [{ type: 'function_call', call_id: 'fixture-call', name: 'SWARM_APPS_EXECUTE', arguments: JSON.stringify({ connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { scenario: mode } }) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Local fixture read completed.' }] }];
  yield { type: 'response.completed', response: { output } };
})());
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
function bot(scenario: string) {
  mode = scenario; calls = 0;
  const bot = createBot(user.id, { name: 'Stop fixture' });
  db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id);
  return bot.id;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Fixture did not reach running tool');
}
for (const scenario of ['failed', 'expired', 'timeout', 'gateway-timeout', 'empty']) {
  test(`S-01: ${scenario} ends with an actionable terminal error and retry`, async () => {
    const id = bot(scenario);
    enqueue(id, { type: 'user', text: 'Read the local fixture.' }); await settleAgentJobs();
    const rows = listRows(id), notice = rows.find(r => r.body.type === 'notice' && r.body.terminal)?.body as any;
    assert.equal(notice?.tone, 'error');
    assert.match(notice.text, scenario === 'empty' ? /without a reply/i : scenario.includes('timeout') ? /Gmail tool timed out/ : /Gmail.*failed/);
    assert.deepEqual(notice.retry, { text: 'Read the local fixture.' });
    assert.doesNotMatch(notice.text, /Stopped\.|private fixture/);
    assert.equal(getLive(id).isRunning, false);
  });
}
test('S-01: closing and reopening SSE does not cancel a slow tool run', async () => {
  const id = bot('slow');
  const stream = await app.request('/api/events', { headers: { cookie } });
  const reader = stream.body!.getReader(); await reader.read();
  const count = executions.length;
  enqueue(id, { type: 'user', text: 'Read the local fixture.' });
  await until(() => executions.length > count);
  await reader.cancel();
  assert.equal(getLive(id).isRunning, true);
  const resumed = await app.request('/api/events', { headers: { cookie } });
  const next = resumed.body!.getReader(); await next.read(); await next.cancel();
  await settleAgentJobs();
  assert.ok(listRows(id).some(r => r.body.type === 'message' && r.body.text === 'Local fixture read completed.'));
  assert.equal(listRows(id).some(r => r.body.type === 'notice'), false);
});
for (const source of ['user', 'system'] as const) {
  test(`S-01: ${source} interruption is explicitly attributed`, async () => {
    const id = bot('slow'), count = executions.length;
    enqueue(id, { type: 'user', text: 'Read the local fixture.' });
    await until(() => executions.length > count);
    if (source === 'user') assert.equal((await app.request(`/api/bots/${id}/interrupt`, { method: 'POST', headers: { cookie } })).status, 200);
    else interrupt(id);
    await settleAgentJobs();
    const notice = listRows(id).find(r => r.body.type === 'notice')?.body as any;
    assert.equal(notice.terminal, true);
    assert.match(notice.text, source === 'user' ? /You stopped/ : /server action.*retry/);
    assert.equal(notice.tone, source === 'user' ? 'info' : 'error');
    assert.equal(!!notice.retry, source !== 'user');
  });
}

for (const scenario of ['denied', 'timeout', 'network'] as const) {
  test(`S-02: voice session ${scenario} returns a safe reason and creates no call`, async t => {
    const id = bot('slow');
    const before = listRows(id).length;
    const original = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
      if (!String(input).endsWith('/realtime/client_secrets')) return original(input, init);
      assert.ok(init.signal instanceof AbortSignal);
      if (scenario === 'denied') return Response.json({ error: 'private provider detail' }, { status: 403 });
      if (scenario === 'timeout') throw new DOMException('private provider detail', 'TimeoutError');
      throw new Error('private provider detail');
    });
    const response = await app.request('/api/voice/session', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ botId: id }) });
    assert.equal(response.status, 502);
    const body = await response.json() as any;
    assert.match(body.error, scenario === 'denied' ? /rejected.*permissions/ : scenario === 'timeout' ? /timed out/ : /could not be reached/);
    assert.doesNotMatch(body.error, /private provider detail/);
    assert.equal(listRows(id).length, before);
  });
}
