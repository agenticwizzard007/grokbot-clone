// QA master fix, work stream 2 (agent runtime). Isolated database, stubbed model, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-qa-ws2-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'qa-ws2-runtime', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'test', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
delete process.env.SWARM_ACCOUNT_CONCURRENCY;
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in QA WS2 tests'); });

const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms, createRoom, dispatchRoomMessage } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, getBot, getBotRow, getLive, listRows, setLive, previewFor, stripMarkdown } = await import('../server/src/store.js');
const { beginSetupInterview, skipSetup, getSetup, normalizeModelText, normalizeStoredBriefs, computerReadiness, bindComputerStateSource, renameSetupGreeting, saveSetupDraft } = await import('../server/src/bot-setup.js');
const { functionSchemas, policyFor, computerFamily } = await import('../server/src/agent/tools.js');
const { accountPreferences, saveAccountPreferences } = await import('../server/src/settings.js');
const { enqueue, interrupt, resolveApproval, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { hub } = await import('../server/src/lib/hub.js');
const { Hono } = await import('hono');
const { api } = await import('../server/src/routes.js');
const { roomsApi } = await import('../server/src/routes-rooms.js');
const { preferencesApi } = await import('../server/src/routes-preferences.js');

const app = new Hono().route('/api/rooms', roomsApi).route('/api/account', preferencesApi).route('/api', api);
for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
const cookie = 'qa-ws2-session';
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(cookie, 'owner', Date.now(), Date.now() + 600000);
const call = (method: string, url: string, body?: unknown) => app.request(url, { method, headers: { cookie: `swarm_session=${cookie}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const primary = createBot('owner', { name: 'Lead', isPrimary: true });
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

/** A stubbed streaming model response with one plain text message. */
function textStream(text: string, gate?: Promise<void>) {
  return (async function* () {
    if (gate) await gate;
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    yield { type: 'response.output_text.delta', delta: text };
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
}
function newBot(name: string) {
  const bot = createBot('owner', { name, isPrimary: false });
  beginSetupInterview(bot.id);
  return bot;
}

test('MF-010: a new Bot starts in setup; Skip setup activates it with operational tools', async () => {
  const bot = newBot('Skipper');
  assert.equal(getSetup(bot.id)!.onboarding.status, 'interviewing');
  assert.equal(getBot(bot.id)!.onboarding?.status, 'interviewing');
  assert.ok(!functionSchemas(bot.id).some((t) => t.name === 'post_to_group'));
  const events: any[] = [];
  const off = hub.subscribe('owner', (e: any) => events.push(e));
  const res = await call('POST', `/api/bots/${bot.id}/setup/skip`);
  off();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const row = db.prepare('SELECT onboarding_status FROM bot_setups WHERE bot_id=?').get(bot.id) as any;
  assert.equal(row.onboarding_status, 'active');
  const setup = getSetup(bot.id)!;
  assert.ok(setup.brief.workflows.length >= 1);
  assert.ok(setup.brief.action_boundaries.length > 0);
  const names = functionSchemas(bot.id).map((t) => t.name);
  for (const tool of ['post_to_group', 'send_to_bot', 'create_routine', 'save_file']) assert.ok(names.includes(tool), tool);
  assert.ok(!names.includes('save_agent_setup'));
  assert.equal(getBot(bot.id)!.onboarding?.status, 'active');
  assert.ok(events.some((e) => e.type === 'tasks' && e.botId === bot.id), 'setup status change emits a tasks event');
  assert.equal((await call('POST', `/api/bots/${bot.id}/setup/skip`)).status, 409);
  const foreign = createBot('other', { name: 'Elsewhere', isPrimary: false });
  assert.equal((await call('POST', `/api/bots/${foreign.id}/setup/skip`)).status, 404);
  assert.throws(() => skipSetup('owner', foreign.id));
});

test('MF-010: a brief change during setup is shown as a "Saved to setup" event row', () => {
  const bot = newBot('Recorder');
  const user = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'Summarise support tickets every morning.' });
  const s = getSetup(bot.id)!;
  saveSetupDraft(bot.id, 'owner', { ...s.brief, purpose: 'Summarise support tickets every morning.', revision: s.onboarding.revision, stage: 'interviewing', instructions: '', source_message_seqs: [user.seq] });
  const event = listRows(bot.id).find((r) => r.body.type === 'event' && r.body.text.startsWith('Saved to setup:'));
  assert.ok(event, 'event row exists');
  assert.match((event!.body as any).text, /mission "Summarise support tickets every morning\."/);
});

test('MF-004: adding a Bot that is still in setup to a group returns 400', async () => {
  const active = newBot('Ready One'); skipSetup('owner', active.id);
  const active2 = newBot('Ready Two'); skipSetup('owner', active2.id);
  const interviewing = newBot('Fresh');
  const res = await call('POST', '/api/rooms', { name: 'Mixed', botIds: [active.id, interviewing.id] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Activate Fresh before adding it to a group.');
  const ok = await call('POST', '/api/rooms', { name: 'Ready group', botIds: [active.id, active2.id] });
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  const add = await call('PUT', `/api/rooms/${id}/members`, { botIds: [active.id, active2.id, interviewing.id] });
  assert.equal(add.status, 400);
  assert.match((await add.json()).error, /Activate Fresh/);
  assert.equal((await call('POST', '/api/rooms', '{')).status, 400);
});

test('MF-004: a plain text reply to a group message lands in the group, not in the member chat', async () => {
  const a = newBot('Alpha'); skipSetup('owner', a.id);
  const b = newBot('Beta'); skipSetup('owner', b.id);
  const roomId = createRoom('owner', 'QA Group', [a.id, b.id]);
  const create = mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
    const system = String(body.input?.[0]?.content ?? '');
    const name = /You are (Alpha|Beta)/.exec(system)?.[1] ?? 'Unknown';
    return textStream(`Pong from ${name}`);
  });
  try {
    appendRow(roomId, 'message', { type: 'message', role: 'user', text: 'QA ping' });
    dispatchRoomMessage(roomId, 'QA ping', enqueue);
    await settleAgentJobs();
  } finally { create.mock.restore(); }
  const roomTexts = listRows(roomId).filter((r) => r.body.type === 'message' && r.body.role === 'assistant').map((r) => (r.body as any).text).sort();
  assert.deepEqual(roomTexts, ['Pong from Alpha', 'Pong from Beta']);
  for (const bot of [a, b]) {
    const visible = listRows(bot.id).filter((r) => r.body.type === 'message' && /Pong from/.test((r.body as any).text) && r.audience !== 'internal' && (r.body as any).audience !== 'internal');
    assert.equal(visible.length, 0, 'no user-facing copy in the member chat');
  }
  assert.match(getBot(roomId)!.lastPreview ?? '', /Pong from/);
});

test('MF-004: a member still in setup posts a notice in the group instead of replying privately', async () => {
  const a = newBot('Gamma'); skipSetup('owner', a.id);
  const b = newBot('Delta'); skipSetup('owner', b.id);
  const roomId = createRoom('owner', 'Setup group', [a.id, b.id]);
  beginSetupInterview(b.id); // Delta restarted setup after joining
  const create = mock.method(llmClient(360_000).responses, 'create', async () => textStream('Pong'));
  try { dispatchRoomMessage(roomId, 'hello', enqueue); await settleAgentJobs(); } finally { create.mock.restore(); }
  assert.equal(create.mock.callCount(), 1, 'only the active member ran a model turn');
  assert.ok(listRows(roomId).some((r) => r.body.type === 'notice' && r.body.text === "Delta is still being set up and can't answer in groups yet."));
});

test('MF-006: policyFor asks for computer, browser and shell only when the account opts in', () => {
  assert.equal(accountPreferences('owner').askBeforeComputer, false);
  for (const tool of ['shell', 'computer_click', 'browser_click', 'open_browser', 'browser_snapshot', 'computer_screenshot']) assert.equal(policyFor('owner', tool, {}).decision, 'allow', tool);
  saveAccountPreferences('owner', { askBeforeComputer: true });
  assert.deepEqual([policyFor('owner', 'shell', {}).decision, policyFor('owner', 'shell', {}).key], ['ask', 'shell']);
  assert.deepEqual([policyFor('owner', 'computer_type', {}).decision, policyFor('owner', 'computer_type', {}).key], ['ask', 'computer']);
  assert.deepEqual([policyFor('owner', 'browser_navigate', {}).decision, policyFor('owner', 'browser_navigate', {}).key], ['ask', 'browser']);
  assert.equal(policyFor('owner', 'open_browser', {}).key, 'browser');
  for (const tool of ['browser_snapshot', 'browser_take_screenshot', 'computer_screenshot', 'save_file']) assert.equal(policyFor('owner', tool, {}).decision, 'allow', tool);
  assert.equal(computerFamily('browser_find'), null);
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES ('owner','browser','always_allow')").run();
  assert.equal(policyFor('owner', 'browser_click', {}).decision, 'allow');
  assert.equal(policyFor('owner', 'shell', {}).decision, 'ask');
  assert.equal(policyFor('other', 'shell', {}).decision, 'allow', 'preference is per account');
  saveAccountPreferences('owner', { askBeforeComputer: false });
  db.prepare("DELETE FROM policies WHERE user_id='owner'").run();
});

test('MF-006: account preference routes read and validate the setting', async () => {
  assert.deepEqual(await (await call('GET', '/api/account/preferences')).json(), { askBeforeComputer: false });
  const res = await call('PATCH', '/api/account/preferences', { askBeforeComputer: true });
  assert.deepEqual(await res.json(), { askBeforeComputer: true });
  assert.equal((await call('PATCH', '/api/account/preferences', { askBeforeComputer: 'yes' })).status, 400);
  assert.equal((await call('PATCH', '/api/account/preferences', { askBeforeComputer: true, extra: 1 })).status, 400);
  assert.equal((await app.request('/api/account/preferences')).status, 401);
  await call('PATCH', '/api/account/preferences', { askBeforeComputer: false });
});

test('MF-011: a queued live state is emitted at enqueue while another Bot is busy, and Stop cancels it', async () => {
  process.env.SWARM_ACCOUNT_CONCURRENCY = '1';
  const a = newBot('Busy'); skipSetup('owner', a.id);
  const b = newBot('Waiting'); skipSetup('owner', b.id);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const create = mock.method(llmClient(360_000).responses, 'create', async () => textStream('done', gate));
  const live: any[] = [];
  const off = hub.subscribe('owner', (e: any) => { if (e.type === 'live') live.push(e.state); });
  try {
    enqueue(a.id, { type: 'user', text: 'slow job' });
    for (let i = 0; i < 100 && getLive(a.id).activity?.kind !== 'thinking' && create.mock.callCount() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const before = live.length;
    const jobId = enqueue(b.id, { type: 'user', text: 'second job' });
    const queued = live.slice(before).find((s) => s.botId === b.id);
    assert.ok(queued, 'live event for B emitted synchronously at enqueue');
    assert.equal(queued.isRunning, true);
    assert.equal(queued.activity.kind, 'queued');
    assert.equal(queued.activity.detail, 'Busy');
    interrupt(b.id);
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(jobId) as any).state, 'cancelled');
    assert.equal(getLive(b.id).isRunning, false);
  } finally { off(); release(); await settleAgentJobs(); create.mock.restore(); delete process.env.SWARM_ACCOUNT_CONCURRENCY; }
  assert.ok(!listRows(b.id).some((r) => r.body.type === 'message' && (r.body as any).text === 'done'), 'cancelled job never ran');
});

test('MF-011: two Bots of one account run side by side with the default limit', async () => {
  const a = newBot('Para One'); skipSetup('owner', a.id);
  const b = newBot('Para Two'); skipSetup('owner', b.id);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const create = mock.method(llmClient(360_000).responses, 'create', async () => textStream('ok', gate));
  try {
    enqueue(a.id, { type: 'user', text: 'one' });
    enqueue(b.id, { type: 'user', text: 'two' });
    for (let i = 0; i < 200 && create.mock.callCount() < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(create.mock.callCount(), 2, 'both model calls started before either finished');
  } finally { release(); await settleAgentJobs(); create.mock.restore(); }
  const usage = db.prepare("SELECT DISTINCT bot_id FROM usage_events WHERE bot_id IN (?,?)").all(a.id, b.id) as any[];
  assert.ok(usage.length <= 2);
});

test('MF-018: sidebar preview follows card status; resolving an approval clears waiting state', () => {
  const card = (status: string) => ({ type: 'card', card: 'approval', approvalId: 'x', title: 'Allow Lead to send message?', detail: '', tool: 'SLACK_SEND_MESSAGE', args: {}, status }) as any;
  assert.equal(previewFor(card('pending')), 'Waiting for you: Allow Lead to send message?');
  assert.equal(previewFor(card('denied')), 'Not allowed: Allow Lead to send message?');
  assert.equal(previewFor(card('allowed')), 'Allowed: Allow Lead to send message?');
  assert.equal(previewFor(card('always')), 'Allowed: Allow Lead to send message?');
  const bot = newBot('Approver'); skipSetup('owner', bot.id);
  const row = appendRow(bot.id, 'card', card('pending'));
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at,binding_hash) VALUES (?,?,?,?,?,?,?,?)').run('apr_qa', bot.id, row.seq, 'call_qa', 'SLACK_SEND_MESSAGE', 'pending', Date.now(), 'x');
  setLive(bot.id, { isRunning: false, activity: { kind: 'waiting_for_you', since: Date.now() }, awaiting: { reason: 'Slack', since: Date.now() } });
  assert.match(getBot(bot.id)!.lastPreview!, /^Waiting for you/);
  const events: any[] = [];
  const off = hub.subscribe('owner', (e: any) => events.push(e));
  resolveApproval('owner', 'apr_qa', 'deny');
  off();
  assert.equal(getLive(bot.id).awaiting, null);
  assert.match(getBot(bot.id)!.lastPreview!, /^Not allowed: /);
  assert.ok(events.some((e) => e.type === 'bot' && e.bot.id === bot.id));
  assert.ok(events.some((e) => e.type === 'tasks' && e.botId === bot.id));
});

test('MF-050: previews strip markdown', () => {
  assert.equal(stripMarkdown('**Example Domain** is [here](https://example.com)'), 'Example Domain is here');
  assert.equal(stripMarkdown('# Title\n`code` and _soft_'), 'Title code and soft');
  assert.equal(previewFor({ type: 'message', role: 'assistant', text: '```js\nx()\n```' } as any), 'x()');
});

test('MF-056: Bot activity order follows the user, not streaming rows', () => {
  const bot = newBot('Stable');
  const user = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'hi' });
  const before = getBot(bot.id)!.lastActivityAt;
  assert.equal(before, user.createdAt);
  db.prepare('UPDATE rows SET created_at=created_at-1000 WHERE bot_id=? AND seq=?').run(bot.id, user.seq);
  const userAt = getBot(bot.id)!.lastActivityAt;
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'streaming reply' });
  assert.equal(getBot(bot.id)!.lastActivityAt, userAt);
});

test('MF-040: model text normalisation fixes double-encoded quotes and is idempotent on stored briefs', () => {
  assert.equal(normalizeModelText("reply exactly '\\\"OK\\\"' to test"), `reply exactly '"OK"' to test`);
  assert.equal(normalizeModelText('line one\\nline two'), 'line one\nline two');
  assert.equal(normalizeModelText('a "real" quote and \\" kept'), 'a "real" quote and \\" kept');
  assert.equal(normalizeModelText('C:\\path'), 'C:\\path');
  const bot = newBot('Escaped');
  const raw = JSON.parse((db.prepare('SELECT brief FROM bot_setups WHERE bot_id=?').get(bot.id) as any).brief);
  raw.action_boundaries = "Autonomously reply exactly '\\\"OK\\\"' to test messages";
  db.prepare('UPDATE bot_setups SET brief=? WHERE bot_id=?').run(JSON.stringify(raw), bot.id);
  const revision = getSetup(bot.id)!.onboarding.revision;
  assert.equal(normalizeStoredBriefs(), 1);
  assert.equal(normalizeStoredBriefs(), 0);
  assert.equal(getSetup(bot.id)!.brief.action_boundaries, `Autonomously reply exactly '"OK"' to test messages`);
  assert.equal(getSetup(bot.id)!.onboarding.revision, revision, 'normalisation does not invalidate reviews');
});

test('MF-023: computer readiness derives from the live computer and the provisioning record', () => {
  const bot = newBot('Readiness');
  const state = (s: any) => bindComputerStateSource(() => ({ orgoId: null, error: null, screens: [], ...s }));
  state({ status: 'running', provider: 'cloudvm' });
  assert.deepEqual(computerReadiness('owner', bot.id), { status: 'ready', error: null });
  state({ status: 'error', provider: 'cloudvm', error: 'VM failed' });
  assert.deepEqual(computerReadiness('owner', bot.id), { status: 'pending', error: 'VM failed' });
  state({ status: 'absent', provider: 'local' });
  assert.equal(computerReadiness('owner', bot.id).status, 'pending');
  state({ status: 'running', provider: 'local', screens: [{ botId: bot.id, screenId: 's' }] });
  assert.equal(computerReadiness('owner', bot.id).status, 'ready');
  db.prepare("UPDATE bot_setups SET computer_status='ready' WHERE bot_id=?").run(bot.id);
  state({ status: 'absent', provider: 'local' });
  assert.equal(computerReadiness('owner', bot.id).status, 'ready');
});

test('MF-035: renaming a Bot during setup refreshes its opening question', () => {
  const bot = newBot('QA');
  assert.ok(renameSetupGreeting(bot.id, 'QA', 'QA-Temp-1'));
  const greeting = listRows(bot.id).filter((r) => r.body.type === 'message' && r.body.role === 'assistant').at(-1)!;
  assert.match((greeting.body as any).text, /^What job would you like QA-Temp-1 to handle\?/);
  skipSetup('owner', bot.id);
  assert.equal(renameSetupGreeting(bot.id, 'QA-Temp-1', 'Other'), false);
  assert.equal(getBotRow(bot.id).name, 'QA');
});

test('MF-013 voice path: update_agent changes to model or effort keep the setup revision; a rename bumps it', async () => {
  const { runVoiceControl } = await import('../server/src/voice-controls.js');
  const bot = newBot('Voice Target');
  const run = async (args: unknown) => JSON.parse((await runVoiceControl('update_agent', args, { userId: 'owner', botId: primary.id, callId: 'qa-call' }))!.output);
  const revision = () => getSetup(bot.id)!.onboarding.revision;
  const start = revision();
  assert.equal((await run({ bot_id: bot.id, effort: 'high' })).ok, true);
  assert.equal((await run({ bot_id: bot.id, model: 'vendor/model' })).ok, true);
  assert.equal(revision(), start);
  assert.equal((await run({ bot_id: bot.id, name: 'Voice Renamed' })).ok, true);
  assert.equal(revision(), start + 1);
});
