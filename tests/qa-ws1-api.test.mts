// WS1 server API and security checks (QA master fix 2026-11-22). Isolated database, no network, no model.
//   node --import tsx --test tests/qa-ws1-api.test.mts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-qa-ws1-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'qa-ws1-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '' });
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in WS1 tests'); });

const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { Hono } = await import('hono');
const { createBot } = await import('../server/src/bots.js');
const { appendRow, getRow } = await import('../server/src/store.js');
const { hub } = await import('../server/src/lib/hub.js');
const { api, SseQueue, SSE_QUEUE_CAP, MAX_MESSAGE_CHARS } = await import('../server/src/routes.js');
const { workflowApi } = await import('../server/src/routes-workflows.js');
const { attentionApi } = await import('../server/src/routes-attention.js');
const { apiErrorHandler } = await import('../server/src/lib/json.js');
const { securityHeaders, publicHealth, serverTimingForUsers, withHeadSupport } = await import('../server/src/security/request.js');
const { getCheckins } = await import('../server/src/proactive.js');

// The same composition as tenant-app.ts, without starting a server.
const app = new Hono();
app.use('*', securityHeaders);
app.onError(apiErrorHandler);
app.use('/api/*', serverTimingForUsers);
app.get('/api/health', publicHealth);
app.route('/api/workflows', workflowApi);
app.route('/api', attentionApi);
app.route('/api', api);
app.get('*', (c) => c.html('<!doctype html><div id="root"></div>'));

for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
const session = 'qa-ws1-session';
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(session, 'owner', Date.now(), Date.now() + 600_000);
const call = (method: string, url: string, body?: unknown, raw?: string) => app.request(url, {
  method, headers: { cookie: `swarm_session=${session}`, ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
});

const primary = createBot('owner', { name: 'Chief', isPrimary: true });
const worker = createBot('owner', { name: 'Worker', label: 'Research', description: 'Finds things', instructions: 'Be brief.' });
const foreign = createBot('other', { name: 'Foreign', isPrimary: true });
const botRow = (id: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(id) as any;
const revision = (id: string) => (db.prepare('SELECT revision FROM bot_setups WHERE bot_id=?').get(id) as any).revision as number;
const rowCount = (id: string) => (db.prepare('SELECT count(*) n FROM rows WHERE bot_id=?').get(id) as any).n as number;

after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('MF-001 public health is exactly {"ok":true} and not cacheable', async () => {
  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['ok']);
  assert.equal(body.ok, true);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('server-timing'), null);
});

test('MF-002 security headers on the HTML shell, health and auth/me', async () => {
  const html = await app.request('/', { headers: { 'x-forwarded-proto': 'https' } });
  const csp = html.headers.get('content-security-policy') ?? '';
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "default-src 'self'"]) assert.ok(csp.includes(directive), directive);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(html.headers.get('referrer-policy'));
  assert.equal(html.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  for (const route of ['/api/health', '/api/auth/me']) {
    const res = await app.request(route);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', route);
    assert.equal(res.headers.get('cache-control'), 'no-store', route);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', route);
  }
  // Signed-in requests may carry handler timing; public ones do not.
  assert.ok((await call('GET', '/api/bots')).headers.get('server-timing'));
  assert.equal((await app.request('/api/auth/me')).headers.get('server-timing'), null);
});

test('MF-063 HEAD answers with a length and no body, and does not read event streams', async () => {
  const head = withHeadSupport(app.fetch);
  const res = await head(new Request('http://local/api/health', { method: 'HEAD' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '11');
  assert.equal(res.body, null);
  const stream = await Promise.race([
    head(new Request('http://local/api/events', { method: 'HEAD', headers: { cookie: `swarm_session=${session}` } })),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('HEAD on SSE hung')), 3000)),
  ]);
  assert.equal(stream.status, 200);
  assert.equal(stream.body, null);
});

const malformed: [string, string][] = [
  ['POST', '/api/bots'],
  ['PATCH', `/api/bots/${worker.id}`],
  ['POST', `/api/bots/${worker.id}/messages`],
  ['POST', '/api/approvals/apr_missing'],
  ['POST', `/api/bots/${worker.id}/cards/1/answer`],
  ['PATCH', '/api/routines/rt_missing'],
  ['POST', '/api/workflows/goals'],
  ['POST', '/api/workflows/goals/goal_x/control'],
  ['PATCH', '/api/auth/me'],
];
for (const [method, url] of malformed) {
  test(`MF-014 malformed JSON on ${method} ${url} is a 400`, async () => {
    const res = await call(method, url, undefined, '{');
    // The routine route checks ownership first; a 404 is also not a 500.
    assert.ok(res.status === 400 || (url.includes('rt_missing') && res.status === 404), `status ${res.status}`);
    assert.notEqual(res.status, 500);
    const text = await res.text();
    assert.ok(!/at .*\.ts:\d+/.test(text), 'no stack trace');
  });
}

test('MF-014 app error handler maps ZodError and SyntaxError to 400 without leaking', async () => {
  const { z } = await import('zod');
  const probe = new Hono();
  probe.onError(apiErrorHandler);
  probe.post('/zod', () => { z.object({ a: z.string() }).parse({ a: 1 }); return new Response('unreachable'); });
  probe.post('/json', async (c) => c.json(await c.req.json()));
  probe.post('/boom', () => { throw new Error('secret internal detail'); });
  const zod = await probe.request('/zod', { method: 'POST' });
  assert.equal(zod.status, 400);
  assert.match((await zod.json()).error, /Invalid a/);
  assert.equal((await probe.request('/json', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status, 400);
  const boom = await probe.request('/boom', { method: 'POST' });
  assert.equal(boom.status, 500);
  assert.ok(!(await boom.text()).includes('secret internal detail'));
});

test('MF-003 invalid bot patches are 400 and change nothing', async () => {
  const before = botRow(worker.id);
  const bad = [
    { name: '' },
    { name: '   ' },
    { label: 'x'.repeat(41) },
    { mode: 'admin' },
    { name: 'Valid', voice: { a: 1 } },
    { name: 'Valid', unknownField: true },
    { description: 'x'.repeat(301) },
    { instructions: 'x'.repeat(8001) },
    { voiceSpeed: 9 },
    { avatarColor: 'plaid' },
    { pinned: 'yes' },
    { effort: 'turbo' },
  ];
  for (const patch of bad) {
    const res = await call('PATCH', `/api/bots/${worker.id}`, patch);
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.ok((await res.json()).error);
  }
  const afterRow = botRow(worker.id);
  for (const key of ['name', 'label', 'description', 'instructions', 'mode', 'voice', 'voice_speed', 'pinned', 'effort', 'updated_at']) assert.deepEqual(afterRow[key], before[key], key);
  assert.equal((await call('PATCH', `/api/bots/${foreign.id}`, { name: 'Mine' })).status, 404);
});

test('MF-003 a valid partial patch applies every field at once', async () => {
  const res = await call('PATCH', `/api/bots/${worker.id}`, { label: 'Inbox', voiceSpeed: 1.15, pinned: true, model: '  ', fast: true });
  assert.equal(res.status, 200);
  const { bot } = await res.json();
  assert.equal(bot.label, 'Inbox');
  assert.equal(bot.voiceSpeed, 1.15);
  assert.equal(bot.pinned, true);
  assert.equal(bot.model, null);
  assert.equal(bot.fast, true);
  // The optimistic instructions edit still detects a concurrent change.
  const stale = await call('PATCH', `/api/bots/${worker.id}`, { instructions: 'New', expectedInstructions: 'not the current text' });
  assert.equal(stale.status, 409);
  assert.equal(botRow(worker.id).instructions, 'Be brief.');
  const fresh = await call('PATCH', `/api/bots/${worker.id}`, { instructions: 'New', expectedInstructions: 'Be brief.' });
  assert.equal(fresh.status, 200);
  assert.equal(botRow(worker.id).instructions, 'New');
});

test('MF-013 only brief fields bump the setup revision', async () => {
  const start = revision(worker.id);
  const nonBrief = [{ effort: 'high' }, { model: 'some/model' }, { fast: false }, { voice: 'rex' }, { voiceSpeed: 1.3 }, { voiceLanguage: 'en' }, { pinned: false }, { avatarColor: 'green' }];
  for (const patch of nonBrief) {
    assert.equal((await call('PATCH', `/api/bots/${worker.id}`, patch)).status, 200);
    assert.equal(revision(worker.id), start, JSON.stringify(patch));
  }
  // Sending the stored value again is not a change either.
  assert.equal((await call('PATCH', `/api/bots/${worker.id}`, { name: 'Worker' })).status, 200);
  assert.equal(revision(worker.id), start);
  for (const [i, patch] of [{ name: 'Worker Two' }, { label: 'Ops' }, { description: 'Other' }, { instructions: 'Changed' }, { mode: 'teammate' }].entries()) {
    assert.equal((await call('PATCH', `/api/bots/${worker.id}`, patch)).status, 200);
    assert.equal(revision(worker.id), start + i + 1, JSON.stringify(patch));
  }
});

test('MF-009 oversize messages are 413 and append nothing', async () => {
  const before = rowCount(worker.id);
  const res = await call('POST', `/api/bots/${worker.id}/messages`, { text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'Message is too long (max 32,000 characters).' });
  assert.equal(rowCount(worker.id), before);
  assert.equal((await call('POST', `/api/bots/${worker.id}/messages`, { text: 42 })).status, 400);
  const card = appendRow(worker.id, 'card', { type: 'card', card: 'question', question: 'Color?', options: [], status: 'pending' } as any);
  const answer = await call('POST', `/api/bots/${worker.id}/cards/${card.seq}/answer`, { answer: 'x'.repeat(MAX_MESSAGE_CHARS + 1) });
  assert.equal(answer.status, 413);
  assert.equal((getRow(worker.id, card.seq)!.body as any).status, 'pending');
  db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=?').run(worker.id, card.seq);
});

test('MF-021 routine enabled must be a boolean', async () => {
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES ('rt_qa',?,?,?,?,?,0,?)").run(worker.id, 'Daily', 'Do it', '0 9 * * *', 'UTC', Date.now());
  for (const body of [{ enabled: 'false' }, { enabled: 1 }, {}, { enabled: true, extra: 1 }]) {
    assert.equal((await call('PATCH', '/api/routines/rt_qa', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((db.prepare("SELECT enabled FROM routines WHERE id='rt_qa'").get() as any).enabled, 0);
});

test('MF-032 approval decision and rows limit are validated', async () => {
  assert.equal((await call('POST', '/api/approvals/apr_missing', { decision: 'maybe' })).status, 400);
  assert.equal((await call('POST', '/api/approvals/apr_missing', { decision: 'deny' })).status, 404);
  assert.equal((await call('GET', `/api/bots/${worker.id}/rows?limit=foo`)).status, 400);
  assert.equal((await call('GET', `/api/bots/${worker.id}/rows?beforeSeq=abc`)).status, 400);
  const one = await call('GET', `/api/bots/${worker.id}/rows?limit=-5`);
  assert.equal(one.status, 200);
  assert.ok((await one.json()).rows.length <= 1);
  assert.equal((await call('GET', `/api/bots/${worker.id}/rows`)).status, 200);
});

test('MF-012 needs-you lists setup reviews, approvals, questions and connect cards', async () => {
  const reviewer = createBot('owner', { name: 'Reviewer' });
  db.prepare("UPDATE bot_setups SET onboarding_status='review' WHERE bot_id=?").run(reviewer.id);
  const approvalRow = appendRow(primary.id, 'card', { type: 'card', card: 'approval', approvalId: 'apr_qa', title: 'Allow Chief to send an email?', detail: '', tool: 'GMAIL_SEND_EMAIL', args: {}, status: 'pending' } as any);
  db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES ('apr_qa',?,?,?,?, 'pending', ?)").run(primary.id, approvalRow.seq, 'call_1', 'GMAIL_SEND_EMAIL', Date.now());
  const question = appendRow(primary.id, 'card', { type: 'card', card: 'question', question: 'Which inbox?', options: [], status: 'pending' } as any);
  appendRow(primary.id, 'card', { type: 'card', card: 'question', question: 'Old one', options: [], status: 'answered', answer: 'x' } as any);
  appendRow(primary.id, 'card', { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'Read mail', status: 'pending' } as any);
  appendRow(foreign.id, 'card', { type: 'card', card: 'question', question: 'Not yours', options: [], status: 'pending' } as any);
  const res = await call('GET', '/api/needs-you');
  assert.equal(res.status, 200);
  const { items } = await res.json() as { items: any[] };
  const types = items.map((i) => i.type).sort();
  assert.ok(types.includes('setup_review') && types.includes('approval') && types.includes('question') && types.includes('connect'), JSON.stringify(types));
  assert.ok(items.every((i) => i.botId !== foreign.id));
  const q = items.find((i) => i.type === 'question' && i.botId === primary.id);
  assert.equal(q.seq, question.seq);
  assert.equal(q.title, 'Which inbox?');
  for (const item of items) for (const key of ['id', 'type', 'botId', 'botName', 'title', 'createdAt', 'seq']) assert.ok(key in item, key);
  const setup = items.find((i) => i.type === 'setup_review' && i.botId === reviewer.id);
  assert.equal(setup.seq, null);
  // Resolving the approval removes it.
  db.prepare("UPDATE approvals SET status='denied' WHERE id='apr_qa'").run();
  const after = (await (await call('GET', '/api/needs-you')).json()).items as any[];
  assert.ok(!after.some((i) => i.type === 'approval'));
  assert.equal((await app.request('/api/needs-you')).status, 401);
});

test('MF-012 answering a question card emits a tasks event', async () => {
  const card = appendRow(primary.id, 'card', { type: 'card', card: 'question', question: 'Pick one', options: [], status: 'pending' } as any);
  const events: any[] = [];
  const off = hub.subscribe('owner', (ev) => events.push(ev));
  const res = await call('POST', `/api/bots/${primary.id}/cards/${card.seq}/answer`, { answer: 'Blue' });
  off();
  assert.equal(res.status, 200);
  assert.ok(events.some((e) => e.type === 'tasks' && e.botId === primary.id));
});

test('MF-017 PATCH auth/me validates the time zone and moves UTC fallback schedules', async () => {
  assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'Asia/Dubai', name: 'x' })).status, 400);
  getCheckins('owner'); // creates the schedule tables
  db.prepare("INSERT INTO proactivity(user_id,enabled,times,timezone,quiet_hours,timezone_source,updated_at) VALUES ('owner',1,'[\"09:00\"]','UTC','[]','utc_fallback',?)").run(Date.now());
  const res = await call('PATCH', '/api/auth/me', { timezone: 'Asia/Dubai' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.timezone, 'Asia/Dubai');
  const me = await (await call('GET', '/api/auth/me')).json();
  assert.equal(me.user.timezone, 'Asia/Dubai');
  const checkins = getCheckins('owner');
  assert.equal(checkins.timezone, 'Asia/Dubai');
  assert.equal(checkins.timezoneSource, 'account');
  // An explicit schedule zone is not overwritten.
  db.prepare("UPDATE proactivity SET timezone='Europe/London', timezone_source='explicit' WHERE user_id='owner'").run();
  assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'America/New_York' })).status, 200);
  assert.equal(getCheckins('owner').timezone, 'Europe/London');
});

test('MF-044 goals can be deleted only after they stop, and then leave the list', async () => {
  const created = await call('POST', '/api/workflows/goals', { botId: primary.id, start: false, title: 'QA goal', criteria: [{ description: 'Done', kind: 'result' }] });
  assert.equal(created.status, 201);
  const { goal } = await created.json();
  assert.equal((await call('DELETE', `/api/workflows/goals/${goal.id}`)).status, 409);
  assert.equal((await call('POST', `/api/workflows/goals/${goal.id}/control`, { action: 'stop' })).status, 200);
  assert.equal((await call('DELETE', `/api/workflows/goals/${goal.id}`)).status, 200);
  const list = await (await call('GET', '/api/workflows')).json();
  assert.ok(!list.goals.some((g: any) => g.id === goal.id));
  assert.ok((db.prepare('SELECT archived_at FROM native_goals WHERE id=?').get(goal.id) as any).archived_at > 0);
  assert.equal((await call('DELETE', `/api/workflows/goals/${goal.id}`)).status, 404);
});

test('MF-011 SSE queue coalesces stale snapshots per bot instead of aborting', () => {
  const queue = new SseQueue();
  for (let i = 0; i < SSE_QUEUE_CAP * 2; i++) assert.equal(queue.push({ type: 'live', state: { botId: 'a', isRunning: i % 2 === 0, activity: null } as any }), true);
  queue.push({ type: 'live', state: { botId: 'b', isRunning: true, activity: null } as any });
  queue.push({ type: 'tasks', botId: 'a' });
  assert.equal(queue.length, 3);
  assert.equal(JSON.parse(queue.shift()!).state.botId, 'a');
  const capped = new SseQueue();
  for (let i = 0; i < SSE_QUEUE_CAP; i++) capped.push({ type: 'tasks', botId: String(i) });
  assert.equal(capped.push({ type: 'tasks', botId: 'over' }), false);
});

test('MF-019 a failed computer wake is reported instead of swallowed', async () => {
  const { computers } = await import('../server/src/computers/index.js');
  const { wakeComputer, computerView } = await import('../server/src/routes.js');
  const original = computers.ensure;
  computers.ensure = async () => { throw new Error('No capacity in region'); };
  const events: any[] = [];
  const off = hub.subscribe('owner', (ev) => events.push(ev));
  try {
    await wakeComputer('owner');
    const state = computerView('owner');
    assert.equal(state.error, 'No capacity in region');
    assert.ok(events.some((e) => e.type === 'computer' && e.state.error === 'No capacity in region'));
    computers.ensure = async () => {};
    await wakeComputer('owner');
    assert.notEqual(computerView('owner').error, 'No capacity in region');
  } finally { off(); computers.ensure = original; }
});
