import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-agent-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', UI_CUSTOMIZATION: 'on' });
const realFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ items: [], data: [] });
const { db } = await import('../../server/src/db.js');
const { createBot } = await import('../../server/src/bots.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
initSubagents();
const { initRooms } = await import('../../server/src/agent/rooms.js');
initRooms();
const { acceptJob } = await import('../../server/src/agent/jobs.js');
const { toolMap, functionSchemas } = await import('../../server/src/agent/tools.js');
const { uiConfigService } = await import('../../server/src/ui/index.js');
const { uiChatJobs, uiToolsOffered, uiTurnTainted, syncUiCards } = await import('../../server/src/agent/ui-runtime.js');
const { UI_TOOL_NAMES } = await import('../../server/src/agent/ui-tools.js');
const { appendRow, appendHistory } = await import('../../server/src/store.js');
const { withRun } = await import('../../server/src/agent/run-scope.js');
const { systemPrompt } = await import('../../server/src/agent/prompt.js');
const { selectCli } = await import('../../server/src/cli/store.js');
for (const userId of ['QA-Temp-a', 'QA-Temp-b']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, userId, Date.now());
const bot = createBot('QA-Temp-a', { name: 'Fixture assistant', isPrimary: true });
const job = (trigger: unknown) => acceptJob(bot.id, trigger).id;
const ctx = (trigger: unknown = { type: 'user', text: 'Change appearance' }) => ({ userId: 'QA-Temp-a', botId: bot.id, jobId: job(trigger), depth: 0, enqueueBotMessage() {} });
const call = async (name: string, args: unknown, context = ctx()) => JSON.parse(String((await toolMap.get(name)!.impl(args, context)).output));
const preview = async (context = ctx()) => call('preview_ui_patch', { intent: 'Dark mode', patch: [{ op: 'replace', path: '/theme/mode', value: 'dark' }] }, context);
const card = (previewId: string) => JSON.parse((db.prepare("SELECT body FROM rows WHERE bot_id=? AND json_extract(body,'$.previewId')=?").get(bot.id, previewId) as any).body);
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('direct personal web chats offer all UI tools, ambient run and explicit context agree', async () => {
  const context = ctx();
  assert.equal(functionSchemas(bot.id, context).filter(t => UI_TOOL_NAMES.has(t.name)).length, 21);
  withRun({ id: context.jobId, botId: bot.id, closed: false, signal: new AbortController().signal }, () => assert.equal(functionSchemas(bot.id).filter(t => UI_TOOL_NAMES.has(t.name)).length, 21));
  assert.equal(functionSchemas(bot.id).some(t => UI_TOOL_NAMES.has(t.name)), false);
  assert.equal((await call('get_ui_config', {}, context)).revision, 0);
});
for (const [label, trigger] of Object.entries({ routine: { type: 'routine' }, trigger: { type: 'trigger' }, email: { type: 'email' }, messaging: { type: 'user', channel: 'sms' }, imessage: { type: 'user', channel: 'imessage' }, whatsapp: { type: 'user', channel: 'whatsapp' }, worker: { type: 'user', workflowId: 'fixture' }, subagent: { type: 'bot', depth: 1 }, background: { type: 'learning-review' }, group: { type: 'user', roomId: 'fixture' }, goal: { type: 'user', goalId: 'fixture' }, internal: { type: 'user', audience: 'internal' } })) test(`${label}: tools absent and forged dispatch refused`, async () => {
  const context = ctx(trigger);
  assert.equal(functionSchemas(bot.id, context).some(t => UI_TOOL_NAMES.has(t.name)), false);
  for (const name of UI_TOOL_NAMES) assert.equal((await call(name, {}, context)).errors[0].code, 'unavailable_context');
});
test('team and hidden helper Bots never get appearance tools', () => {
  const context = ctx();
  for (const sql of ["UPDATE bots SET mode='teammate' WHERE id=?", 'UPDATE bots SET hidden=1 WHERE id=?', 'UPDATE bots SET parent_bot_id=id WHERE id=?']) {
    db.prepare(sql).run(bot.id);
    assert.equal(uiToolsOffered(context), false);
    db.prepare("UPDATE bots SET mode='personal',hidden=0,parent_bot_id=NULL WHERE id=?").run(bot.id);
  }
});
test('resume follows only same-user same-Bot direct-chat ancestry', () => {
  const direct = ctx(), resumed = ctx({ type: 'resume', parentJobId: direct.jobId });
  assert.deepEqual(uiChatJobs(resumed), [resumed.jobId, direct.jobId]);
  assert.deepEqual(uiChatJobs(ctx({ type: 'resume', parentJobId: job({ type: 'routine' }) })), []);
  assert.deepEqual(uiChatJobs({ ...direct, userId: 'QA-Temp-b' }), []);
  assert.deepEqual(uiChatJobs(ctx({ type: 'resume', parentJobId: 'missing' })), []);
});
test('resumed turns retain the repair limit for malformed builder arguments', async () => {
  const direct = ctx();
  for (let i = 0; i < 4; i++) appendRow(bot.id, 'tool-call', {
    type: 'tool-call', name: 'preview_ui_patch', callId: `fixture-repair-${i}`, args: {}, label: 'Preview', status: 'error', jobId: direct.jobId,
  });
  const resumed = ctx({ type: 'resume', parentJobId: direct.jobId });
  const result = await toolMap.get('set_accent')!.impl({}, resumed);
  assert.equal(JSON.parse(String(result.output)).errors[0].code, 'repair_limit');
  assert.equal(result.endTurn, true);
  assert.ok((await preview(ctx())).previewId);
});
for (const name of ['browser_snapshot', 'SWARM_APPS_EXECUTE', 'read_file', 'read_email', 'web_search', 'shell', 'mcp_fixture_read', 'session_search']) test(`${name} taints auto Apply and its resumed turn`, async () => {
  const context = ctx();
  db.prepare("INSERT INTO account_preferences(user_id,ui_agent_apply,updated_at) VALUES(?,'auto',0) ON CONFLICT(user_id) DO UPDATE SET ui_agent_apply='auto'").run(context.userId);
  const p = await preview(context);
  appendRow(bot.id, 'tool-call', { type: 'tool-call', name, callId: `fixture-${name}`, args: {}, label: 'Read fixture', status: 'done', jobId: context.jobId });
  assert.equal(uiTurnTainted(context), true);
  assert.deepEqual(await call('apply_ui_patch', { previewId: p.previewId }, context), { status: 'awaiting_user' });
  const resumed = ctx({ type: 'resume', parentJobId: context.jobId });
  assert.equal(uiTurnTainted(resumed), true);
});
test('provider-managed search taints before compaction and a fresh user turn resets it', () => {
  const context = ctx();
  appendHistory(bot.id, [{ role: 'user', content: 'Read fixture' }, { type: 'web_search_call', id: 'fixture-search', status: 'completed' }]);
  assert.equal(uiTurnTainted(context), true);
  db.prepare('DELETE FROM llm_items WHERE bot_id=?').run(bot.id);
  assert.equal(uiTurnTainted(context), true);
  assert.equal(uiTurnTainted(ctx()), false);
});
test('clean CLI turns use the same auto-apply gate as API turns', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const context = ctx(); selectCli(context.userId, provider);
    assert.equal(uiTurnTainted(context), false);
    const p = await preview(context);
    assert.equal((await call('apply_ui_patch', { previewId: p.previewId }, context)).status, 'applied');
    selectCli(context.userId, null);
  }
});
test('expired preview cannot apply and card status follows expiry', async () => {
  const context = ctx(), p = await preview(context);
  db.prepare('UPDATE ui_previews SET expires_at=? WHERE user_id=? AND id=?').run(Date.now() - 1, context.userId, p.previewId);
  assert.equal((await call('apply_ui_patch', { previewId: p.previewId }, context)).errors[0].code, 'preview_expired');
  syncUiCards(context.userId); assert.equal(card(p.previewId).status, 'expired');
});
test('REST-style service apply, discard and supersede refresh conversation cards', async () => {
  const context = ctx(); const p = await preview(context);
  assert.equal(uiConfigService.applyPreview(context.userId, p.previewId, 'user').ok, true);
  syncUiCards(context.userId); assert.equal(card(p.previewId).status, 'applied');
  const discarded = await preview(context); uiConfigService.discardPreview(context.userId, discarded.previewId);
  syncUiCards(context.userId); assert.equal(card(discarded.previewId).status, 'discarded');
  const old = await preview(context); await preview(context);
  syncUiCards(context.userId); assert.equal(card(old.previewId).status, 'superseded');
});
test('built-in skill is discoverable and readable only when UI tools are offered', async () => {
  const context = ctx();
  const listed = await call('list_skills', {}, context); assert.ok(listed.skills.some((s: any) => s.id === 'appearance'));
  const read = await call('read_skill', { skill_id: 'appearance' }, context); assert.match(read.skill.body, /add up to 12/);
  const absent = await call('list_skills', {}, ctx({ type: 'routine' })); assert.equal(absent.skills.some((s: any) => s.id === 'appearance'), false);
  assert.match(await systemPrompt(context.userId, bot.id, context.jobId), /## Appearance and dashboards/);
  assert.doesNotMatch(await systemPrompt(context.userId, bot.id, job({ type: 'routine' })), /## Appearance and dashboards/);
});
test('history is scoped, save preset works, and preset discovery includes the new id', async () => {
  const context = ctx();
  const saved = await call('save_preset', { name: 'Fixture preset' }, context);
  assert.ok(saved.presetId, JSON.stringify(saved));
  const listed = await call('list_ui_options', { kind: 'presets' }, context);
  assert.ok(listed.options.some((p: any) => p.id === saved.presetId));
  const applied = await call('apply_preset', { presetId: saved.presetId }, context);
  assert.ok(applied.previewId, JSON.stringify(applied));
  assert.ok((await call('get_ui_config', {}, context)).history.length <= 5);
});
test('feature flag disables the tools and direct dispatch', async () => {
  process.env.UI_CUSTOMIZATION = 'off';
  const context = ctx(); assert.equal(uiToolsOffered(context), false);
  assert.equal((await call('get_ui_config', {}, context)).errors[0].code, 'disabled');
  process.env.UI_CUSTOMIZATION = 'on';
});
