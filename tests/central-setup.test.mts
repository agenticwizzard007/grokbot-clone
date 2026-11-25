import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'central-setup-'));
Object.assign(process.env, { DB_PATH: path.join(storage, 'app.db'), FILES_DIR: path.join(storage, 'files'), SWARM_NO_SCHEDULER: '1', SWARM_ROLE: 'standalone', NODE_ENV: 'test', SESSION_SECRET: 'central-setup-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0' });
const { db } = await import('../server/src/db.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, getBotRow, clearConversation } = await import('../server/src/store.js');
const setup = await import('../server/src/bot-setup.js');
const { createTeammate, provisionTeammate, CENTRAL_SETUP_TOOLS } = await import('../server/src/agent/teammates.js');
const { computers } = await import('../server/src/computers/index.js');
const { api } = await import('../server/src/routes.js');
const { settleAgentJobs } = await import('../server/src/agent/loop.js');
const app = new Hono().route('/api', api);
let sequence = 0, online = false;
computers.screen = async () => { if (!online) throw new Error('Fixture computer offline'); return { screenshot: async () => ({ image: '', mime: 'image/png', width: 1, height: 1 }) } as any; };
// Admit durable jobs without running a provider. Runtime integration has its own tests.
setup.bindSetupHandoffRuntime((botId, trigger) => acceptJob(botId, trigger).id);
after(async () => { await settleAgentJobs(); db.close(); fs.rmSync(storage, { recursive: true, force: true }); });
function fixture() {
  online = false;
  const userId = 'setup-owner-' + (++sequence);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, userId + '@example.test', userId, Date.now());
  const chief = createBot(userId, { name: 'Quinn', isPrimary: true });
  const answer = appendRow(chief.id, 'message', { type: 'message', role: 'user', text: 'Prepare a notes coworker. On my request, summarize my supplied notes in three bullets. Return results to Quinn; no external actions.' });
  const token = 'setup-session-' + sequence;
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token, userId, Date.now(), Date.now() + 60000);
  const ctx = { botId: chief.id, userId, depth: 0, enqueueBotMessage: () => { throw new Error('Setup must not dispatch operational peer work'); } };
  const spec = { creation_request_id: 'creation-' + sequence, name: 'Notes', purpose: 'Summarize supplied notes', responsibilities: ['Summarize notes in three bullets'], out_of_scope: ['External actions'], success_criteria: ['Three bullets faithful to source notes'], context_summary: answer.body.type === 'message' ? answer.body.text : '', source_message_seqs: [answer.seq], action_boundaries: 'Read supplied notes and return a summary. Ask about ambiguity. No external actions.', workflows: [{ name: 'Notes', trigger: 'The user supplies notes and asks', steps: ['Read notes', 'Extract three key points'], output: 'Three accurate bullets returned to Quinn' }], handoff_notes: ['Return results to Quinn'], instructions: 'Be concise.' };
  return { userId, chief, answer, ctx, spec, headers: { cookie: 'swarm_session=' + token, 'content-type': 'application/json' } };
}
const decode = (result: any) => JSON.parse(result.output);
async function created(f: ReturnType<typeof fixture>) { return decode(await createTeammate(f.spec, f.ctx)).bot; }
function draft(f: ReturnType<typeof fixture>, botId: string, extra = {}) {
  const prior = setup.getSetup(botId)!;
  return { ...prior.brief, bot_id: botId, revision: prior.onboarding.revision, stage: 'review', instructions: 'Use factual bullets.', source_refs: [{ botId: f.chief.id, generation: f.chief.generation, seq: f.answer.seq }], ...extra };
}
const jobCount = (botId: string) => (db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE bot_id=?').get(botId) as any).n;
const post = (f: ReturnType<typeof fixture>, botId: string, body: unknown) => app.request(`/api/bots/${botId}/setup/activate`, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });

test('generated creation and both setup writers save plain connection prose without rewriting saved instructions', async () => {
  const f = fixture();
  f.spec.instructions = 'Slack is ACTIVE. Calendar is EXPIRED.';
  f.spec.purpose = 'Summarize notes. Slack is ACTIVE.';
  const bot = await created(f);
  assert.equal(getBotRow(bot.id).instructions, 'Slack is connected. Calendar needs to be reconnected.');
  assert.doesNotMatch(getBotRow(bot.id).description, /ACTIVE/);
  assert.doesNotMatch(setup.setupFiles(bot.id)['AGENTS.md'], /\b(ACTIVE|EXPIRED)\b/);
  const retry = decode(await createTeammate(f.spec, f.ctx));
  assert.equal(retry.bot.id, bot.id);
  const saved = 'User-written example: Slack is ACTIVE.';
  const patch = await app.request(`/api/bots/${bot.id}`, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ instructions: saved }) });
  assert.equal(patch.status, 200);
  assert.equal(getBotRow(bot.id).instructions, saved);
  setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { instructions: saved + '\nCalendar is INITIATED.' }));
  assert.equal(getBotRow(bot.id).instructions, saved + '\nCalendar is waiting for connection.');
  const prior = setup.getSetup(bot.id)!;
  setup.saveSetupDraft(bot.id, f.userId, { ...prior.brief, revision: prior.onboarding.revision, stage: 'review', source_message_seqs: [], instructions: getBotRow(bot.id).instructions + '\nEmail is FAILED.' });
  assert.equal(getBotRow(bot.id).instructions, saved + '\nCalendar is waiting for connection.\nEmail could not connect.');
  setup.setupView(bot.id); setup.setupFiles(bot.id);
  assert.ok(getBotRow(bot.id).instructions.startsWith(saved), 'reads and harness generation never rewrite stored user text');
});

test('plain connection wording cannot save instructions beyond the General and suggestion input limit', async () => {
  const f = fixture(), bot = await created(f);
  const instructions = 'Slack is EXPIRED. '.repeat(400);
  assert.ok(instructions.length < 8000);
  const prior = setup.getSetup(bot.id)!;
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { instructions })), /8000/);
  assert.deepEqual(setup.getSetup(bot.id), prior, 'rejected generated text rolls back the whole setup revision');
  assert.equal(getBotRow(bot.id).instructions, f.spec.instructions);
  await assert.rejects(createTeammate({ ...f.spec, creation_request_id: 'oversized-copy', name: 'Long instructions', instructions }, f.ctx), /8000/);
});

test('a complete coworker is prepared centrally without a specialist interview or synthetic answer', async () => {
  const f = fixture(), bot = await created(f);
  assert.equal(setup.getSetup(bot.id)!.onboarding.status, 'review');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='message'").get(bot.id) as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get(bot.id) as any).n, 0);
  assert.equal(jobCount(bot.id), 0);
  const view = setup.coworkerSetup(f.userId, f.chief.id, bot.id);
  assert.equal(view.manifest.source.sourceRefs![0].text, f.spec.context_summary);
  // R2F-002: the original answer names its Bot instead of printing the raw Bot id.
  assert.match(view.files['CONTEXT.md'], /### Quinn, conversation/);
  assert.doesNotMatch(view.files['CONTEXT.md'], new RegExp(f.chief.id));
  assert.equal((view.manifest.source.sourceRefs![0] as any).botName, 'Quinn');
  assert.equal(CENTRAL_SETUP_TOOLS.some(t => /activat/.test(t.name)), false);
});

test('stable creation request deduplicates after rename, configuration edits and conversation reset', async () => {
  const f = fixture(), bot = await created(f);
  db.prepare('UPDATE bots SET name=?,instructions=? WHERE id=?').run('Renamed notes', 'Later instructions', bot.id);
  clearConversation(f.chief.id);
  const retry = decode(await createTeammate(f.spec, f.ctx));
  assert.equal(retry.bot.id, bot.id); assert.equal(retry.bot.name, 'Renamed notes'); assert.equal(retry.already_created, true);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM bots WHERE user_id=? AND is_primary=0').get(f.userId) as any).n, 1);
  await assert.rejects(createTeammate({ ...f.spec, purpose: 'Conflicting mission' }, f.ctx), /different parameters/);
});

test('stable request IDs remain tombstones after deletion and cannot create a replacement', async () => {
  const f = fixture(), bot = await created(f);
  db.prepare('DELETE FROM bots WHERE id=?').run(bot.id);
  await assert.rejects(createTeammate(f.spec, f.ctx), /no longer available/);
});

test('central updates accept original archived Quinn answers, keep sources, and reject stale saves', async () => {
  const f = fixture(), bot = await created(f), original = draft(f, bot.id);
  clearConversation(f.chief.id);
  const saved = setup.prepareCoworkerSetup(f.userId, f.chief.id, original);
  assert.equal(saved.onboarding.revision, original.revision + 1);
  assert.equal(saved.manifest.source.sourceRefs![0].generation, f.chief.generation);
  assert.match(saved.files['CONTEXT.md'], /no external actions/);
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, original), /configuration changed/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='user'").get(bot.id) as any).n, 0);
});

test('setup sources reject assistant, peer, routine, missing, foreign and changed messages', async () => {
  const f = fixture(), foreign = fixture(), bot = await created(f);
  const assistant = appendRow(f.chief.id, 'message', { type: 'message', role: 'assistant', text: 'Generated answer' });
  const peer = appendRow(f.chief.id, 'message', { type: 'message', role: 'user', text: 'Peer instruction', from: { kind: 'bot', id: bot.id, name: 'Notes' } });
  const routine = appendRow(f.chief.id, 'message', { type: 'message', role: 'user', text: 'Routine instruction', from: { kind: 'routine', id: 'routine', name: 'Routine' } });
  for (const seq of [assistant.seq, peer.seq, routine.seq, 999999]) assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { source_refs: [{ botId: f.chief.id, generation: 1, seq }] })), /original human/);
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { source_refs: [{ botId: foreign.chief.id, generation: 1, seq: foreign.answer.seq }] })), /original human/);
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { source_refs: [{ botId: f.chief.id, generation: 1, seq: f.answer.seq, contentHash: 'a'.repeat(64) }] })), /Source message changed/);
});

test('voice-origin original answers are eligible, with their exact original hash', async () => {
  const f = fixture(), bot = await created(f);
  const spoken = appendRow(f.chief.id, 'message', { type: 'message', role: 'user', text: 'Use short factual bullets.', from: { kind: 'voice', id: 'call-real', name: 'Voice call' } });
  const saved = setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { source_refs: [{ botId: f.chief.id, generation: 1, seq: spoken.seq }] }));
  const ref = saved.manifest.source.sourceRefs!.find(m => m.seq === spoken.seq)!;
  assert.equal(ref.text, 'Use short factual bullets.'); assert.match(ref.contentHash, /^[a-f0-9]{64}$/);
});

test('unresolved material decisions block review and activation, and pending approvals survive', async () => {
  const f = fixture(), bot = await created(f);
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { open_questions: ['Which output destination?'] })), /Finish the brief/);
  const saved = setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { stage: 'interviewing', open_questions: ['Which destination?'] }));
  assert.throws(() => setup.activateSetup(bot.id, saved.onboarding.revision), /Finish the setup/);
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(bot.id, JSON.stringify({ decision: 'original' }));
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id)), /pending decision/);
  assert.equal((db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(bot.id) as any).state, '{"decision":"original"}');
});

test('current-primary ownership gates service, list, sources and central activation HTTP', async () => {
  const f = fixture(), foreign = fixture(), bot = await created(f);
  assert.throws(() => setup.coworkerSetup(f.userId, bot.id, f.chief.id), /current primary/);
  assert.throws(() => setup.coworkerSetup(f.userId, f.chief.id, foreign.chief.id), /not found/);
  assert.equal((await app.request(`/api/bots/${f.chief.id}/coworker-setups`, { headers: foreign.headers })).status, 404);
  assert.equal((await post(foreign, bot.id, { revision: 1, coordinatorId: foreign.chief.id })).status, 404);
  const response = await app.request(`/api/bots/${f.chief.id}/coworker-setups`, { headers: f.headers });
  assert.equal(response.status, 200); assert.equal((await response.json() as any).setups[0].botId, bot.id);
  assert.equal((await post(f, bot.id, { revision: 1, coordinatorId: bot.id })).status, 409);
});

test('activation HTTP pins exact reviewed revision; setup and activation events record committed revisions', async () => {
  const f = fixture(), bot = await created(f), saved = setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id));
  assert.equal((await post(f, bot.id, { revision: 1, coordinatorId: f.chief.id })).status, 409);
  assert.equal(setup.getSetup(bot.id)!.onboarding.status, 'review');
  assert.equal((await post(f, bot.id, { revision: saved.onboarding.revision, coordinatorId: f.chief.id })).status, 200);
  assert.equal(setup.getSetup(bot.id)!.onboarding.status, 'active');
  assert.equal((await post(f, bot.id, { revision: saved.onboarding.revision, coordinatorId: f.chief.id })).status, 409);
  const event = db.prepare("SELECT * FROM native_events WHERE bot_id=? AND kind='setup.activated'").get(bot.id) as any;
  assert.equal(JSON.parse(event.data).approvedRevision, saved.onboarding.revision);
  assert.equal(event.source_revision, String(saved.onboarding.revision + 1));
});

test('initial handoff waits for readiness and retries reuse one durable job, including uncertain work', async () => {
  const f = fixture();
  const result = decode(await createTeammate({ ...f.spec, handoff_message: 'Summarize the supplied example notes when ready.' }, f.ctx)), botId = result.bot.id;
  assert.equal(setup.activateSetup(botId, 1), null); assert.equal(jobCount(botId), 0);
  assert.ok((db.prepare('SELECT pending_handoff FROM bot_setups WHERE bot_id=?').get(botId) as any).pending_handoff);
  online = true;
  assert.equal((await provisionTeammate(f.userId, botId)).status, 'ready');
  const first = setup.releaseSetupHandoff(botId); assert.ok(first); assert.equal(jobCount(botId), 1);
  db.prepare("UPDATE agent_jobs SET state='uncertain' WHERE id=?").run(first);
  await provisionTeammate(f.userId, botId); setup.releaseReadySetupHandoffs();
  assert.equal(setup.releaseSetupHandoff(botId), first); assert.equal(jobCount(botId), 1);
  assert.equal((db.prepare('SELECT pending_handoff FROM bot_setups WHERE bot_id=?').get(botId) as any).pending_handoff, null);
});

test('handoff admission failure rolls back the job and preserves original assignment for retry', async () => {
  const f = fixture(), result = decode(await createTeammate({ ...f.spec, handoff_message: 'Original assignment' }, f.ctx)), botId = result.bot.id;
  setup.activateSetup(botId, 1);
  db.prepare("UPDATE bot_setups SET computer_status='ready' WHERE bot_id=?").run(botId);
  db.exec(`CREATE TEMP TRIGGER reject_handoff_receipt BEFORE INSERT ON coworker_setup_handoffs BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END`);
  try { assert.throws(() => setup.releaseSetupHandoff(botId), /injected_receipt_failure/); assert.equal(jobCount(botId), 0); assert.equal((db.prepare('SELECT pending_handoff FROM bot_setups WHERE bot_id=?').get(botId) as any).pending_handoff, 'Original assignment'); }
  finally { db.exec('DROP TRIGGER reject_handoff_receipt'); }
  assert.ok(setup.releaseSetupHandoff(botId)); assert.equal(jobCount(botId), 1);
});

test('event insertion failures roll back configuration changes and their revisions', async () => {
  const f = fixture(), bot = await created(f), prior = setup.getSetup(bot.id)!;
  db.exec(`CREATE TEMP TRIGGER reject_setup_event BEFORE INSERT ON native_events WHEN NEW.kind='setup.prepared' BEGIN SELECT RAISE(ABORT,'injected_setup_event_failure'); END`);
  try { assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, { purpose: 'Uncommitted new purpose' })), /injected_setup_event_failure/); }
  finally { db.exec('DROP TRIGGER reject_setup_event'); }
  assert.deepEqual(setup.getSetup(bot.id), prior); assert.equal(getBotRow(bot.id).instructions, 'Be concise.');
});

test('pending questions and connections block central edits without dismissing the decision', async () => {
  const f = fixture(), bot = await created(f);
  const question = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which source?', options: [], status: 'pending' });
  assert.throws(() => setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id)), /pending decision/);
  assert.equal(JSON.parse((db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(bot.id, question.seq) as any).body).status, 'pending');
});

test('activation survives handoff capacity refusal and later admission retains the reviewed revision', async () => {
  const f = fixture(), result = decode(await createTeammate({ ...f.spec, handoff_message: 'Initial approved assignment' }, f.ctx)), botId = result.bot.id;
  db.prepare("UPDATE bot_setups SET computer_status='ready' WHERE bot_id=?").run(botId);
  setup.bindSetupHandoffRuntime(() => { throw new Error('Task queue full'); });
  try { setup.activateSetup(botId, 1); assert.equal(setup.getSetup(botId)!.onboarding.status, 'active'); assert.equal(jobCount(botId), 0); }
  finally { setup.bindSetupHandoffRuntime((id, trigger) => acceptJob(id, trigger).id); }
  db.prepare('UPDATE bot_setups SET revision=revision+1 WHERE bot_id=?').run(botId);
  const jobId = setup.releaseSetupHandoff(botId); assert.ok(jobId); assert.equal(jobCount(botId), 1);
  assert.equal((db.prepare('SELECT approved_revision FROM coworker_setup_handoffs WHERE bot_id=?').get(botId) as any).approved_revision, 1);
});

test('R2F-002: briefs saved with connected account, request and Bot ids render without them, including stored ones', async () => {
  const f = fixture(), bot = await created(f);
  const ids = /\b(ca|req|apr|bot)_[A-Za-z0-9_-]{6,}/;
  const saved = setup.prepareCoworkerSetup(f.userId, f.chief.id, draft(f, bot.id, {
    shared_resources: ['Slack account ca_KIxihCKrE-D2', 'Gmail account ca_pESfPrEqcgnN'],
    context_summary: `Follow up on req_11ev-EvIvCvn and approval apr_AbCdEf123456 with ${f.chief.id}.`,
    instructions: 'Use ca_pESfPrEqcgnN for mail.',
  }));
  // Visible text (brief, instructions, rendered files) has no ids at all; structured botId fields remain for the client.
  assert.doesNotMatch(JSON.stringify([saved.manifest.brief, saved.manifest.bot.instructions, saved.files]), ids);
  assert.doesNotMatch(JSON.stringify(saved), /\b(ca|req|apr)_[A-Za-z0-9_-]{6,}/);
  assert.deepEqual(saved.manifest.brief.shared_resources, ['Slack account', 'Gmail account']);
  const stored = (db.prepare('SELECT brief FROM bot_setups WHERE bot_id=?').get(bot.id) as { brief: string }).brief;
  assert.doesNotMatch(stored, ids, 'the saved brief itself carries no ids');
  assert.doesNotMatch(getBotRow(bot.id).instructions, ids);
  // A brief stored before redaction existed is redacted when the view is built.
  const raw = JSON.parse(stored);
  raw.shared_resources = ['Slack account ca_KIxihCKrE-D2'];
  raw.context_summary = 'Old note about req_11ev-EvIvCvn.';
  db.prepare('UPDATE bot_setups SET brief=? WHERE bot_id=?').run(JSON.stringify(raw), bot.id);
  db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Old ca_KIxihCKrE-D2 instructions', bot.id);
  const view = setup.setupView(bot.id)!;
  assert.doesNotMatch(JSON.stringify(view), /\b(ca|req)_[A-Za-z0-9_-]{6,}/);
  assert.equal(view.manifest.brief.context_summary, 'Old note about request.');
  const http = await (await app.request(`/api/bots/${bot.id}/setup`, { headers: f.headers })).json();
  assert.doesNotMatch(JSON.stringify(http), /\b(ca|req)_[A-Za-z0-9_-]{6,}/);
  const coworkers = await (await app.request(`/api/bots/${f.chief.id}/coworker-setups`, { headers: f.headers })).json();
  assert.doesNotMatch(JSON.stringify(coworkers), /\b(ca|req)_[A-Za-z0-9_-]{6,}/);
  assert.equal(coworkers.setups[0].manifest.source.sourceRefs[0].botName, 'Quinn');
});
