import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { mockCliProvider, modelOutputs, modelTools, usesCodeMode, codeModeAction } from './fixtures/real-cli-provider.mjs';

// Official binaries, production hosted profiles and MCP transport. Only account
// metadata, model responses and the external app are local fixtures.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-internal-parity-'));
Object.assign(process.env, { NODE_ENV: 'production', DEV_LOGIN: '0', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), CLI_PROFILES_DIR: path.join(root, 'profiles'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
const { db, appArgs, appExecutions } = await import('./fixtures/api-approval-backends.mjs');
const { createBot } = await import('../server/src/bots.js');
const { api } = await import('../server/src/routes.js');
const { configApi } = await import('../server/src/routes-config.js');
const { deliverablesApi } = await import('../server/src/routes-deliverables.js');
const { readArtifact } = await import('../server/src/deliverables/index.js');
const { knowledgeApi } = await import('../server/src/routes-knowledge.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { runInBotQueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { appendRow, listRows } = await import('../server/src/store.js');
const { learningSettings, patchLearningSettings } = await import('../server/src/knowledge/settings.js');
const { listSkills, listSkillProposals, updateSkill, setSkillScope } = await import('../server/src/knowledge/skills.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { toolManagement, withManagement } = await import('../server/src/knowledge/access.js');
const { acceptJob, beginJob, finishJob } = await import('../server/src/agent/jobs.js');
const { onLearningTurn, runLearningReview, configureLearningModelExecutor } = await import('../server/src/agent/learning.js');
const { unscheduleRoutine } = await import('../server/src/routines.js');
const { hub } = await import('../server/src/lib/hub.js');
const { saveAccountPreferences } = await import('../server/src/settings.js');
const app = new Hono().route('/api/deliverables', deliverablesApi).route('/api', configApi).route('/api', knowledgeApi).route('/api', api);
let serial = 0;
after(async () => { await settleAgentJobs(); for (const row of db.prepare('SELECT id FROM routines').all() as any[]) unscheduleRoutine(row.id); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const texts = (value: any): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts) : value?.text ? [value.text] : [];
const outputs = (provider: string, body: any) => modelOutputs(provider, body).flatMap(texts).flatMap((text: string) => { try { return [JSON.parse(text)]; } catch { return []; } });
type Action = { name: string; args: any; wrapped?: boolean };

async function account(t: any, provider: 'codex' | 'claude') {
  const directory = path.join(root, String(++serial)); fs.mkdirSync(directory);
  const userId = `internal-${serial}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(userId, userId, Date.now(), Date.now() + 3600000);
  const bot = createBot(userId, { name: 'Parity fixture', isPrimary: true });
  selectCli(userId, provider);
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, bot.id);
  // A stored API maximum preference must not affect either connected CLI plan.
  saveAccountPreferences(userId, { apiApprovalLevel: 'every_action' });
  patchLearningSettings(userId, { expectedRevision: 0, settings: { automaticReview: false } });
  assert.equal(learningSettings(userId, bot.id).settings.skillApproval, false);
  let actions: Action[] = [], describing = false;
  const fixture = await mockCliProvider(directory, (p: string, body: any) => {
    if (!modelTools(p, body).length && !usesCodeMode(body)) return { text: 'Auxiliary fixture.' };
    const action = actions[0];
    if (!action) return { text: 'Fixture actions completed.' };
    if (action.wrapped && p === 'codex' && usesCodeMode(body)) {
      actions.shift();
      // Code mode returns an MCP result envelope to the JS cell. Consume the
      // described schema in that cell, just as the hosted model does.
      return { code: `const described = await tools.mcp__swarm__tool_describe({tool_name:${JSON.stringify(action.name)}}); const schema = JSON.parse(described.content[0].text); text(await tools.mcp__swarm__tool_call({tool_name:schema.name,schema_hash:schema.schema_hash,arguments:${JSON.stringify(action.args)}}));` };
    }
    let next;
    if (action.wrapped && !describing) { describing = true; next = { name: 'tool_describe', args: { tool_name: action.name } }; }
    else {
      if (action.wrapped) {
        const description = outputs(p, body).findLast((o: any) => o.name === action.name && o.schema_hash);
        assert.ok(description, `Missing schema for ${action.name}: ${JSON.stringify(modelOutputs(p, body))}`);
        describing = false;
        next = { name: 'tool_call', args: { tool_name: action.name, schema_hash: description.schema_hash, arguments: action.args } };
      } else next = action;
      actions.shift();
    }
    return p === 'claude' ? { ...next, name: `mcp__swarm__${next.name}` } : usesCodeMode(body) ? codeModeAction(next) : next;
  });
  // Leave the Codex model unset to exercise hosted default code mode too.
  process.env[provider === 'codex' ? 'SWARM_CLI_CODEX_PATH' : 'SWARM_CLI_CLAUDE_PATH'] = fixture.install(provider, { codexModel: null });
  const events: any[] = []; const unsubscribe = hub.subscribe(userId, event => events.push(event));
  t.after(async () => { await settleAgentJobs(); unsubscribe(); await fixture.close(); assert.deepEqual(fixture.errors, []); });
  const request = async (url: string, body?: any) => {
    const response = await app.request(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `swarm_session=${userId}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`); return response.json() as Promise<any>;
  };
  const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'My fixture color is green. Create a reusable skill to verify sources, a task, a local report file and a yearly routine. Read the connected app.' });
  const evidence = [{ botId: bot.id, generation: source.generation, seq: source.seq }];
  return { userId, bot, evidence, events, fixture, request,
    skill: (name: string) => ({ expected_revision: 0, name, description: 'Verify report sources', body: '1. Gather sources.\n2. Verify each source.', reason: 'The user asked to save this procedure.', evidence }),
    chat: async (plan: Action[]) => {
      actions = [...plan]; describing = false;
      await request(`/bots/${bot.id}/messages`, { text: 'Perform the requested internal fixture actions and save the skill changes now.' });
      await runInBotQueue(bot.id, async () => {});
      assert.equal(actions.length, 0, `Unexecuted actions: ${actions.map(a => a.name)}`);
      assert.equal(listRows(bot.id).filter((r: any) => r.body.card === 'approval').length, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM approvals WHERE bot_id=?').get(bot.id) as any).n, 0);
    },
  };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`R12 ${provider} hosted official CLI internal-action matrix persists memory, task, skill, file and routine without approval`, { timeout: 180000 }, async t => {
    const a = await account(t, provider), before = appExecutions.length;
    const actions = [
      { name: 'remember', args: { text: 'My fixture color is green.', evidence: a.evidence }, wrapped: true },
      { name: 'create_task', args: { title: 'Parity task' }, wrapped: true },
      { name: 'manage_skill', args: { ...a.skill('managed-skill'), action: 'create' }, wrapped: true },
      { name: 'save_file', args: { filename: 'parity-report.md', content: '# Local report\nVerified fixture sources.' }, wrapped: true },
      { name: 'create_routine', args: { name: 'Parity routine', prompt: 'Check local sources.', schedule: '0 9 1 1 *', timezone: 'Etc/UTC' }, wrapped: true },
      { name: 'list_app_connections', args: {}, wrapped: true },
      { name: 'SWARM_APPS_EXECUTE', args: appArgs, wrapped: true },
      // Core tool chosen directly, as well as through Claude's deferred wrapper.
      { name: 'propose_skill', args: a.skill('proposed-direct') },
      { name: 'propose_skill', args: a.skill('proposed-wrapped'), wrapped: true },
    ];
    // Knowledge writes invalidate the loaded prompt. Each independent user
    // request gets a fresh turn; read/update pairs below retain a shared job.
    for (const action of actions) await a.chat([action]);
    const settings = await a.request(`/bots/${a.bot.id}/settings`);
    assert.deepEqual(settings.skills.map((s: any) => s.name).sort(), ['managed-skill', 'proposed-direct', 'proposed-wrapped']);
    assert.ok(settings.skills.every((s: any) => s.revision === 1 && s.lifecycle === 'active'));
    assert.ok(settings.memories.some((m: any) => m.text === 'My fixture color is green.'));
    assert.ok((await a.request(`/bots/${a.bot.id}/tasks`)).tasks.some((task: any) => task.title === 'Parity task'));
    assert.ok(settings.routines.some((r: any) => r.name === 'Parity routine'));
    const artifact = (await a.request(`/deliverables/bots/${a.bot.id}`)).artifacts.find((file: any) => file.filename === 'parity-report.md');
    assert.ok(artifact, 'Files contains the saved report');
    assert.equal(readArtifact(a.userId, artifact.id).content.toString(), '# Local report\nVerified fixture sources.');
    assert.equal(listSkillProposals(a.userId, a.bot.id).length, 0);
    assert.equal(appExecutions.length, before + 1, 'attested app read executed exactly once');
    const rows = listRows(a.bot.id).filter((r: any) => r.kind === 'tool-call');
    for (const name of ['remember', 'create_task', 'manage_skill', 'save_file', 'create_routine', 'list_app_connections', 'SWARM_APPS_EXECUTE', 'propose_skill']) {
      assert.ok(rows.some((r: any) => r.body.name === name && r.body.status === 'done'), `${name}: ${JSON.stringify(rows.map((r: any) => r.body))}`);
    }
    assert.ok(a.fixture.args(provider).length > 0, 'official binary ran');
    const jobs = db.prepare('SELECT id,trigger FROM agent_jobs WHERE bot_id=?').all(a.bot.id) as any[];
    assert.ok(jobs.some(j => JSON.parse(j.trigger).type === 'user'));
    for (const j of jobs.filter(j => JSON.parse(j.trigger).type === 'user')) assert.equal(toolManagement({ userId: a.userId, botId: a.bot.id, jobId: j.id, depth: 8 }).unattended, false, 'wrapper depth cannot reclassify a user job');
  });

  test(`R12 ${provider} hosted official CLI skill updates activate and explicit skillApproval stages both tools`, { timeout: 180000 }, async t => {
    const a = await account(t, provider);
    await a.chat([{ name: 'propose_skill', args: a.skill('editable-skill'), wrapped: true }]);
    let skill = listSkills(a.userId, a.bot.id)[0]; assert.ok(skill);
    skill = updateSkill(a.userId, skill.id, { pinned: true, managed: false, resources: { 'references/source.md': 'Owner reference' } }, skill.revision);
    skill = setSkillScope(a.userId, skill.id, { expectedRevision: skill.revision, scope: 'account' });
    await a.chat([
      { name: 'read_skill', args: { skill_id: skill.id }, wrapped: true },
      { name: 'propose_skill', args: { ...a.skill(skill.name), skill_id: skill.id, expected_revision: skill.revision, body: '1. Verify original sources.\n2. Cite each source.' }, wrapped: true },
    ]);
    const updated = listSkills(a.userId, a.bot.id)[0];
    assert.equal(updated.revision, skill.revision + 1); assert.match(updated.body, /Cite each source/);
    assert.equal(updated.scope, 'account'); assert.equal(updated.pinned, true); assert.equal(updated.managed, false); assert.deepEqual(updated.resources, skill.resources);
    assert.equal(listSkillProposals(a.userId, a.bot.id).length, 0);
    patchLearningSettings(a.userId, { expectedRevision: learningSettings(a.userId).revision, settings: { skillApproval: true } });
    await a.chat([
      { name: 'propose_skill', args: a.skill('review-proposed'), wrapped: true },
      { name: 'manage_skill', args: { ...a.skill('review-managed'), action: 'create' }, wrapped: true },
      { name: 'read_skill', args: { skill_id: updated.id } },
      { name: 'propose_skill', args: { ...a.skill(updated.name), skill_id: updated.id, expected_revision: updated.revision, body: 'Pending change' } },
    ]);
    assert.equal(listSkills(a.userId, a.bot.id).length, 1);
    assert.equal(listSkills(a.userId, a.bot.id)[0].body, updated.body);
    const proposals = listSkillProposals(a.userId, a.bot.id);
    assert.equal(proposals.length, 3); assert.ok(proposals.every(p => p.status === 'pending'));
  });

  test(`R12 ${provider} background review and missing-job depth preserve review; attended writes retain guards`, async t => {
    const a = await account(t, provider);
    const userJob = acceptJob(a.bot.id, { type: 'user', text: 'Save a skill' });
    const base = { userId: a.userId, botId: a.bot.id, depth: 0, jobId: userJob.id, enqueueBotMessage() {} };
    for (const name of ['propose_skill', 'manage_skill']) {
      const args = { ...a.skill(`background-${name}`), ...(name === 'manage_skill' ? { action: 'create' } : {}) };
      const result = await withManagement({ ...base, unattended: true, actor: 'background_review', reads: new Map() }, () => toolMap.get(name)!.impl(args, base));
      assert.equal(result.isError, undefined, String(result.output)); assert.equal(JSON.parse(String(result.output)).activated, false);
    }
    const result = await toolMap.get('propose_skill')!.impl(a.skill('nested-no-job'), { ...base, jobId: undefined, depth: 1 });
    assert.equal(JSON.parse(String(result.output)).activated, false);
    assert.equal(listSkills(a.userId, a.bot.id).length, 0);
    assert.equal(listSkillProposals(a.userId, a.bot.id).filter(p => p.status === 'pending').length, 3);
    const tool = toolMap.get('propose_skill')!;
    const invalid = await tool.impl({ ...a.skill('invalid-evidence'), evidence: [] }, base);
    assert.equal(invalid.isError, true);
    const created = JSON.parse(String((await tool.impl(a.skill('guarded'), base)).output)).skill;
    assert.ok(created);
    const unread = await tool.impl({ ...a.skill('guarded'), skill_id: created.id, expected_revision: 1, body: 'Unread update' }, base);
    assert.equal(unread.isError, true); assert.match(String(unread.output), /Read the current target/);
    const locked = updateSkill(a.userId, created.id, { locked: true }, 1);
    await toolMap.get('read_skill')!.impl({ skill_id: locked.id }, base);
    const refused = await tool.impl({ ...a.skill('guarded'), skill_id: locked.id, expected_revision: locked.revision }, base);
    assert.equal(refused.isError, true); assert.match(String(refused.output), /locked/);
    // Exercise the production detached reviewer as well as inherited context.
    patchLearningSettings(a.userId, { expectedRevision: learningSettings(a.userId).revision, settings: { automaticReview: true, memoryTurnInterval: 1, skillIterationInterval: 1 } });
    assert.equal(beginJob(userJob.id), true); finishJob(userJob.id, true);
    const reviewParent = acceptJob(a.bot.id, { type: 'user', text: 'Verify the procedure.' });
    assert.equal(beginJob(reviewParent.id), true); finishJob(reviewParent.id, true);
    const review = onLearningTurn({ userId: a.userId, botId: a.bot.id, jobId: reviewParent.id, triggerType: 'user', depth: 0, generation: a.evidence[0].generation, model: `${provider}/default`, provider: `${provider}-cli`, finalText: 'Verified.', iterations: 1, status: 'completed', messagesSnapshot: [{ role: 'user', content: 'Save the verified procedure.' }], contextWindow: 100000 });
    assert.ok(review);
    assert.equal(review.reviewSkills, true);
    let step = 0;
    configureLearningModelExecutor(async () => {
      const name = ['propose_skill', 'manage_skill'][step++];
      return { output: name ? [{ type: 'function_call', call_id: `review-${step}`, name, arguments: JSON.stringify({ ...a.skill(`review-${name}`), ...(name === 'manage_skill' ? { action: 'create' } : {}) }) }] : [], output_text: name ? '' : 'Review complete.' };
    });
    try { assert.equal((await runLearningReview(review.id))?.status, 'completed'); }
    finally { configureLearningModelExecutor(); }
    assert.equal(listSkills(a.userId, a.bot.id).length, 1);
    assert.equal(listSkillProposals(a.userId, a.bot.id).filter(p => p.status === 'pending').length, 5);
    assert.equal((db.prepare('SELECT count(*) n FROM approvals WHERE bot_id=?').get(a.bot.id) as any).n, 0);
    selectCli(a.userId, null);
    const apiProposal = await tool.impl(a.skill('api-unchanged'), base);
    assert.equal(JSON.parse(String(apiProposal.output)).activated, false);
  });
}
