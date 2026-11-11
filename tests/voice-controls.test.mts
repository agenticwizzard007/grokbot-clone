// Isolated native voice controls: no model service or computer connection required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-voice-controls-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'voice-controls-test-only',
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'private-provider-key-must-not-be-returned', DIRECT_MODEL: 'test-model',
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents, createSubagent } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, clearConversation, getBotRow, getLive, getRow, listRows, loadHistory, setLive } = await import('../server/src/store.js');
const { getSetup, setupFiles, activateSetup } = await import('../server/src/bot-setup.js');
const { computers } = await import('../server/src/computers/index.js');
const { hub } = await import('../server/src/lib/hub.js');
const { enqueue, runInBotQueue, settleAgentJobs, turnSignal, interrupt, resolveApproval } = await import('../server/src/agent/loop.js');
const { acceptJob, beginJob } = await import('../server/src/agent/jobs.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { EFFORTS } = await import('../server/src/types.js');
const { VOICE_CONTROL_TOOLS, voiceControlTools, runVoiceControl } = await import('../server/src/voice-controls.js');

for (const user of ['owner', 'foreign']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.com`, user, Date.now());
let primary: any, secondary: any, helper: any, foreign: any, room: any;
let screenCalls: string[] = [];
const originalScreen = computers.screen;
computers.screen = async (userId, botId) => { screenCalls.push(`${userId}:${botId}`); throw new Error('Computer offline'); };

beforeEach(() => {
  db.exec('DELETE FROM bots');
  primary = createBot('owner', { name: 'Chief', isPrimary: true, model: 'test-model', effort: 'high' });
  secondary = createBot('owner', { name: 'Research', label: 'Researcher', instructions: 'Preserve sourced findings.' });
  helper = createSubagent(secondary.id, 'Check the sources', 'Source checker');
  foreign = createBot('foreign', { name: 'Foreign identity must stay private', isPrimary: true, instructions: 'Foreign secret instructions' });
  room = createBot('owner', { name: 'Room' });
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(room.id);
  screenCalls = [];
});
after(async () => {
  await settleAgentJobs();
  computers.screen = originalScreen;
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

const context = (botId = primary.id, userId = 'owner', callId = 'voice-session') => ({ userId, botId, callId });
async function run(name: string, args: unknown, ctx = context()) {
  const result = await runVoiceControl(name, args, ctx);
  assert.ok(result, `Expected ${name} to be native`);
  assert.equal(typeof result.output, 'string');
  return JSON.parse(result.output);
}
const botCount = () => (db.prepare('SELECT count(*) n FROM bots').get() as any).n;
const jobs = (botId: string) => db.prepare('SELECT * FROM agent_jobs WHERE bot_id=? ORDER BY created_at,id').all(botId) as any[];
const spec = () => ({
  name: 'Nia', label: 'Lead researcher', purpose: 'Research three sourced leads each Friday.',
  responsibilities: ['Find three relevant leads each Friday', 'Explain the evidence for each lead'],
  out_of_scope: ['Never send outreach'], success_criteria: ['Three sourced leads reviewed by Chief'],
  context_summary: 'The user corrected five leads to three. ' + 'Keep all context. '.repeat(300) + 'FINAL: cite every source.',
  shared_resources: ['Shared research guide; verify access'], handoff_notes: ['Report to Chief with blockers'],
  communication_style: 'Concise factual prose.', working_principles: ['Distinguish evidence from assumptions'],
  action_boundaries: 'Research and draft. Ask before external actions; never send outreach.',
  workflows: [{ name: 'Weekly leads', trigger: 'Friday research request', steps: ['Find three leads', 'Cite sources', 'Report to Chief'], output: 'Three sourced leads' }],
  open_questions: [], instructions: 'Keep the user’s boundaries exactly.',
  handoff_message: 'Prepare the first report only after the user has reviewed and activated setup.',
  user_request: '  Create Nia for Acme research. Correction: THREE leads, not five, every Friday. Never send outreach. Cite every source.\nReport to Chief.  ',
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'Expected local operation to complete');
}

test('exports only the five validated function schemas; voice evidence replaces text citations', () => {
  assert.deepEqual(VOICE_CONTROL_TOOLS.map(tool => tool.name), ['list_agents', 'get_agent', 'create_bot', 'update_agent', 'control_agent']);
  for (const tool of VOICE_CONTROL_TOOLS) {
    assert.equal(tool.type, 'function'); assert.ok(tool.description);
    assert.equal(tool.parameters.type, 'object'); assert.equal(tool.parameters.additionalProperties, false);
  }
  const creation = VOICE_CONTROL_TOOLS.find(tool => tool.name === 'create_bot')!.parameters as any;
  assert.ok(creation.required.includes('user_request'));
  assert.equal(creation.properties.user_request.type, 'string');
  assert.equal(creation.properties.source_message_seqs, undefined);
  assert.equal(creation.required.includes('handoff_message'), false);
  assert.equal((VOICE_CONTROL_TOOLS.find(tool => tool.name === 'control_agent')!.parameters as any).properties.action.const, 'stop');
});

test('advertises primary-only capabilities dynamically and hides creation during setup', () => {
  assert.equal(voiceControlTools(primary.id).length, 5);
  assert.deepEqual(voiceControlTools(secondary.id).map(tool => tool.name), ['list_agents', 'get_agent', 'control_agent']);
  assert.deepEqual(voiceControlTools(helper.id).map(tool => tool.name), ['list_agents', 'get_agent', 'control_agent']);
  assert.deepEqual(voiceControlTools(room.id), []); assert.deepEqual(voiceControlTools('missing'), []);
  db.prepare('UPDATE bots SET is_primary=(id=?) WHERE user_id=?').run(secondary.id, 'owner');
  assert.ok(!voiceControlTools(primary.id).some(tool => tool.name === 'update_agent'));
  assert.ok(!voiceControlTools(secondary.id).some(tool => tool.name === 'create_bot'));
  assert.ok(voiceControlTools(secondary.id).some(tool => tool.name === 'update_agent'));
});

test('unknown and arbitrary tool names fall through without a side effect', async () => {
  for (const name of ['activate_agent', 'delete_bot', 'resolve_approval', 'browser_click', 'mcp_secret', '__proto__', 'constructor']) {
    assert.equal(await runVoiceControl(name, {}, context()), null);
  }
  assert.equal(botCount(), 5);
  assert.deepEqual(screenCalls, []);
});

test('list includes all owned helpers with roles/status and excludes rooms, other tenants and secrets', async () => {
  setLive(helper.id, { isRunning: true, activity: { kind: 'thinking', since: Date.now() } });
  db.prepare("INSERT INTO tasks VALUES(?,?,?,'working',?,?,?)").run('task-roster', helper.id, 'Check sources', 'Private working note', Date.now(), Date.now());
  const listing = await run('list_agents', '{}', context(secondary.id));
  assert.deepEqual(new Set(listing.agents.map((agent: any) => agent.id)), new Set([primary.id, secondary.id, helper.id]));
  const child = listing.agents.find((agent: any) => agent.id === helper.id);
  assert.equal(child.role, 'helper'); assert.equal(child.parentBotId, secondary.id); assert.equal(child.live.isRunning, true);
  assert.equal(child.tasks[0].title, 'Check sources'); assert.equal(child.setup, null);
  const chief = listing.agents.find((agent: any) => agent.id === primary.id);
  assert.equal(chief.role, 'primary'); assert.equal(chief.model, 'test-model'); assert.equal(chief.setup.status, 'active');
  assert.ok(Number.isInteger(chief.setup.revision));
  assert.equal(chief.instructions, undefined);
  assert.doesNotMatch(JSON.stringify(listing), /Foreign|secret|private-provider-key|Private working note/);
});

test('get reads owned configuration, current messages, tasks, routines and setup revision', async () => {
  appendRow(secondary.id, 'message', { type: 'message', role: 'user', text: 'Previous generation' });
  clearConversation(secondary.id);
  appendRow(secondary.id, 'message', { type: 'message', role: 'user', text: 'Research this topic' });
  appendRow(secondary.id, 'message', { type: 'message', role: 'assistant', text: 'Checking sources' });
  appendRow(helper.id, 'message', { type: 'message', role: 'user', text: 'Message from Chief', from: { kind: 'bot', id: primary.id, name: 'Chief' } });
  appendRow(secondary.id, 'tool-call', { type: 'tool-call', callId: 'private-tool', name: 'private_tool', label: 'Private', status: 'done', args: { secret: 'credential-not-returned' } });
  db.prepare("UPDATE bots SET voice='sage',voice_speed=1.2,voice_language='fr',fast=1,model='vendor/model',effort='xhigh' WHERE id=?").run(secondary.id);
  db.prepare("INSERT INTO tasks VALUES(?,?,?,'working',?,?,?)").run('task-detail', secondary.id, 'Research', 'Evidence note', Date.now(), Date.now());
  db.prepare("INSERT INTO routines VALUES(?,?,?,?,?,'UTC',1,NULL,?)").run('routine-detail', secondary.id, 'Weekly research', 'Check three leads', '0 9 * * 5', Date.now());
  const result = await run('get_agent', { bot_id: secondary.id });
  assert.equal(result.agent.id, secondary.id); assert.equal(result.agent.instructions, 'Preserve sourced findings.');
  assert.equal(result.agent.voice, 'sage'); assert.equal(result.agent.voiceSpeed, 1.2); assert.equal(result.agent.voiceLanguage, 'fr');
  assert.equal(result.agent.model, 'vendor/model'); assert.equal(result.agent.effort, 'xhigh'); assert.equal(result.agent.fast, true);
  assert.deepEqual(result.agent.setup.brief, getSetup(secondary.id)!.brief);
  assert.equal(result.agent.setup.revision, getSetup(secondary.id)!.onboarding.revision);
  assert.equal(result.generation, 2);
  assert.deepEqual(result.messages.map((message: any) => message.text), ['Research this topic', 'Checking sources']);
  assert.equal(result.agent.tasks[0].note, 'Evidence note'); assert.equal(result.routines[0].id, 'routine-detail');
  assert.doesNotMatch(JSON.stringify(result), /Previous generation|credential-not-returned|Foreign/);
  assert.equal((await run('get_agent', { bot_id: secondary.id, message_limit: 1 })).messages.length, 1);
  const helperRead = await run('get_agent', { bot_id: helper.id }, context(secondary.id));
  assert.equal(helperRead.agent.id, helper.id); assert.equal(helperRead.messages[0].from.kind, 'bot');
});

test('all reads and mutations enforce actor and target ownership, including helpers', async () => {
  const foreignHelper = createSubagent(foreign.id, 'Private foreign helper');
  const count = botCount();
  for (const target of [foreign.id, foreignHelper.id, 'missing', room.id]) {
    for (const [name, args] of [
      ['get_agent', { bot_id: target }], ['update_agent', { bot_id: target, name: 'Stolen' }], ['control_agent', { bot_id: target, action: 'stop' }],
    ] as const) assert.match((await run(name, args)).error, /not found/);
  }
  for (const actor of [foreign.id, room.id, 'missing']) {
    assert.match((await run('list_agents', {}, context(actor))).error, /not found/);
    assert.match((await run('create_bot', spec(), context(actor))).error, /not found/);
  }
  assert.equal(botCount(), count); assert.deepEqual(screenCalls, []);
  assert.equal(getBotRow(foreign.id).name, 'Foreign identity must stay private');
});

test('strict validation rejects malformed schemas, forbidden mutations and empty requests before writes', async () => {
  const count = botCount();
  for (const [name, args] of [
    ['list_agents', { user_id: 'foreign' }], ['list_agents', null], ['get_agent', { bot_id: secondary.id, message_limit: 0 }],
    ['get_agent', { bot_id: secondary.id, message_limit: 101 }], ['get_agent', { bot_id: secondary.id, message_limit: 1.5 }],
    ['create_bot', { ...spec(), user_request: ' ' }], ['create_bot', { ...spec(), user_request: undefined }],
    ['create_bot', { ...spec(), source_message_seqs: [1] }], ['create_bot', { name: 'Incomplete', user_request: 'Create someone' }],
    ['update_agent', { bot_id: secondary.id }], ['update_agent', { bot_id: secondary.id, instructions: 'Bypass setup' }],
    ['update_agent', { bot_id: secondary.id, name: '' }], ['update_agent', { bot_id: secondary.id, name: 'A\nB' }],
    ['update_agent', { bot_id: secondary.id, model: 123 }], ['update_agent', { bot_id: secondary.id, model: 'x'.repeat(121) }],
    ['update_agent', { bot_id: secondary.id, effort: 'arbitrary' }], ['update_agent', { bot_id: secondary.id, fast: true }],
    ['control_agent', { bot_id: secondary.id, action: 'delete' }], ['control_agent', { bot_id: secondary.id, action: 'stop', approval: true }],
    ['control_agent', '{invalid json'],
  ] as const) assert.ok((await run(name, args)).error, `${name} should reject ${JSON.stringify(args)}`);
  assert.equal(botCount(), count); assert.equal(listRows(primary.id).length, 0); assert.deepEqual(screenCalls, []);
});

test('creates durable setup from the exact voice request, without enqueuing operational work', async () => {
  const requested = spec();
  const result = await run('create_bot', requested);
  assert.equal(result.ok, true); assert.equal(result.computer.status, 'pending'); assert.equal(result.handoff_sent, false);
  assert.equal(result.handoff_deferred, true);
  const bot = getBotRow(result.bot.id), setup = getSetup(bot.id)!;
  assert.equal(bot.user_id, 'owner'); assert.equal(bot.hidden, 0); assert.equal(bot.is_primary, 0);
  assert.equal(bot.model, 'test-model'); assert.equal(bot.effort, 'high');
  assert.equal(setup.onboarding.status, 'interviewing'); assert.equal(setup.source.creatorBotId, primary.id);
  assert.equal(setup.source.messages.length, 1); assert.equal(setup.source.messages[0].text, requested.user_request);
  const row = getRow(primary.id, setup.source.messages[0].seq)!;
  assert.deepEqual(row.body, { type: 'message', role: 'user', text: requested.user_request, from: { kind: 'voice', id: 'voice-session', name: 'Voice call' } });
  assert.equal(setup.brief.context_summary, requested.context_summary); assert.deepEqual(setup.brief.workflows, requested.workflows);
  assert.equal(setup.brief.action_boundaries, requested.action_boundaries);
  const read = await run('get_agent', { bot_id: bot.id });
  assert.deepEqual(read.agent.setup.brief.workflows, requested.workflows);
  assert.equal(read.agent.setup.brief.action_boundaries, requested.action_boundaries);
  assert.ok(setupFiles(bot.id)['CONTEXT.md'].includes(requested.user_request));
  assert.ok(setupFiles(bot.id)['AGENTS.md'].includes('FINAL: cite every source.'));
  assert.equal((db.prepare('SELECT pending_handoff FROM bot_setups WHERE bot_id=?').get(bot.id) as any).pending_handoff, requested.handoff_message);
  assert.ok(listRows(bot.id).some(row => row.body.type === 'message' && row.body.role === 'assistant'));
  assert.deepEqual(jobs(bot.id), []); assert.deepEqual(jobs(primary.id), []);
  assert.equal(loadHistory(bot.id).length, 1, 'Only the canonical setup welcome enters model history');
  assert.throws(() => activateSetup(bot.id, setup.onboarding.revision), /Finish the setup interview/);
  assert.deepEqual(screenCalls, [`owner:${bot.id}`]);
});

test('identical sequential and concurrent retries preserve one identity and one voice evidence row', async () => {
  const [first, overlapping] = await Promise.all([run('create_bot', spec()), run('create_bot', spec())]);
  const retry = await run('create_bot', spec());
  const concurrent = await Promise.all([run('create_bot', spec()), run('create_bot', spec())]);
  assert.equal(retry.already_created, true);
  for (const result of [overlapping, retry, ...concurrent]) assert.equal(result.bot.id, first.bot.id);
  assert.equal(botCount(), 6); assert.equal(listRows(primary.id).length, 1);
  assert.equal(getSetup(first.bot.id)!.source.messages.length, 1);
  assert.deepEqual(jobs(first.bot.id), []);
  const changed = await run('create_bot', { ...spec(), instructions: 'Conflicting replacement' });
  assert.match(changed.error, /already exists/); assert.equal(botCount(), 6);
  assert.equal(getBotRow(first.bot.id).instructions, spec().instructions);
  assert.equal(listRows(primary.id).length, 1);
});

test('secondary and configuring primary creation cannot bypass canonical setup gating', async () => {
  const count = botCount();
  assert.match((await run('create_bot', spec(), context(secondary.id))).error, /current primary/);
  db.prepare("UPDATE bot_setups SET onboarding_status='review' WHERE bot_id=?").run(primary.id);
  assert.match((await run('create_bot', spec())).error, /setup/);
  assert.equal(botCount(), count); assert.equal(listRows(primary.id).length, 0);
  assert.deepEqual(screenCalls, []);
});

test('primary metadata/model updates regenerate setup, invalidate revision and emit only to owner', async () => {
  const before = getSetup(secondary.id)!;
  const ownerEvents: any[] = [], otherEvents: any[] = [];
  const offOwner = hub.subscribe('owner', event => ownerEvents.push(event));
  const offForeign = hub.subscribe('foreign', event => otherEvents.push(event));
  try {
    const result = await run('update_agent', { bot_id: secondary.id, name: '  Research Two  ', label: 'Analyst', description: 'Source-backed analysis', model: '  vendor/model  ', effort: 'xhigh' });
    assert.equal(result.ok, true); assert.equal(result.agent.name, 'Research Two'); assert.equal(result.agent.model, 'vendor/model');
    assert.equal(result.agent.effort, 'xhigh'); assert.equal(getSetup(secondary.id)!.onboarding.revision, before.onboarding.revision + 1);
    assert.deepEqual(getSetup(secondary.id)!.brief, before.brief); assert.equal(getSetup(secondary.id)!.onboarding.status, 'interviewing');
    assert.match(setupFiles(secondary.id)['IDENTITY.md'], /Research Two/);
    assert.equal(JSON.parse(setupFiles(secondary.id)['bot-setup.json']).bot.model, 'vendor/model');
    assert.deepEqual(ownerEvents.map(event => event.type), ['setup', 'bot']); assert.deepEqual(otherEvents, []);
    assert.equal(getBotRow(secondary.id).instructions, 'Preserve sourced findings.');
  } finally { offOwner(); offForeign(); }
});

test('model/effort follow route validation and updates recheck the current primary', async () => {
  for (const effort of EFFORTS) assert.equal((await run('update_agent', { bot_id: secondary.id, effort })).agent.effort, effort);
  assert.equal((await run('update_agent', { bot_id: secondary.id, model: ' ' })).agent.model, null);
  assert.equal((await run('update_agent', { bot_id: secondary.id, model: null })).agent.model, null);
  assert.equal((await run('update_agent', { bot_id: helper.id, name: 'Updated helper' })).agent.name, 'Updated helper');
  assert.match((await run('update_agent', { bot_id: secondary.id, name: 'No' }, context(secondary.id))).error, /current primary/);
  db.prepare('UPDATE bots SET is_primary=0 WHERE id=?').run(primary.id);
  assert.match((await run('update_agent', { bot_id: secondary.id, name: 'Stale primary' })).error, /current primary/);
  assert.equal(getBotRow(secondary.id).name, 'Research');
});

test('stop cancels scheduled work before it starts and preserves identities, setup, tasks and routines', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = runInBotQueue(helper.id, async () => gate);
  enqueue(helper.id, { type: 'system', text: 'Must never execute' });
  const otherJob = acceptJob(secondary.id, { type: 'system', text: 'Leave peer queued' });
  const foreignJob = acceptJob(foreign.id, { type: 'system', text: 'Leave foreign queued' });
  const before = getSetup(secondary.id);
  try {
    const stopped = await run('control_agent', { bot_id: helper.id, action: 'stop' });
    assert.equal(stopped.ok, true); assert.equal(stopped.cancelled_jobs, 1);
    assert.equal(jobs(helper.id)[0].state, 'cancelled'); assert.ok(jobs(helper.id)[0].finished_at);
    assert.equal(beginJob(jobs(helper.id)[0].id), false);
    assert.equal(jobs(secondary.id).find(job => job.id === otherJob.id).state, 'queued');
    assert.equal(jobs(foreign.id).find(job => job.id === foreignJob.id).state, 'queued');
    assert.ok(getBotRow(helper.id)); assert.deepEqual(getSetup(secondary.id), before);
  } finally { release(); await held; await settleAgentJobs(); }
  assert.equal(loadHistory(helper.id).length, 0); assert.equal(getLive(helper.id).isRunning, false);
  assert.equal(jobs(helper.id)[0].state, 'cancelled');
});

test('secondary may stop only itself; current primary can stop every owned agent including helpers', async () => {
  acceptJob(primary.id, { type: 'system', text: 'Primary pending' });
  acceptJob(helper.id, { type: 'system', text: 'Helper pending' });
  acceptJob(secondary.id, { type: 'system', text: 'Own pending' });
  for (const botId of [primary.id, helper.id]) assert.match((await run('control_agent', { bot_id: botId, action: 'stop' }, context(secondary.id))).error, /primary/);
  assert.equal((await run('control_agent', { bot_id: secondary.id, action: 'stop' }, context(secondary.id))).ok, true);
  assert.equal(jobs(secondary.id)[0].state, 'cancelled'); assert.equal(jobs(helper.id)[0].state, 'queued');
  assert.equal((await run('control_agent', { bot_id: helper.id, action: 'stop' })).ok, true);
  assert.equal((await run('control_agent', { bot_id: primary.id, action: 'stop' })).ok, true);
  assert.equal(botCount(), 5);
});

test('stop aborts the active turn and keeps its durable job cancelled after the loop settles', { timeout: 10000 }, async t => {
  let reachedModel = false;
  t.mock.method(llmClient(360_000).responses, 'create', async (_body: unknown, options: any) => {
    reachedModel = true;
    return new Promise((_resolve, reject) => {
      const stopped = () => reject(new Error('Aborted by test'));
      if (options.signal.aborted) stopped();
      else options.signal.addEventListener('abort', stopped, { once: true });
    });
  });
  enqueue(primary.id, { type: 'user', text: 'Hold this active voice task' });
  try {
    await until(() => reachedModel);
    const signal = turnSignal(primary.id)!;
    assert.equal(signal.aborted, false); assert.equal(jobs(primary.id)[0].state, 'running');
    enqueue(primary.id, { type: 'system', text: 'Queued behind active task' });
    const stopped = await run('control_agent', { bot_id: primary.id, action: 'stop' });
    assert.equal(signal.aborted, true); assert.equal(stopped.cancelled_jobs, 2);
    await settleAgentJobs();
    assert.deepEqual(jobs(primary.id).map(job => job.state), ['cancelled', 'cancelled']);
    assert.equal(getLive(primary.id).isRunning, false);
    assert.ok(listRows(primary.id).some(row => row.body.type === 'notice' && row.body.text === 'Stopped.'));
  } finally { interrupt(primary.id); await settleAgentJobs(); }
});

test('stop expires paused approvals and denies remaining planned calls without granting approval', async () => {
  const call = appendRow(secondary.id, 'tool-call', { type: 'tool-call', callId: 'pending-call', name: 'browser_click', label: 'Clicking', status: 'awaiting-approval' });
  const card = appendRow(secondary.id, 'card', { type: 'card', card: 'approval', approvalId: 'pending-approval', title: 'Allow click?', detail: 'Button', tool: 'browser_click', args: {}, status: 'pending' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('pending-approval', secondary.id, card.seq, 'pending-call', 'browser_click', 'pending', Date.now());
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(secondary.id, JSON.stringify({ approvalId: 'pending-approval', depth: 0,
    calls: [{ call_id: 'pending-call', rowSeq: call.seq }], outputs: [{ type: 'function_call_output', call_id: 'earlier-call', output: 'Earlier result', __endTurn: true }] }));
  setLive(secondary.id, { isRunning: false, awaiting: { reason: 'Approval', since: Date.now() } });
  const initialSetup = getSetup(secondary.id);
  db.prepare("INSERT INTO tasks VALUES(?,?,?,'needs_input',?,?,?)").run('paused-task', secondary.id, 'Pending research', 'Keep task', Date.now(), Date.now());
  db.prepare("INSERT INTO routines VALUES(?,?,?,?,?,'UTC',1,NULL,?)").run('paused-routine', secondary.id, 'Weekly', 'Research', '0 9 * * 5', Date.now());
  const result = await run('control_agent', { bot_id: secondary.id, action: 'stop' });
  assert.equal(result.ok, true); assert.equal(botCount(), 5);
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get('pending-approval') as any).status, 'expired');
  assert.equal(db.prepare('SELECT * FROM pending_turns WHERE bot_id=?').get(secondary.id), undefined);
  assert.equal((getRow(secondary.id, card.seq)!.body as any).status, 'expired');
  assert.equal((getRow(secondary.id, call.seq)!.body as any).status, 'denied');
  const history = loadHistory(secondary.id);
  assert.equal(history[0].__endTurn, undefined); assert.match(history[1].output, /stopped/);
  resolveApproval('owner', 'pending-approval', 'allow');
  assert.deepEqual(jobs(secondary.id), []); assert.equal(getLive(secondary.id).awaiting, null);
  assert.deepEqual(getSetup(secondary.id), initialSetup);
  assert.ok(db.prepare('SELECT * FROM tasks WHERE id=?').get('paused-task'));
  assert.equal((db.prepare('SELECT enabled FROM routines WHERE id=?').get('paused-routine') as any).enabled, 1);
});
