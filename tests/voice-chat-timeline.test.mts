import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-chat-timeline-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'https://model.fixture/v1', LLM_PROVIDER: 'direct', OPENROUTER_API_KEY: '', INKBOX_TUNNEL: '0' });
const { executions, executionArgs } = await import('./fixtures/voice-chat-backends.mjs');
await import('../server/src/db-config.js');
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { settleAgentJobs } = await import('../server/src/agent/loop.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/src/routes.js');
const { hub } = await import('../server/src/lib/hub.js');
const app = new Hono().route('/api', api);
const userId = 'fixture-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, 'fixture@example.test', 'Fixture account', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('fixture-session', userId, Date.now(), Date.now() + 3600000);
const request = async (url: string, body?: unknown) => {
  const response = await app.request(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: 'swarm_session=fixture-session', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200, `${url}: ${response.status}`);
  return response.json() as Promise<any>;
};
const rows = async (id: string) => (await request(`/bots/${id}/rows`)).rows as any[];
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
for (const decision of ['deny', 'allow', 'always'] as const) {
  test(`voice approval persists once, emits SSE, resolves through main chat (${decision}) and reports outcome`, async () => {
    db.prepare('DELETE FROM policies WHERE user_id=?').run(userId);
    const bot = createBot(userId, { name: 'Voice fixture', isPrimary: true });
    const events: any[] = [];
    const unsubscribe = hub.subscribe(userId, event => events.push(event));
    try {
      const call = await request('/voice/session', { botId: bot.id });
      const payload = { botId: bot.id, callId: call.callId, name: 'send_task', args: { request: 'Prepare an email draft for review.' }, toolCallId: `fixture-${decision}` };
      const assigned = await request('/voice/tool', payload);
      await settleAgentJobs();
      const before = executions.length;
      const card = (await rows(bot.id)).find(r => r.body.card === 'approval');
      assert.ok(card); assert.equal(card.body.jobId, assigned.taskId);
      assert.deepEqual(card.body.args, executionArgs);
      assert.ok(events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.seq === card.seq && r.body.approvalId === card.body.approvalId && r.body.status === 'pending')));
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await request('/voice/tool', payload), assigned);
        const update = await request('/voice/updates', { botId: bot.id, callId: call.callId, after: 0 });
        assert.ok(!('approvals' in update) && !('connectionRequests' in update));
        assert.equal((await rows(bot.id)).filter(r => r.body.approvalId === card.body.approvalId).length, 1);
      }
      assert.equal(executions.length, before);
      await request(`/approvals/${card.body.approvalId}`, { decision });
      await settleAgentJobs();
      const status = decision === 'deny' ? 'denied' : decision === 'allow' ? 'allowed' : 'always';
      assert.equal((await rows(bot.id)).find(r => r.seq === card.seq).body.status, status);
      assert.ok(events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.seq === card.seq && r.body.status === status)));
      const completedRows = await rows(bot.id);
      assert.ok(completedRows.some(r => r.body.type === 'tool-call' && r.body.status === (decision === 'deny' ? 'denied' : 'done')));
      const reply = completedRows.find(r => r.body.type === 'message' && r.body.role === 'assistant' && r.body.text.includes('Request finished in chat'));
      assert.ok(reply, 'the delegated result stays in the normal persisted timeline');
      assert.ok(events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.seq === reply.seq && r.body.text === reply.body.text)));
      const update = await request('/voice/updates', { botId: bot.id, callId: call.callId, after: 0 });
      assert.ok(update.updates.some((u: any) => u.kind === 'status' && u.text.includes(decision === 'deny' ? 'declined in chat' : 'granted in chat')));
      assert.equal(executions.length, before + (decision === 'deny' ? 0 : 1));
      if (decision !== 'deny') assert.deepEqual((executions.at(-1) as any).arguments, executionArgs.arguments);
      await request(`/approvals/${card.body.approvalId}`, { decision });
      await settleAgentJobs();
      assert.equal(executions.length, before + (decision === 'deny' ? 0 : 1));
      await request('/voice/end', { botId: bot.id, callId: call.callId });
    } finally { unsubscribe(); }
  });
}
test('voice connection request persists once in chat and reaches SSE without a voice card projection', async () => {
  const bot = createBot(userId, { name: 'Connection fixture', isPrimary: true });
  const events: any[] = []; const unsubscribe = hub.subscribe(userId, event => events.push(event));
  try {
    const call = await request('/voice/session', { botId: bot.id });
    const payload = { botId: bot.id, callId: call.callId, name: 'send_task', args: { request: 'Connect Slack for this work.' }, toolCallId: 'fixture-connect' };
    const assigned = await request('/voice/tool', payload); await settleAgentJobs();
    const card = (await rows(bot.id)).find(r => r.body.card === 'connect');
    assert.ok(card); assert.equal(card.body.jobId, assigned.taskId);
    assert.ok(events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.seq === card.seq && r.body.card === 'connect')));
    assert.deepEqual(await request('/voice/tool', payload), assigned);
    const snapshot = await request('/voice/updates', { botId: bot.id, callId: call.callId, after: 0 });
    assert.equal('connectionRequests' in snapshot, false);
    assert.ok(snapshot.updates.some((u: any) => u.text.includes('Connect Slack in chat')));
    assert.equal((await rows(bot.id)).filter(r => r.body.card === 'connect').length, 1);
    await request('/voice/end', { botId: bot.id, callId: call.callId });
  } finally { unsubscribe(); }
});

for (const decision of ['deny', 'allow', 'always'] as const) {
  test(`R8 post-call pill follows ${decision} through SSE, reload and voice context`, async () => {
    db.prepare('DELETE FROM policies WHERE user_id=?').run(userId);
    const bot = createBot(userId, { name: 'Post-call fixture', isPrimary: true });
    const call = await request('/voice/session', { botId: bot.id });
    await request('/voice/tool', { botId: bot.id, callId: call.callId, name: 'send_task', args: { request: 'Prepare an email draft for review.' }, toolCallId: `post-call-${decision}` });
    await settleAgentJobs();
    const card = (await rows(bot.id)).find(r => r.body.card === 'approval');
    const ended = await request('/voice/end', { botId: bot.id, callId: call.callId });
    const pending = (await rows(bot.id)).find(r => r.seq === ended.seq);
    assert.match(pending.body.text, /1 approval from this call is still pending.*Release review/);
    assert.equal(pending.body.call.approvals[0].approvalId, card.body.approvalId);
    const stored = JSON.parse((db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(bot.id, ended.seq) as any).body);
    assert.doesNotMatch(stored.text, /pending/);
    const events: any[] = [];
    const unsubscribe = hub.subscribe(userId, event => events.push(event));
    const wording = decision === 'deny' ? /was not allowed/ : /was allowed/;
    try {
      await request(`/approvals/${card.body.approvalId}`, { decision });
      await settleAgentJobs();
      const live = events.flatMap(e => e.type === 'rows' ? e.rows : []).find(r => r.seq === ended.seq && r.botId === bot.id);
      assert.ok(live, 'decision publishes the linked call row to existing SSE clients');
      assert.ok(live.updatedSeq > pending.updatedSeq);
      assert.match(live.body.text, wording); assert.doesNotMatch(live.body.text, /pending/);
      const reloaded = (await rows(bot.id)).find(r => r.seq === ended.seq);
      assert.equal(reloaded.body.text, live.body.text);
      const { listRows, listRowChanges } = await import('../server/src/store.js');
      const changed = listRows(bot.id, { afterRev: pending.updatedSeq }).find(r => r.seq === ended.seq);
      assert.match((changed!.body as any).text, wording);
      assert.ok(listRowChanges(bot.id, 1, pending.updatedSeq, reloaded.updatedSeq, 1).some(r => r.seq === ended.seq));
      const next = await request('/voice/session', { botId: bot.id });
      assert.match(next.instructions, wording); assert.doesNotMatch(next.instructions, /still pending/);
      const recalled = await request('/voice/tool', { botId: bot.id, callId: next.callId, name: 'recall_text_messages', args: {} });
      assert.match(recalled.output, wording); assert.doesNotMatch(recalled.output, /still pending/);
      const search = await request('/voice/tool', { botId: bot.id, callId: next.callId, name: 'search_conversations', args: { query: 'Voice call ended' } });
      assert.match(search.output, wording); assert.doesNotMatch(search.output, /still pending/);
      await request('/voice/end', { botId: bot.id, callId: next.callId });
    } finally { unsubscribe(); }
  });
}
