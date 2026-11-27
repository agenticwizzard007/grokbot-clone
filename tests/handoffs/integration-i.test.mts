import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { fixture, output, db, jobs, links, requests, spec, cleanup, createBot } from './server-fixture.test.mts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Provider access is forbidden in integration tests.'); };
const { appendRow } = await import('../../server/src/store.js');
const { api } = await import('../../server/src/routes.js');
const { functionSchemas, toolMap } = await import('../../server/src/agent/tools.js');
const { systemPrompt } = await import('../../server/src/agent/prompt.js');
const { HANDOFF_PROMPT_SECTION } = await import('../../server/src/agent/handoff-prompt.js');
const { getFlow } = await import('../../server/src/flow/cache.js');
requests.configureCoordinationRuntime({ enqueue: (botId, trigger) => jobs.acceptJob(botId, trigger).id, interrupt() {} });
const app = new Hono().route('/api', api);
after(() => { globalThis.fetch = originalFetch; cleanup(); });
const call = (f: ReturnType<typeof fixture>, path: string, method = 'GET', data?: unknown) => app.request(`/api${path}`, { method, headers: f.headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const names = ['submit_output', 'handoff_to_agent', 'read_handoff', 'list_handoffs', 'submit_verdict', 'start_loop', 'write_flow_summary'];

test('production registry exposes all seven bound tools and removes them and the prompt when disabled', async () => {
  const f = fixture();
  const offered = () => functionSchemas(f.maker.id, { userId: f.userId }).map(t => t.name);
  for (const name of names) assert.ok(offered().includes(name), name);
  assert.ok((await systemPrompt(f.userId, f.maker.id)).includes(HANDOFF_PROMPT_SECTION));
  links.updateSettings(f.userId, { enabled: false, agentHandoffs: 'team' });
  for (const name of names) assert.ok(!offered().includes(name), name);
  assert.ok(!(await systemPrompt(f.userId, f.maker.id)).includes(HANDOFF_PROMPT_SECTION));
  links.updateSettings(f.userId, { enabled: true, agentHandoffs: 'team' });
  process.env.HANDOFFS_DISABLED = '1';
  try {
    for (const name of names) assert.ok(!offered().includes(name), name);
    assert.ok(!(await systemPrompt(f.userId, f.maker.id)).includes(HANDOFF_PROMPT_SECTION));
  } finally { delete process.env.HANDOFFS_DISABLED; }
  for (const name of names) assert.ok(!functionSchemas().some(t => t.name === name));
});

test('registered output and Flow tools persist through the production services', async () => {
  const f = fixture(), job = jobs.acceptJob(f.maker.id, { type: 'user', text: 'Fixture request.' });
  jobs.beginJob(job.id);
  const ctx = { userId: f.userId, botId: f.maker.id, jobId: job.id, toolCallId: 'fixture-output', depth: 0, enqueueBotMessage() {} };
  const result = await toolMap.get('submit_output')!.impl({ summary: 'Placeholder result.' }, ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const flow = await toolMap.get('write_flow_summary')!.impl({ steps: [{ label: 'Review the fixture' }] }, { ...ctx, toolCallId: 'fixture-flow' });
  assert.equal(flow.isError, undefined, JSON.stringify(flow));
  assert.equal(getFlow(f.userId, f.maker.id).source, 'agent+auto');
});

test('mounted APIs provide UI envelopes, keep raw identities and end event pagination', async () => {
  const f = fixture(), o = output(f);
  const out = await (await call(f, `/outputs/${o.id}`)).json();
  assert.equal(out.id, o.id); assert.equal(out.output.id, o.id);
  const sent = await call(f, '/handoffs', 'POST', { source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Review placeholder.', returnResult: false, idempotencyKey: 'integration-send' });
  assert.equal(sent.status, 201);
  const handoff = await sent.json(); assert.equal(handoff.id, handoff.handoff.id);
  const detail = await (await call(f, `/handoffs/${handoff.id}`)).json();
  assert.equal(detail.handoff.sourceOutputId, o.id); assert.ok(detail.events.length);
  const created = await (await call(f, '/loops', 'POST', { spec: spec(f), idempotencyKey: 'integration-loop' })).json();
  assert.equal(created.loop.id, created.id);
  const loop = await (await call(f, `/loops/${created.id}`)).json();
  assert.equal(loop.loop.status, 'draft'); assert.deepEqual(loop.steps, []);
  const events = await (await call(f, `/loops/${created.id}/events?limit=200`)).json();
  assert.ok(events.events.length); assert.equal(events.next, null);
  const end = await (await call(f, `/loops/${created.id}/events?after=${events.events.at(-1).seq}&limit=200`)).json();
  assert.deepEqual(end, { events: [], next: null });
  assert.equal((await (await call(f, '/handoff-settings')).json()).settings.enabled, true);
  assert.equal((await call(f, '/handoff-task-links')).status, 200);
});

test('mounted Flow refresh enqueues once and mounted routes retain tenant and flag checks', async () => {
  const f = fixture(), other = fixture();
  assert.equal((await call(f, `/bots/${f.maker.id}/flow`)).status, 200);
  const first = await call(f, `/bots/${f.maker.id}/flow/refresh`, 'POST', {});
  assert.equal(first.status, 200); assert.equal((await first.json()).accepted, true);
  assert.equal((await (await call(f, `/bots/${f.maker.id}/flow/refresh`, 'POST', {})).json()).accepted, false);
  assert.equal((db.prepare("SELECT count(*) n FROM coordination_requests WHERE user_id=? AND idempotency_key LIKE 'flow:%'").get(f.userId) as any).n, 1);
  assert.equal((await call(other, `/bots/${f.maker.id}/flow`)).status, 404);
  assert.equal((await app.request('/api/loops')).status, 401);
  links.updateSettings(f.userId, { enabled: false, agentHandoffs: 'team' });
  for (const path of ['/loops', '/outputs', '/handoffs', `/bots/${f.maker.id}/flow`]) assert.equal((await call(f, path)).status, 503);
});

test('room message snapshots use the speaking member and enforce tenancy, visibility and membership', async () => {
  const f = fixture(), other = fixture();
  const room = createBot(f.userId, { name: 'Placeholder room' });
  db.prepare("UPDATE bots SET kind='room',members=? WHERE id=?").run(JSON.stringify([f.maker.id, f.checker.id]), room.id);
  const row = appendRow(room.id, 'message', { type: 'message', role: 'assistant', text: 'Placeholder room result.', from: { kind: 'bot', id: f.maker.id, name: 'Draft agent' } });
  const ref = { botId: room.id, generation: row.generation, seq: row.seq };
  const response = await call(f, '/outputs/from-message', 'POST', ref);
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.output.botId, f.maker.id);
  assert.equal((await (await call(f, '/outputs/from-message', 'POST', ref)).json()).output.id, result.output.id);
  const sent = await call(f, '/handoffs', 'POST', { source: { outputId: result.id }, toBotId: f.checker.id, roomId: room.id, instruction: 'Review the placeholder.', idempotencyKey: 'room-send' });
  assert.equal(sent.status, 201);
  assert.equal((await call(other, '/outputs/from-message', 'POST', ref)).status, 404);
  db.prepare("UPDATE rows SET body=json_set(body,'$.audience','internal') WHERE bot_id=? AND seq=?").run(room.id, row.seq);
  assert.equal((await call(f, '/outputs/from-message', 'POST', ref)).status, 404);
  db.prepare("UPDATE rows SET body=json_remove(body,'$.audience') WHERE bot_id=? AND seq=?").run(room.id, row.seq);
  db.prepare("UPDATE bots SET members='[]' WHERE id=?").run(room.id);
  assert.equal((await call(f, '/outputs/from-message', 'POST', ref)).status, 404);
  links.updateSettings(f.userId, { enabled: false, agentHandoffs: 'team' });
  assert.equal((await call(f, '/outputs/from-message', 'POST', ref)).status, 503);
});
