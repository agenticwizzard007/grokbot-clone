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
  const warn = mock.method(console, 'warn', () => {});
  try {
    await wakeComputer('owner');
    const state = computerView('owner');
    // R2F-018: the failure is reported with generic copy; the raw provider text stays in the server log.
    assert.equal(state.error, 'The computer could not start. Try again in a minute.');
    assert.equal(state.status, 'error');
    assert.ok(events.some((e) => e.type === 'computer' && e.state.error === 'The computer could not start. Try again in a minute.'));
    computers.ensure = async () => {};
    await wakeComputer('owner');
    assert.notEqual(computerView('owner').error, 'The computer could not start. Try again in a minute.');
  } finally { off(); warn.mock.restore(); computers.ensure = original; }
});

// ---------- Round 2 (MASTER-FIX-R2) ----------

test('R2F-002 redactInternalIds replaces internal ids with neutral labels and leaves ordinary words', async () => {
  const { redactInternalIds, displayCoordinationText, hasInternalId } = await import('../server/src/lib/redact.js');
  const { newId } = await import('../server/src/lib/ids.js');
  assert.equal(redactInternalIds('Slack account ca_KIxihCKrE-D2 and Gmail account ca_pESfPrEqcgnN'), 'Slack account and Gmail account');
  assert.equal(redactInternalIds('See req_11ev-EvIvCvn.'), 'See request.');
  for (const [prefix, label] of [['req', 'request'], ['apr', 'approval'], ['cli', 'tool call'], ['call', 'tool call'], ['job', 'job'], ['room', 'group chat'], ['bot', 'a Bot']]) {
    for (let i = 0; i < 20; i++) {
      const id = newId(prefix);
      if (!/[A-Z0-9]/.test(id.slice(prefix.length + 1))) continue; // an all lower case draw reads as an ordinary word
      assert.equal(redactInternalIds(`x ${id}, y`), `x ${label}, y`, id);
    }
  }
  assert.equal(redactInternalIds('Ask bot_AbCdEf123456 now', { botName: (id) => id === 'bot_AbCdEf123456' ? 'Research' : undefined }), 'Ask Research now');
  for (const keep of ['call_center_notes', 'bot_configuration', 'req_docs', 'a ca_ prefix', 'prereq_AbCdEf123456', 'https://example.com/ca_docs']) assert.equal(redactInternalIds(keep), keep);
  assert.equal(hasInternalId('ok'), false);
  assert.equal(hasInternalId('ca_KIxihCKrE-D2'), true);
  assert.equal(displayCoordinationText('[Internal result for request req_11ev-EvIvCvn; execution finished; acceptance still requires evidence]\nAll done for ca_KIxihCKrE-D2.'), 'All done for connected account.');
  assert.equal(displayCoordinationText('Plain request text'), 'Plain request text');
});

test('R2F-017 two consecutive account zone changes both move the schedule, emit a synopses event, and new routines use the account zone', async () => {
  const { tickProactive, accountTimezone } = await import('../server/src/proactive.js');
  const { toolMap } = await import('../server/src/agent/tools.js');
  getCheckins('owner');
  // A schedule that follows the account zone, quiet all day so discovery records due slots without running a synopsis.
  db.prepare(`UPDATE proactivity SET enabled=1, times='["09:00"]', timezone='UTC', timezone_source='utc_fallback', quiet_hours='[{"start":"00:00","end":"00:00"}]', discovered_local=NULL, last_fired=NULL WHERE user_id='owner'`).run();
  const slot = () => db.prepare("SELECT slot_key, timezone FROM proactive_due_slots WHERE user_id='owner' AND status='pending' ORDER BY slot_key DESC LIMIT 1").get() as { slot_key: string; timezone: string } | undefined;
  const events: any[] = [];
  const off = hub.subscribe('owner', (ev) => events.push(ev));
  try {
    assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'Asia/Dubai' })).status, 200);
    assert.deepEqual([getCheckins('owner').timezone, getCheckins('owner').timezoneSource], ['Asia/Dubai', 'account']);
    assert.ok(events.some((e) => e.type === 'synopses'), 'zone change emits a synopses event');
    tickProactive(Date.parse('2030-01-02T05:30:00Z')); // 09:30 in Dubai
    assert.deepEqual(slot(), { slot_key: '2030-01-02 09:00', timezone: 'Asia/Dubai' });
    events.length = 0;
    // Second change: before R2F-017 only utc_fallback rows moved, so the schedule kept Dubai.
    assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'Europe/London' })).status, 200);
    assert.deepEqual([getCheckins('owner').timezone, getCheckins('owner').timezoneSource], ['Europe/London', 'account']);
    assert.equal(slot(), undefined, 'slots computed in the old zone are recomputed');
    assert.ok(events.some((e) => e.type === 'synopses'));
    tickProactive(Date.parse('2030-01-03T09:30:00Z')); // 09:30 in London
    assert.deepEqual(slot(), { slot_key: '2030-01-03 09:00', timezone: 'Europe/London' });
    // A new routine without an explicit zone uses the account zone; an explicit zone is kept.
    assert.equal(accountTimezone('owner'), 'Europe/London');
    const ctx = { userId: 'owner', botId: worker.id, depth: 0, enqueueBotMessage: () => undefined };
    const madeResult = await toolMap.get('create_routine')!.impl({ name: 'Morning', prompt: 'Say hi', schedule: '0 9 * * *' }, ctx);
    assert.match(String(madeResult.output), /Created the routine "Morning"/);
    const made = { routine: db.prepare('SELECT * FROM routines WHERE bot_id=? AND name=?').get(ctx.botId, 'Morning') as any };
    assert.equal(made.routine.timezone, 'Europe/London');
    await toolMap.get('create_routine')!.impl({ name: 'Evening', prompt: 'Say bye', schedule: '0 18 * * *', timezone: 'Asia/Tokyo' }, ctx);
    const explicit = { routine: db.prepare('SELECT * FROM routines WHERE bot_id=? AND name=?').get(ctx.botId, 'Evening') as any };
    assert.equal(explicit.routine.timezone, 'Asia/Tokyo');
    const { unscheduleRoutine } = await import('../server/src/routines.js');
    for (const r of [made.routine, explicit.routine]) unscheduleRoutine(r.id);
    // Explicit schedule overrides never move.
    db.prepare("UPDATE proactivity SET timezone='America/Chicago', timezone_source='explicit' WHERE user_id='owner'").run();
    assert.equal((await call('PATCH', '/api/auth/me', { timezone: 'Asia/Dubai' })).status, 200);
    assert.equal(getCheckins('owner').timezone, 'America/Chicago');
  } finally {
    off();
    db.prepare("UPDATE proactivity SET enabled=0 WHERE user_id='owner'").run();
    db.prepare("DELETE FROM proactive_due_slots WHERE user_id='owner' AND status='pending'").run();
  }
});

test('R2F-018 wake errors show generic copy only, survive a restart and clear on success', async () => {
  const { computers } = await import('../server/src/computers/index.js');
  const { wakeComputer, WAKE_ERROR_MESSAGE } = await import('../server/src/routes.js');
  const original = computers.ensure;
  const raw = 'gateway 10.0.0.7 refused: region me-central-1 capacity exhausted (request req_AbCdEf123456)';
  computers.ensure = async () => { throw new Error(raw); };
  const warn = mock.method(console, 'warn', () => {});
  try {
    await wakeComputer('owner');
    assert.ok(warn.mock.calls.some((c) => c.arguments.join(' ').includes(raw)), 'raw text is logged on the server');
    const res = await call('GET', '/api/computer');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('10.0.0.7') && !text.includes('me-central-1') && !text.includes('req_AbCdEf123456'), 'no raw provider text in the response');
    assert.equal(JSON.parse(text).computer.error, WAKE_ERROR_MESSAGE);
    // Persisted, not held in process memory: a restarted server reads the same row.
    const row = db.prepare('SELECT message, failed_at, cleared_at FROM computer_wake_errors WHERE user_id=?').get('owner') as any;
    assert.equal(row.message, WAKE_ERROR_MESSAGE);
    assert.ok(row.failed_at > 0);
    assert.equal(row.cleared_at, null);
    assert.ok(!JSON.stringify(row).includes('10.0.0.7'), 'raw text is not stored');
    computers.ensure = async () => {};
    await wakeComputer('owner');
    assert.notEqual((await (await call('GET', '/api/computer')).json()).computer.error, WAKE_ERROR_MESSAGE);
    assert.ok((db.prepare('SELECT cleared_at FROM computer_wake_errors WHERE user_id=?').get('owner') as any).cleared_at > 0, 'cleared, not deleted');
  } finally { warn.mock.restore(); computers.ensure = original; }
});

test('R2F-019 bodies over 256 KB are 413 before parsing on Bot, group and card answer routes; normal messages work', async () => {
  const { roomsApi } = await import('../server/src/routes-rooms.js');
  const big = JSON.stringify({ text: 'x'.repeat(300 * 1024) });
  const before = rowCount(worker.id);
  const message = await call('POST', `/api/bots/${worker.id}/messages`, undefined, big);
  assert.equal(message.status, 413);
  assert.deepEqual(await message.json(), { error: 'Message is too long (max 32,000 characters).' });
  assert.equal(rowCount(worker.id), before, 'nothing appended');
  assert.equal((await call('PATCH', `/api/bots/${worker.id}`, undefined, JSON.stringify({ label: 'x'.repeat(300 * 1024) }))).status, 413);
  const card = appendRow(worker.id, 'card', { type: 'card', card: 'question', question: 'Big?', options: [], status: 'pending' } as any);
  assert.equal((await call('POST', `/api/bots/${worker.id}/cards/${card.seq}/answer`, undefined, JSON.stringify({ answer: 'y'.repeat(300 * 1024) }))).status, 413);
  assert.equal((getRow(worker.id, card.seq)!.body as any).status, 'pending');
  assert.equal((await call('POST', '/api/approvals/apr_missing', undefined, JSON.stringify({ decision: 'deny', pad: 'z'.repeat(300 * 1024) }))).status, 413);
  // A streamed body without a length header is cut off too.
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"')); for (let i = 0; i < 80; i++) controller.enqueue(chunk); controller.enqueue(new TextEncoder().encode('"}')); controller.close(); } });
  const streamed = await app.request(`/api/bots/${worker.id}/messages`, { method: 'POST', headers: { cookie: `swarm_session=${session}`, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as any);
  assert.equal(streamed.status, 413);
  assert.equal(rowCount(worker.id), before + 1, 'only the question card added above');
  const rooms = await roomsApi.request('/', { method: 'POST', headers: { cookie: `swarm_session=${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'g'.repeat(300 * 1024), botIds: [] }) });
  assert.equal(rooms.status, 413);
  // Normal traffic is unaffected.
  const ok = await call('PATCH', `/api/bots/${worker.id}`, { label: 'Research' });
  assert.equal(ok.status, 200);
  db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=?').run(worker.id, card.seq);
});

test('R2F-037 /api/bots/import rejects malformed bodies with a plain 400', async () => {
  for (const raw of ['{', '', '[]', '42', 'null', '"text"']) {
    const res = await call('POST', '/api/bots/import', undefined, raw);
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
  }
  const invalid = await call('POST', '/api/bots/import', { manifest: { format: 'swarm.bot-setup' } });
  assert.equal(invalid.status, 400);
  const { error } = await invalid.json();
  assert.ok(typeof error === 'string' && error.length < 300 && !error.includes('"code"'), 'short validation message, not a raw schema dump');
});

test('R2F-038 CSP connect-src is narrowed to self, the app host and the configured voice sockets; Permissions-Policy is set', async () => {
  const { connectSources, contentSecurityPolicy } = await import('../server/src/security/request.js');
  const { env } = await import('../server/src/env.js');
  const html = await app.request('/', { headers: { 'x-forwarded-proto': 'https' } });
  const csp = html.headers.get('content-security-policy') ?? '';
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!;
  const sources = connect.split(' ').slice(1);
  assert.equal(csp.split('; ').find(d => d.startsWith('img-src ')), "img-src 'self' data: blob:", 'logos use same-origin proxies; no arbitrary HTTPS images');
  assert.equal(contentSecurityPolicy(false).split('; ').find(d => d.startsWith('img-src ')), "img-src 'self' data: blob:");
  assert.equal(sources[0], "'self'");
  for (const broad of ['https:', 'wss:', 'http:', 'ws:', '*']) assert.ok(!sources.includes(broad), `no bare ${broad}`);
  // The browser opens the realtime voice socket on the configured provider host.
  const voice = new URL(env.voiceBaseUrl);
  assert.ok(sources.includes(`${voice.protocol === 'https:' ? 'wss:' : 'ws:'}//${voice.host}`), 'voice socket host allowed');
  assert.deepEqual(sources, connectSources());
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "default-src 'self'", "script-src 'self' blob:"]) assert.ok(csp.includes(directive), directive);
  // Local plain http keeps its development allowances.
  assert.match(contentSecurityPolicy(false), /connect-src [^;]* http: ws:/);
  for (const route of ['/', '/api/health', '/api/auth/me']) {
    assert.equal((await app.request(route)).headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=(self)', route);
  }
});
