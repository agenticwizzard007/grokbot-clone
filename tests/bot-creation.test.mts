// Deterministic lifecycle tests: isolated database/files, no model key or live VM required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-creation-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '' });
const networkRequests: unknown[][] = [];
mock.method(globalThis, 'fetch', async (...args: unknown[]) => {
  networkRequests.push(args);
  throw new Error('Unexpected network request in isolated creation/preview tests');
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms, createRoom } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, clearConversation, getBotRow, setLive } = await import('../server/src/store.js');
const { createTeammate, replicateTeammate, retryTeammate, importTeammate } = await import('../server/src/agent/teammates.js');
const { setupFiles, setupDirectory, getSetup, setupManifest, saveSetupDraft, activateSetup } = await import('../server/src/bot-setup.js');
const { systemPrompt } = await import('../server/src/agent/prompt.js');
const { functionSchemas } = await import('../server/src/agent/tools.js');
const { computers } = await import('../server/src/computers/index.js');
const { Hono } = await import('hono');
const { api } = await import('../server/src/routes.js');
const { configApi } = await import('../server/src/routes-config.js');
const { withUsage } = await import('../server/src/usage-context.js');
const app = new Hono().route('/api', api).route('/api', configApi);
// Exercise the configuration router's own auth boundary, independently of api.
const previewApp = new Hono().route('/api', configApi);
const preview = (botId: string, session = cookie) => previewApp.request(`/api/bots/${botId}/instructions`, {
  headers: session ? { cookie: `swarm_session=${session}` } : {},
});
for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
const cookie = 'test-session';
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(cookie, 'owner', Date.now(), Date.now()+60000);
const master = createBot('owner', { name: 'Chief', isPrimary: true, model: 'test-model', effort: 'high' });
const foreign = createBot('other', { name: 'Foreign', isPrimary: true });
const userText = 'Own LinkedIn research for Acme. Produce five sourced leads each Friday. Do not send outreach. Use the shared research guide.';
const briefRow = appendRow(master.id, 'message', { type: 'message', role: 'user', text: userText });
const correction = appendRow(master.id, 'message', { type: 'message', role: 'user', text: 'Correction: three leads, not five. Send the report to Chief.' });
const assistant = appendRow(master.id, 'message', { type: 'message', role: 'assistant', text: 'Untrusted generated role proposal.' });
const sent: any[] = [];
const ctx = { botId: master.id, userId: 'owner', depth: 0, enqueueBotMessage: (...args: any[]) => sent.push(args) };
const spec = { name: 'Nia', label: 'LinkedIn Research', purpose: 'Own Acme’s LinkedIn lead research.', responsibilities: ['Research three relevant leads each Friday', 'Produce sourced research notes'], out_of_scope: ['Never send outreach or connection requests'], success_criteria: ['Three sourced leads reviewed by Chief'], context_summary: 'The latest correction is three leads, not five. Follow the research guide. '+ 'Relevant detail. '.repeat(600) + 'FINAL REQUIREMENT: cite every source.', shared_resources: ['Shared research guide: /shared/guide.md; verify access before use'], handoff_notes: ['Report to Chief with evidence and any blockers'], instructions: 'Use concise factual prose.', source_message_seqs: [briefRow.seq, correction.seq], handoff_message: 'Confirm your remit to Chief; wait for a research assignment.' };
const calls: string[] = [];
let online = false;
computers.screen = async (userId, botId) => { calls.push(`${userId}:${botId}`); if (!online) throw new Error('PC disconnected'); return { screenshot: async () => ({ image: '', mime: 'image/png', width: 1, height: 1 }) } as any; };
let teammate: any;
const decode = (r: any) => JSON.parse(r.output as string);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('primary receives creation tools and a current-capability reminder, even with old refusals', async () => {
  assert.ok(functionSchemas(master.id).some((t) => t.name === 'create_bot'));
  const prompt = await systemPrompt('owner', master.id);
  assert.match(prompt, /You CAN create permanent teammates/);
  assert.match(prompt, new RegExp(`Message ${correction.seq}`));
});

test('rejects incomplete, unauthorized and fabricated briefs without creating bots', async () => {
  const count = () => (db.prepare('SELECT count(*) n FROM bots').get() as any).n;
  const before = count();
  await assert.rejects(createTeammate({ name: 'Vague', purpose: 'Help out' }, ctx));
  await assert.rejects(createTeammate({ ...spec, source_message_seqs: [assistant.seq] }, ctx), /not a user message/);
  await assert.rejects(createTeammate(spec, { ...ctx, botId: foreign.id }), /Only this user/);
  await assert.rejects(createTeammate({ ...spec, name: 'x'.repeat(61) }, ctx));
  assert.equal(count(), before);
});

test('creates a visible durable teammate and complete setup despite an offline computer', async () => {
  const result = decode(await createTeammate(spec, ctx));
  teammate = result.bot;
  assert.equal(result.computer.status, 'pending');
  assert.match(result.computer.error, /disconnected/);
  const row = getBotRow(teammate.id);
  assert.equal(row.hidden, 0); assert.equal(row.is_primary, 0); assert.equal(row.model, 'test-model');
  const files = setupFiles(teammate.id);
  assert.deepEqual(Object.keys(files).sort(), ['AGENTS.md','CONTEXT.md','HANDOFFS.md','IDENTITY.md','RESOURCES.md','SOUL.md','WORKFLOWS.md','bot-setup.json'].sort());
  assert.match(files['AGENTS.md'], /FINAL REQUIREMENT: cite every source/);
  assert.match(files['AGENTS.md'], /Never send outreach/);
  assert.match(files['CONTEXT.md'], /Correction: three leads, not five/);
  assert.equal(fs.readFileSync(path.join(setupDirectory(teammate.id), 'AGENTS.md'), 'utf8'), files['AGENTS.md']);
  assert.equal(sent.length, 0); assert.equal(result.handoff_deferred, true);
  assert.equal(getSetup(teammate.id)?.onboarding.status, 'interviewing');
  assert.deepEqual(functionSchemas(teammate.id).map(t => t.name).sort(), ['ask_user', 'get_platform_state', 'list_app_connections', 'request_app_connection', 'save_agent_setup', 'search_apps']);
  assert.ok(!functionSchemas(teammate.id).some((t) => t.name === 'create_bot'));
  await assert.rejects(createTeammate({ ...spec, name: 'Not allowed' }, { ...ctx, botId: teammate.id }), /Only this user/);
});

test('retries the same setup without duplicates or replaying the initial handoff', async () => {
  online = true;
  const result = decode(await createTeammate(spec, ctx));
  assert.equal(result.bot.id, teammate.id); assert.equal(result.already_created, true);
  assert.equal(result.computer.status, 'ready'); assert.equal(sent.length, 0);
  await assert.rejects(createTeammate({ ...spec, name: ' nIa ', purpose: 'Another job' }, ctx), /already exists/);
  const retried = decode(await retryTeammate({ bot_name: 'Nia' }, ctx));
  assert.equal(retried.bot_id, teammate.id);
});

test('guided setup saves answers and working style, requires review, and rejects stale activation', async () => {
  const before = getSetup(teammate.id)!;
  assert.throws(() => activateSetup(teammate.id, before.onboarding.revision), /Finish the setup interview/);
  const answer = appendRow(teammate.id, 'message', { type: 'message', role: 'user', text: 'On my request, turn my notes into three sourced leads. Ask me before outreach. Use concise bullet points.' });
  const draft = { ...before.brief, instructions: spec.instructions, stage: 'interviewing', revision: before.onboarding.revision, source_message_seqs: [answer.seq], communication_style: 'Concise bullet points; state uncertainty.', open_questions: ['What should happen when sources are missing?'] };
  assert.throws(() => saveSetupDraft(teammate.id, 'other', draft), /Start or resume/);
  const saved = saveSetupDraft(teammate.id, 'owner', draft);
  assert.match(saved.files['SOUL.md'], /Concise bullet points/);
  assert.match(saved.files['CONTEXT.md'], /On my request/);
  assert.throws(() => saveSetupDraft(teammate.id, 'owner', draft), /configuration changed/);
  assert.throws(() => saveSetupDraft(teammate.id, 'owner', { ...draft, revision: saved.onboarding.revision, stage: 'review' }), /Finish the brief/);
  const final = saveSetupDraft(teammate.id, 'owner', { ...draft, revision: saved.onboarding.revision, stage: 'review', open_questions: [], action_boundaries: 'Research and draft from supplied notes. Ask before any outreach; never invent sources.', workflows: [{ name: 'Research brief', trigger: 'The user supplies notes and requests a report', steps: ['Extract three relevant leads', 'Cite the evidence for each lead', 'Flag missing sources and report to Chief'], output: 'Three sourced lead summaries with unresolved gaps flagged' }] });
  assert.equal(final.onboarding.status, 'review');
  assert.match(final.files['WORKFLOWS.md'], /The user supplies notes/);
  assert.match(await systemPrompt('owner', teammate.id), /setup consultant/);
  assert.throws(() => activateSetup(teammate.id, saved.onboarding.revision), /specification changed/);
  assert.equal(activateSetup(teammate.id, final.onboarding.revision), spec.handoff_message);
  assert.equal(getSetup(teammate.id)?.onboarding.status, 'active');
  assert.ok(functionSchemas(teammate.id).some(t => t.name === 'open_browser'));
  assert.ok(!functionSchemas(teammate.id).some(t => t.name === 'save_agent_setup'));
  assert.throws(() => saveSetupDraft(teammate.id, 'owner', { ...draft, revision: final.onboarding.revision+1 }), /Start or resume/);
});

test('a simple personal task can reach review without optional handoffs or style questions', () => {
  const simple = createBot('owner', { name: 'Notes', description: 'Summarize notes pasted into chat.' });
  const answer = appendRow(simple.id, 'message', { type: 'message', role: 'user', text: 'When I ask, summarize my pasted notes in three accurate bullets. Return them here. Ask if the notes are ambiguous; do not act outside this chat.' });
  const initial = getSetup(simple.id)!;
  const view = saveSetupDraft(simple.id, 'owner', {
    ...initial.brief, responsibilities: ['Summarize user-provided notes'], success_criteria: ['Exactly three bullets grounded in the notes'],
    action_boundaries: 'Summarize in chat only; ask about ambiguity. No external actions.',
    workflows: [{ name: 'Summarize notes', trigger: 'The user pastes notes and requests a summary', steps: ['Read the notes', 'Extract the three key points'], output: 'Three accurate bullet points in this chat' }],
    handoff_notes: [], shared_resources: [], open_questions: [], instructions: '', revision: initial.onboarding.revision, stage: 'review', source_message_seqs: [answer.seq],
  });
  assert.equal(view.onboarding.status, 'review');
  assert.deepEqual(view.onboarding.missing, []);
  activateSetup(simple.id, view.onboarding.revision);
  assert.equal(getSetup(simple.id)?.onboarding.status, 'active');
});

test('the exact charter survives a fresh chat and remains in the model system prompt', async () => {
  clearConversation(teammate.id);
  const prompt = await systemPrompt('owner', teammate.id);
  assert.match(prompt, /persistent charter \(AGENTS.md\)/);
  assert.match(prompt, /three leads, not five/);
  assert.match(prompt, /FINAL REQUIREMENT: cite every source/);
  assert.equal(getSetup(teammate.id)?.source.messages[0].text, userText);
});

test('replication/import reproduce the brief and settings with a distinct identity/browser', async () => {
  const result = decode(await replicateTeammate({ bot_name: 'Nia', new_name: 'Nia Two' }, ctx));
  assert.notEqual(result.bot.id, teammate.id); assert.equal(result.bot.name, 'Nia Two');
  assert.deepEqual(getSetup(result.bot.id)?.brief, getSetup(teammate.id)?.brief);
  assert.match(setupFiles(result.bot.id)['IDENTITY.md'], /Nia Two/);
  assert.ok(calls.includes(`owner:${teammate.id}`)); assert.ok(calls.includes(`owner:${result.bot.id}`));
  assert.equal(getSetup(result.bot.id)?.onboarding.status, 'interviewing');
  assert.equal((db.prepare('SELECT count(*) n FROM llm_items WHERE bot_id=?').get(result.bot.id) as any).n, 1); // only its own setup welcome
  const imported = await importTeammate('other', JSON.parse(setupFiles(teammate.id)['bot-setup.json']), 'Imported');
  assert.equal(getBotRow(imported.bot!.id).user_id, 'other');
  assert.deepEqual(setupManifest(imported.bot!.id)?.brief, getSetup(teammate.id)?.brief);
  await assert.rejects(replicateTeammate({ bot_name: 'Foreign', new_name: 'Leak' }, ctx), /No saved setup/);
});

test('authenticated Library/API serve setup while offline and reject another owner', async () => {
  const request = (url: string, init: any = {}) => app.request(url, { ...init, headers: { cookie: `swarm_session=${cookie}`, 'content-type': 'application/json', ...init.headers } });
  const listing = await request(`/api/bots/${teammate.id}/files?path=Setup`);
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).files.length, 8);
  const download = await request(`/api/bots/${teammate.id}/setup/AGENTS.md`);
  assert.equal(download.status, 200); assert.match(await download.text(), /Never send outreach/);
  assert.equal((await request(`/api/bots/${foreign.id}/setup/bot-setup.json`)).status, 404);
  assert.equal((await request(`/api/bots/${teammate.id}/setup/unknown`)).status, 404);
});

test('parallel VM leases are distinct; a full VM never evicts active teammates', async () => {
  const { orgo } = await import('../server/src/orgo.js');
  const { screenFor } = await import('../server/src/computers/orgo-box.js');
  db.prepare("INSERT INTO computers(user_id,orgo_id,status,updated_at) VALUES ('owner','test-vm','running',?)").run(Date.now());
  let screens = [{ id: 'default' }]; let n = 100;
  orgo.getComputer = async () => ({ id: 'test-vm', status: 'running' } as any);
  orgo.listScreens = async () => { await new Promise((r) => setTimeout(r, 5)); return [...screens] as any; };
  orgo.getScreen = async (_c, id) => { const s = screens.find((s) => s.id === id); if (!s) throw new Error('missing'); return s as any; };
  orgo.createScreen = async () => { const s = { id: `screen-${n++}` }; screens.push(s); return s as any; };
  orgo.deleteScreen = async (_c, id) => { screens = screens.filter((s) => s.id !== id); return {} as any; };
  orgo.bash = async () => ({ exit_code: 0, output: '' });
  const ids = [master.id, teammate.id, createBot('owner', { name: 'Three' }).id, createBot('owner', { name: 'Four' }).id];
  const leases = await Promise.all(ids.map((id) => screenFor('owner', id)));
  assert.equal(new Set(leases.map((s) => s.screenId)).size, 4);
  for (const id of ids) setLive(id, { isRunning: true });
  const fifth = createBot('owner', { name: 'Five' });
  await assert.rejects(screenFor('owner', fifth.id), /screens are busy/);
  assert.equal((db.prepare('SELECT count(*) n FROM screens').get() as any).n, 4);
  setLive(teammate.id, { isRunning: false });
  const lease = await screenFor('owner', fifth.id);
  assert.ok(!leases.some((s) => s.screenId === lease.screenId));
  assert.equal(db.prepare('SELECT * FROM screens WHERE bot_id=?').get(teammate.id), undefined);
});

test('instruction preview requires authentication and never reveals foreign, hidden or room prompts', async () => {
  for (const session of ['', 'invalid-session']) {
    const response = await preview(master.id, session);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  }
  const otherSession = 'preview-other-session';
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)')
    .run(otherSession, 'other', Date.now(), Date.now() + 60000);
  const hidden = createBot('owner', { name: 'Private helper preview', instructions: 'HIDDEN_PROMPT_SECRET' });
  db.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(hidden.id);
  const room = createRoom('owner', 'Preview room', [master.id]);
  for (const [id, session] of [[foreign.id, cookie], [master.id, otherSession], [hidden.id, cookie], [room, cookie], ['missing-bot', cookie]]) {
    const response = await preview(id, session);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
});

test('instruction preview returns actual setup and active prompts, with only its own memory and skills after activation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const bot = createBot('owner', { name: 'Preview lifecycle', instructions: 'PREVIEW_STANDING_INSTRUCTION' });
  for (const [scope, botId] of [['ACTIVE', bot.id], ['FOREIGN', foreign.id], ['SIBLING', master.id]]) {
    db.prepare('INSERT INTO skills(id,bot_id,name,body,created_at) VALUES (?,?,?,?,?)')
      .run(`preview-skill-${scope}`, botId, `Preview skill ${scope}`, `PREVIEW_${scope}_SKILL_BODY`, Date.now());
    db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)')
      .run(`preview-memory-${scope}`, botId, `PREVIEW_${scope}_MEMORY_BODY`, Date.now());
  }
  // Downloaded/exported files are not the runtime prompt's source of truth.
  fs.writeFileSync(path.join(setupDirectory(bot.id), 'AGENTS.md'), 'STALE_EXPORTED_FILE_ONLY');
  const check = async (stage: string) => {
    const started = Date.now();
    const response = await preview(bot.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.stage, stage);
    assert.equal(body.revision, getSetup(bot.id)!.onboarding.revision);
    assert.ok(Number.isSafeInteger(body.capturedAt) && body.capturedAt >= started && body.capturedAt <= Date.now());
    assert.equal(body.instructions, await withUsage({ userId: 'owner', botId: bot.id }, () => systemPrompt('owner', bot.id)));
    assert.match(body.instructions, /PREVIEW_STANDING_INSTRUCTION/);
    assert.doesNotMatch(body.instructions, /STALE_EXPORTED_FILE_ONLY/);
    assert.doesNotMatch(body.instructions, /PREVIEW_(?:FOREIGN|SIBLING)_(?:MEMORY|SKILL)_BODY/);
    if (stage === 'active') {
      assert.doesNotMatch(body.instructions, /You are the setup consultant/);
      assert.match(body.instructions, /persistent charter \(AGENTS.md\)/);
      assert.match(body.instructions, /PREVIEW_ACTIVE_SKILL_BODY/);
      assert.match(body.instructions, /PREVIEW_ACTIVE_MEMORY_BODY/);
    } else {
      assert.match(body.instructions, /You are the setup consultant/);
      assert.match(body.instructions, new RegExp(`Current setup status: ${stage}`));
      assert.doesNotMatch(body.instructions, /PREVIEW_ACTIVE_SKILL_BODY/);
      assert.doesNotMatch(body.instructions, /PREVIEW_ACTIVE_MEMORY_BODY/);
    }
  };
  await check('interviewing');
  const setup = getSetup(bot.id)!;
  const review = saveSetupDraft(bot.id, 'owner', {
    ...setup.brief, instructions: 'PREVIEW_STANDING_INSTRUCTION', revision: setup.onboarding.revision,
    stage: 'review', source_message_seqs: [], open_questions: [], action_boundaries: 'Summarize in chat only.',
    workflows: [{ name: 'Summary', trigger: 'User supplies notes', steps: ['Summarize the supplied notes'], output: 'A summary in chat' }],
  });
  await check('review');
  activateSetup(bot.id, review.onboarding.revision);
  await check('active');
});

test('instruction preview reflects owner standing-instruction PATCH immediately without a stale prompt cache', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const bot = createBot('owner', { name: 'Preview edits', isPrimary: true, instructions: 'PREVIEW_ORIGINAL_INSTRUCTION' });
  const before = await (await preview(bot.id)).json();
  assert.match(before.instructions, /PREVIEW_ORIGINAL_INSTRUCTION/);
  const update = await app.request(`/api/bots/${bot.id}`, {
    method: 'PATCH', headers: { cookie: `swarm_session=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instructions: 'PREVIEW_REPLACEMENT_INSTRUCTION' }),
  });
  assert.equal(update.status, 200);
  const response = await preview(bot.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const after = await response.json();
  assert.equal(after.stage, 'active');
  assert.equal(after.revision, before.revision + 1);
  assert.match(after.instructions, /## Standing instructions\nPREVIEW_REPLACEMENT_INSTRUCTION/);
  // Creation context is retained separately; PATCH replaces standing instructions.
  assert.doesNotMatch(after.instructions, /## Standing instructions\nPREVIEW_ORIGINAL_INSTRUCTION/);
  assert.equal(after.instructions, await withUsage({ userId: 'owner', botId: bot.id }, () => systemPrompt('owner', bot.id)));
});

test('instruction CAS rejects a stale tab without changing the newer text or revision and accepts a refreshed expectation', async () => {
  const bot = createBot('owner', { name: 'Concurrent instruction edits', isPrimary: true, instructions: 'CAS_ORIGINAL_TEXT' });
  const patch = (body: unknown) => app.request(`/api/bots/${bot.id}`, {
    method: 'PATCH', headers: { cookie: `swarm_session=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const snapshot = () => ({ bot: getBotRow(bot.id), setup: getSetup(bot.id), files: setupFiles(bot.id) });
  const originalRevision = getSetup(bot.id)!.onboarding.revision;
  const first = await patch({ expectedInstructions: 'CAS_ORIGINAL_TEXT', instructions: 'CAS_NEWER_TAB_TEXT' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).bot.instructions, 'CAS_NEWER_TAB_TEXT');
  assert.equal(getSetup(bot.id)!.onboarding.revision, originalRevision + 1);
  const newer = snapshot();
  const stale = await patch({ expectedInstructions: 'CAS_ORIGINAL_TEXT', instructions: 'CAS_STALE_TAB_TEXT', label: 'Must not be applied' });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'Instructions changed elsewhere. Reload the current instructions before saving.' });
  assert.deepEqual(snapshot(), newer);
  // Reloading the original field lets the second tab save; the exact 8000 limit is valid.
  const replacement = 'x'.repeat(8000);
  const refreshed = await patch({ expectedInstructions: newer.bot.instructions, instructions: replacement });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).bot.instructions, replacement);
  assert.equal(getSetup(bot.id)!.onboarding.revision, originalRevision + 2);
  assert.equal(getSetup(bot.id)!.onboarding.status, 'active');
  assert.ok(setupFiles(bot.id)['AGENTS.md'].includes(`## Standing instructions\n${replacement}\n`));
});

test('instruction CAS validates expected text and replacement before mutating instructions, metadata or setup revision', async () => {
  const bot = createBot('owner', { name: 'Invalid instruction edits', isPrimary: true, instructions: 'CAS_VALID_BASE' });
  const snapshot = () => ({ bot: getBotRow(bot.id), setup: getSetup(bot.id), files: setupFiles(bot.id) });
  const before = snapshot();
  const malformed = [
    ...[null, 12, true, [], {}].map(expectedInstructions => ({ expectedInstructions, instructions: 'Must not be saved' })),
    { expectedInstructions: 'CAS_VALID_BASE' },
    ...[null, 12, [], 'x'.repeat(8001)].map(instructions => ({ expectedInstructions: 'CAS_VALID_BASE', instructions })),
  ];
  for (const body of malformed) {
    const response = await app.request(`/api/bots/${bot.id}`, {
      method: 'PATCH', headers: { cookie: `swarm_session=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, label: 'Must not be applied' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad instructions' });
    assert.deepEqual(snapshot(), before);
  }
});

test('instruction preview never invokes a model, queues work, records usage or drives a browser', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { setEnvOverride } = await import('../server/src/env.js');
  setEnvOverride('DIRECT_API_KEY', 'test-preview-key-never-sent');
  setEnvOverride('LLM_PROVIDER', 'direct');
  t.after(() => { setEnvOverride('DIRECT_API_KEY', null); setEnvOverride('LLM_PROVIDER', null); });
  const client = withUsage({ userId: 'owner', botId: master.id }, () => llmClient(360_000));
  const generation = t.mock.method(client.responses, 'create', async () => { throw new Error('Preview must not generate'); });
  const draft = createBot('owner', { name: 'Preview no execution' });
  const snapshot = () => ['agent_jobs', 'tool_dispatches', 'rows', 'llm_items', 'usage_events'].map(table =>
    (db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n);
  const before = snapshot(), browserCalls = calls.length;
  assert.equal((await preview(master.id)).status, 200);
  assert.equal((await preview(draft.id)).status, 200);
  assert.equal(generation.mock.callCount(), 0);
  assert.deepEqual(snapshot(), before);
  assert.equal(calls.length, browserCalls);
  assert.equal(networkRequests.length, 0, 'No external request, including swallowed failures, is permitted');
});
