import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-setup-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), DEV_LOGIN: '1', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'active-setup-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in active setup tests'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendHistory, appendRow, getBot, getLive, getRow, listRows, setLive, clearConversation, loadHistory } = await import('../server/src/store.js');
const { activateSetup, getSetup, repairActiveSetup, beginSetupInterview, DEFAULT_SKIP_BOUNDARIES, DEFAULT_SKIP_WORKFLOW } = await import('../server/src/bot-setup.js');
const { hub } = await import('../server/src/lib/hub.js');
const { isSetupRefusal, messageText } = await import('../server/src/agent/setup-reply.js');
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { functionSchemas } = await import('../server/src/agent/tools.js');
const { needsYou } = await import('../server/src/routes-attention.js');
const { api } = await import('../server/src/routes.js');
const { Hono } = await import('hono');
const app = new Hono().route('/api', api);
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Test account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 600_000);
}
const request = (url: string, owner = 'owner') => app.request('/api' + url, { headers: { cookie: `swarm_session=${owner}` } });
const status = (botId: string, seq: number) => (getRow(botId, seq)!.body as any).status;
let sequence = 0;
function fixture(owner = 'owner') {
  const bot = createBot(owner, { name: `Active Bot ${++sequence}`, description: 'Summarize supplied notes.' });
  const staleText = "I'm still being set up. Tap Skip setup to start working now.";
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: staleText });
  appendHistory(bot.id, [{ role: 'assistant', content: staleText }]);
  const question = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which setup workflow?', options: [], status: 'pending', jobId: 'old-interview' });
  const confirmedAt = Date.now() - 1000;
  db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq=?').run(confirmedAt - 1000, bot.id, question.seq);
  db.prepare("UPDATE bot_setups SET onboarding_status='active', revision=32, confirmed_at=? WHERE bot_id=?").run(confirmedAt, bot.id);
  setLive(bot.id, { isRunning: false, awaiting: { reason: 'Setup question', since: confirmedAt - 1000 }, activity: { kind: 'waiting_for_you', since: confirmedAt - 1000 } });
  return { bot, question, confirmedAt };
}
const calls: any[] = [];
let replies: string[] = [];
let deltas = true;
mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
  calls.push(body);
  return (async function* () {
    const text = replies.shift() ?? 'Ready to summarize the supplied notes.';
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    if (deltas) for (const delta of text.match(/.{1,12}/gs) ?? []) {
      yield { type: 'response.output_text.delta', delta };
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
});
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const read of ['roster', 'rows', 'setup', 'next turn']) test(`R1: ${read} repairs an already-active Bot without requiring Skip setup`, async () => {
  const { bot, question } = fixture();
  assert.equal(status(bot.id, question.seq), 'pending');
  const url = read === 'roster' ? '/bots' : `/bots/${bot.id}/${read}`;
  if (read !== 'next turn') {
    assert.equal((await request(url)).status, 200);
    assert.equal(status(bot.id, question.seq), 'dismissed');
    assert.equal(getLive(bot.id).awaiting, null);
    assert.equal(getLive(bot.id).activity, null);
    assert.ok(!needsYou('owner').some(item => item.botId === bot.id));
    const revision = getRow(bot.id, question.seq)!.updatedSeq;
    await request(url);
    assert.equal(getRow(bot.id, question.seq)!.updatedSeq, revision, 'later loads do not rewrite repaired cards');
  }
  const jobId = enqueue(bot.id, { type: 'user', text: 'Summarize these notes: the release is ready.' });
  await settleAgentJobs();
  assert.equal(status(bot.id, question.seq), 'dismissed');
  const trigger = JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(jobId) as any).trigger);
  assert.equal(trigger.parentJobId, undefined, 'work cannot be captured as an old interview answer');
  assert.equal(getBot(bot.id)!.onboarding!.status, 'active');
  assert.equal(getSetup(bot.id)!.onboarding.revision, 32, 'repair does not reactivate or change the saved configuration');
  const prompt = calls.at(-1).input[0].content;
  assert.match(prompt, /Your configuration is active at revision 32/);
  assert.match(prompt, /supersedes earlier setup interviews/);
  assert.match(prompt, /Do not tell the user to tap Skip setup/);
  assert.doesNotMatch(prompt, /You are the setup consultant|Reply exactly: "I'm still being set up/);
  assert.ok(!functionSchemas(bot.id).some(tool => tool.name === 'save_agent_setup'));
  assert.equal((listRows(bot.id).at(-1)!.body as any).text, 'Ready to summarize the supplied notes.');
});

test('R1: repair preserves later questions, admitted answers, approvals, other accounts and archived history', async () => {
  const { bot, question, confirmedAt } = fixture();
  const operational = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which report format?', options: [], status: 'pending' });
  const answered = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Earlier answer', options: [], status: 'answered', answer: 'Use bullets', answerJobId: 'admitted-work' });
  db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq=?').run(confirmedAt - 1000, bot.id, answered.seq);
  const approval = appendRow(bot.id, 'card', { type: 'card', card: 'approval', title: 'Pending action', status: 'pending' } as any);
  const other = fixture('other');
  await request('/bots');
  assert.equal(status(bot.id, question.seq), 'dismissed');
  assert.equal(status(bot.id, operational.seq), 'pending');
  assert.equal(status(bot.id, answered.seq), 'answered');
  assert.equal(status(bot.id, approval.seq), 'pending');
  assert.ok(getLive(bot.id).awaiting, 'a live decision must not be cleared');
  assert.equal(status(other.bot.id, other.question.seq), 'pending');
  assert.equal((await request(`/bots/${other.bot.id}/rows`)).status, 404);
  assert.equal(status(other.bot.id, other.question.seq), 'pending');
  const archived = fixture();
  clearConversation(archived.bot.id);
  repairActiveSetup(archived.bot.id);
  assert.equal(JSON.parse((db.prepare('SELECT body FROM rows WHERE bot_id=? AND generation=1 AND seq=?').get(archived.bot.id, archived.question.seq) as any).body).status, 'pending');
});

test('R1: pending setup stays pending and normal activation retires its questions', () => {
  const bot = createBot('owner', { name: 'Pending Bot' });
  const question = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which workflow?', options: [], status: 'pending' });
  const setup = getSetup(bot.id)!;
  assert.equal(setup.onboarding.status, 'interviewing');
  assert.equal(status(bot.id, question.seq), 'pending');
  db.prepare("UPDATE bot_setups SET onboarding_status='review', brief=? WHERE bot_id=?").run(JSON.stringify({ ...setup.brief, workflows: [DEFAULT_SKIP_WORKFLOW], action_boundaries: DEFAULT_SKIP_BOUNDARIES, open_questions: [] }), bot.id);
  activateSetup(bot.id, setup.onboarding.revision);
  assert.equal(status(bot.id, question.seq), 'dismissed');
  assert.equal(getSetup(bot.id)!.onboarding.status, 'active');
});

for (const streamDeltas of [true, false]) test(`R1b: active history cannot replay the interview refusal, deltas=${streamDeltas}`, async () => {
  const { bot } = fixture();
  const before = listRows(bot.id).length;
  const beforeHistory = loadHistory(bot.id);
  const events: any[] = [];
  const unsubscribe = hub.subscribe('owner', event => events.push(structuredClone(event)));
  const start = calls.length;
  replies = ["First, a quick note. I'm still being set up. Tap Skip setup to start working now, or answer: Which workflow?", 'Hi there, ready to help.'];
  deltas = streamDeltas;
  try {
    enqueue(bot.id, { type: 'user', text: 'Say hi in five words' });
    await settleAgentJobs();
  } finally { unsubscribe(); deltas = true; replies = []; }
  assert.equal(calls.length - start, 2, 'discarded refusal triggers an operational retry');
  for (const call of calls.slice(start)) {
    assert.doesNotMatch(call.input[0].content, /You are the setup consultant/);
    assert.ok(!call.input.some((item: any) => item.role === 'assistant' && isSetupRefusal(messageText(item))));
  }
  const newMessages = listRows(bot.id).slice(before).filter(row => row.body.type === 'message' && row.body.role === 'assistant');
  assert.equal(newMessages.length, 1);
  assert.equal((newMessages[0].body as any).text, 'Hi there, ready to help.');
  assert.ok(!isSetupRefusal(JSON.stringify(events)), 'no refusal was streamed through SSE');
  assert.deepEqual(loadHistory(bot.id).slice(0, beforeHistory.length), beforeHistory, 'stored history is preserved');
  assert.ok(!loadHistory(bot.id).slice(beforeHistory.length).some(item => isSetupRefusal(messageText(item))));
});

test('R1b: repeated model refusals stop at a bounded retry without saving them', async () => {
  const { bot } = fixture();
  const start = calls.length;
  replies = Array(3).fill("I'm still being set up. Tap Skip setup to start working now.");
  enqueue(bot.id, { type: 'user', text: 'Write a story about a river' });
  await settleAgentJobs();
  assert.equal(calls.length - start, 3);
  assert.equal(listRows(bot.id).filter(row => row.body.type === 'message' && isSetupRefusal(row.body.text)).length, 1, 'only the original fixture refusal remains');
  assert.ok(listRows(bot.id).some(row => row.body.type === 'notice' && row.body.text.includes('Please retry your request')));
});

for (const stage of ['interviewing', 'review']) test(`R1b: confirmed ${stage} status repairs consistently without inventing approval`, async () => {
  const { bot, question } = fixture();
  db.prepare('UPDATE bot_setups SET onboarding_status=? WHERE bot_id=?').run(stage, bot.id);
  const roster = await (await request('/bots')).json() as any;
  assert.deepEqual(roster.bots.find((item: any) => item.id === bot.id).onboarding, { status: 'active', revision: 33 });
  const setup = await (await request(`/bots/${bot.id}/setup`)).json() as any;
  assert.equal(setup.onboarding.status, 'active');
  assert.equal(setup.onboarding.revision, 33);
  assert.equal(status(bot.id, question.seq), 'dismissed');
  assert.equal(getSetup(bot.id)!.onboarding.revision, 33, 'repair is idempotent');
  beginSetupInterview(bot.id);
  assert.equal(getSetup(bot.id)!.onboarding.status, 'interviewing', 'explicit restart clears activation evidence');
});

test('R1b: an already-dismissed interview card can leave a setup-only wait behind', () => {
  const { bot, question, confirmedAt } = fixture();
  repairActiveSetup(bot.id);
  setLive(bot.id, { awaiting: { reason: 'Setup question', since: confirmedAt - 1000 }, activity: { kind: 'waiting_for_you', since: confirmedAt - 1000 } });
  repairActiveSetup(bot.id);
  assert.equal(status(bot.id, question.seq), 'dismissed');
  assert.equal(getLive(bot.id).awaiting, null);
  assert.equal(getLive(bot.id).activity, null);
});

test('R1b: explicit orphaned setup waits repair, but unknown waits and unconfirmed cards are preserved', () => {
  const bot = createBot('owner', { name: 'Orphaned setup Bot' });
  const confirmedAt = Date.now();
  db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=? WHERE bot_id=?").run(confirmedAt, bot.id);
  setLive(bot.id, { awaiting: { reason: 'Setup interview', since: confirmedAt - 1000 }, activity: { kind: 'waiting_for_you', since: confirmedAt - 1000 } });
  repairActiveSetup(bot.id);
  assert.equal(getLive(bot.id).awaiting, null);
  setLive(bot.id, { awaiting: { reason: 'An operational decision', since: confirmedAt - 1000 } });
  repairActiveSetup(bot.id);
  assert.ok(getLive(bot.id).awaiting);
  const unconfirmed = fixture();
  db.prepare('UPDATE bot_setups SET confirmed_at=NULL WHERE bot_id=?').run(unconfirmed.bot.id);
  repairActiveSetup(unconfirmed.bot.id);
  assert.equal(status(unconfirmed.bot.id, unconfirmed.question.seq), 'pending', 'no timestamp means no safe card cutoff');
});

for (const stage of ['interviewing', 'review']) test(`R1b: unconfirmed ${stage} stays in setup until the real Skip endpoint activates it`, async () => {
  const bot = createBot('owner', { name: 'Configuring Bot' });
  const s = getSetup(bot.id)!;
  db.prepare('UPDATE bot_setups SET onboarding_status=?, brief=? WHERE bot_id=?').run(stage, JSON.stringify({ ...s.brief, workflows: [DEFAULT_SKIP_WORKFLOW], action_boundaries: DEFAULT_SKIP_BOUNDARIES, open_questions: [] }), bot.id);
  assert.equal(getBot(bot.id)!.onboarding!.status, stage, 'complete brief alone is not activation');
  assert.equal(getSetup(bot.id)!.onboarding.status, stage);
  const skipped = await app.request(`/api/bots/${bot.id}/setup/skip`, { method: 'POST', headers: { cookie: 'swarm_session=owner' } });
  assert.equal(skipped.status, 200);
  assert.equal((await skipped.json() as any).bot.onboarding.status, 'active');
  enqueue(bot.id, { type: 'user', text: 'Summarize these notes: the release is ready.' });
  await settleAgentJobs();
  assert.doesNotMatch(calls.at(-1).input[0].content, /You are the setup consultant/);
  assert.equal((listRows(bot.id).at(-1)!.body as any).text, 'Ready to summarize the supplied notes.');
});
