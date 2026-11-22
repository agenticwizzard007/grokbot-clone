import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exchanges-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(storage, 'app.db'), FILES_DIR: path.join(storage, 'files'), SESSION_SECRET: 'exchanges-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0' });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../server/src/bots.js');
const { clearConversation } = await import('../server/src/store.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const requests = await import('../server/src/coordination/requests.js');
const { listAgentExchanges, readAgentExchange } = await import('../server/src/coordination/exchanges.js');
const { coordinationApi } = await import('../server/src/routes-coordination.js');
const { groupExchanges } = await import('../web/src/lib/agentExchanges.js');
requests.configureCoordinationRuntime({ enqueue: (id, trigger) => acceptJob(id, trigger).id, interrupt() {} });
let sequence = 0;
function fixture() {
  const userId = `exchange-owner-${++sequence}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Owner', Date.now());
  const bots = ['Quinn', 'Research', 'Writer'].map((name, index) => createBot(userId, { name, isPrimary: index === 0 }));
  for (const bot of bots) db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(bot.id);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(userId, userId, Date.now(), Date.now() + 60_000);
  const send = (from = 0, to = 1, text = 'Inspect the evidence', parentRequestId?: string) => requests.enqueueInternalMessage(bots[from].id, bots[to].id, text, 0, { parentRequestId, idempotencyKey: `${from}:${to}:${text}` });
  return { userId, bots, send, list: (generation = 1, before?: number, limit?: number) => listAgentExchanges(userId, bots[0].id, generation, before, limit) };
}
after(() => { db.close(); fs.rmSync(storage, { recursive: true, force: true }); });

test('three-agent thread reports actual request/reply count, unique avatars and exact recorded messages', () => {
  const f = fixture(), first = f.send();
  const second = f.send(1, 2, 'Check the sources', first);
  const third = f.send(2, 1, 'Sources checked', second);
  f.send(1, 0, 'Here are the sources', third);
  f.send(1, 2, 'One final check', first);
  assert.equal(f.send(), first, 'replayed dispatch is still one message');
  const result = f.list();
  assert.equal(result.exchanges.length, 1);
  const summary = result.exchanges[0];
  assert.equal(summary.messageCount, 5);
  assert.deepEqual(new Set(summary.participants.map(p => p.id)), new Set(f.bots.map(b => b.id)));
  assert.equal(summary.participants.length, 3);
  assert.ok(summary.participants.every(p => p.avatarShape && p.avatarColor));
  assert.equal(JSON.stringify(summary).includes('Check the sources'), false, 'collapsed summaries contain no message text');
  const detail = readAgentExchange(f.userId, f.bots[0].id, 1, first);
  assert.equal(detail.messages.length, 5);
  assert.deepEqual(detail.messages.map(m => m.text), ['Inspect the evidence', 'Check the sources', 'Sources checked', 'Here are the sources', 'One final check']);
  assert.equal(detail.messages[1].fromBotId, f.bots[1].id);
  assert.equal(detail.messages[1].toBotId, f.bots[2].id);
  assert.equal(detail.messages[4].status, 'deferred', 'queued work is not labeled delivered/completed');
});

test('recorded automatic result counts once without duplicating request.result', () => {
  const f = fixture(), id = f.send(), request = requests.getInternalRequest(f.userId, id);
  requests.onInternalJobFinished({ userId: f.userId, botId: f.bots[1].id, jobId: request.jobId!, status: 'completed', finalText: 'Actual result' });
  assert.equal(f.list().exchanges[0].messageCount, 2);
  const messages = readAgentExchange(f.userId, f.bots[0].id, 1, id).messages;
  assert.equal(messages[1].kind, 'result');
  assert.match(messages[1].text, /Actual result/);
  assert.equal(messages[1].fromBotId, f.bots[1].id);
});

test('read endpoints are scoped to owner, participating agent and current generation', async () => {
  const f = fixture(), other = fixture(), id = f.send();
  const base = `?botId=${f.bots[0].id}&generation=1`;
  assert.equal((await coordinationApi.request(`/exchanges${base}`)).status, 401);
  const headers = { cookie: `swarm_session=${other.userId}` };
  assert.equal((await coordinationApi.request(`/exchanges${base}`, { headers })).status, 404);
  assert.equal((await coordinationApi.request(`/exchanges/${id}${base}`, { headers })).status, 404);
  assert.throws(() => readAgentExchange(f.userId, f.bots[2].id, 1, id), /not found/);
  const ownHeaders = { cookie: `swarm_session=${f.userId}` };
  const valid = await coordinationApi.request(`/exchanges${base}`, { headers: ownHeaders });
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal((await valid.json()).exchanges.length, 1);
  for (const query of [`?botId=${f.bots[0].id}&generation=0`, `${base}&limit=100000`, `${base}&before=1.5`]) assert.equal((await coordinationApi.request(`/exchanges${query}`, { headers: ownHeaders })).status, 400);
});

test('clearing chat hides the old thread, including late replies; new threads bind to the new generation', () => {
  const f = fixture(), id = f.send();
  clearConversation(f.bots[0].id);
  f.send(1, 0, 'Late old result', id);
  assert.equal(f.list(2).exchanges.length, 0);
  assert.throws(() => f.list(1), /not found/);
  assert.throws(() => readAgentExchange(f.userId, f.bots[0].id, 2, id), /not found/);
  const next = f.send(0, 2, 'New task');
  assert.deepEqual(f.list(2).exchanges.map(e => e.id), [next]);
  assert.equal(listAgentExchanges(f.userId, f.bots[1].id, 1).exchanges[0].id, id, 'other agent retains its own conversation');
});

test('legacy records are shown only in a never-cleared chat', () => {
  const f = fixture(), id = f.send();
  db.prepare("UPDATE native_events SET data='{}' WHERE source_id=? AND kind='coordination.requested'").run(id);
  assert.equal(f.list().exchanges.length, 1);
  clearConversation(f.bots[0].id);
  assert.equal(f.list(2).exchanges.length, 0);
});

test('stable cursors paginate summaries and bound message reads without gaps or duplicates', t => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  const f = fixture();
  for (let n = 0; n < 4; n++) f.send(0, 1, `Task ${n}`);
  const first = f.list(1, undefined, 2), second = f.list(1, first.nextBefore!, 2);
  assert.equal(first.exchanges.length, 2); assert.equal(second.exchanges.length, 2); assert.equal(second.nextBefore, null);
  assert.equal(new Set([...first.exchanges, ...second.exchanges].map(e => e.id)).size, 4);
  const id = first.exchanges[0].id;
  f.send(1, 0, 'Reply', id);
  const summary = f.list().exchanges.find(e => e.id === id)!;
  f.send(1, 2, 'Later message outside snapshot', id);
  const a = readAgentExchange(f.userId, f.bots[0].id, 1, id, 0, summary.lastSeq, 1);
  const b = readAgentExchange(f.userId, f.bots[0].id, 1, id, a.nextAfter!, summary.lastSeq, 1);
  assert.equal(b.nextAfter, null); assert.equal(b.messages[0].text, 'Reply');
});

test('inspecting conversations enqueues no work, writes no transcript/history and emits no native events', () => {
  const f = fixture(), id = f.send();
  const before = db.prepare('SELECT total_changes() n').get();
  for (let n = 0; n < 3; n++) { f.list(); readAgentExchange(f.userId, f.bots[0].id, 1, id); }
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), before);
  assert.equal((db.prepare('SELECT count(*) n FROM rows WHERE bot_id=?').get(f.bots[0].id) as any).n, 0);
});

test('adjacent threads combine into one row without crossing visible messages or long gaps', () => {
  const f = fixture(); f.send(); f.send(0, 2, 'Write the report');
  const summaries = f.list().exchanges.sort((a, b) => a.firstSeq - b.firstSeq).map((s, n) => ({ ...s, createdAt: 1000 + n * 1000 }));
  assert.equal(groupExchanges(summaries, []).length, 1);
  assert.equal(groupExchanges(summaries, [{ createdAt: 1500, body: { type: 'message' } } as any]).length, 2);
  assert.equal(groupExchanges([summaries[0], { ...summaries[1], createdAt: 1_000_000 }], []).length, 2);
});

test('R2F-002: result messages and request records show no raw request ids to the client', async () => {
  const f = fixture(), id = f.send(), request = requests.getInternalRequest(f.userId, id);
  requests.onInternalJobFinished({ userId: f.userId, botId: f.bots[1].id, jobId: request.jobId!, status: 'completed', finalText: `Done; see ${id} and account ca_KIxihCKrE-D2.` });
  const stored = db.prepare("SELECT text FROM coordination_requests WHERE user_id=? AND kind='result'").get(f.userId) as { text: string };
  assert.match(stored.text, /^\[Internal result for request req_/, 'the receiving model keeps the machine header');
  const messages = readAgentExchange(f.userId, f.bots[0].id, 1, id).messages;
  assert.equal(messages[1].kind, 'result');
  assert.equal(messages[1].text, 'Done; see request and account.');
  const headers = { cookie: `swarm_session=${f.userId}` };
  const detail = await (await coordinationApi.request(`/exchanges/${id}?botId=${f.bots[0].id}&generation=1`, { headers })).json();
  assert.doesNotMatch(JSON.stringify(detail.messages.map((m: any) => m.text)), /\b(ca|req|apr)_[A-Za-z0-9_-]{6,}/);
  const records = await (await coordinationApi.request('/requests', { headers })).json();
  assert.ok(records.requests.length >= 2);
  for (const record of records.requests) {
    for (const field of [record.text, record.result, record.reason]) if (field) assert.doesNotMatch(field, /\b(ca|req|apr)_[A-Za-z0-9_-]{6,}/);
  }
});
