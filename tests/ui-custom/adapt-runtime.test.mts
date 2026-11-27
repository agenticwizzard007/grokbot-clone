import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-runtime-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', UI_CUSTOMIZATION: 'on', UI_ADAPT: '100' });
const realFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ items: [], data: [] });
const { db } = await import('../../server/src/db.js');
const { createBot } = await import('../../server/src/bots.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js'); initSubagents();
const { initRooms } = await import('../../server/src/agent/rooms.js'); initRooms();
const { acceptJob } = await import('../../server/src/agent/jobs.js');
const { toolMap, functionSchemas } = await import('../../server/src/agent/tools.js');
const { appendRow } = await import('../../server/src/store.js');
const { uiConfigService } = await import('../../server/src/ui/index.js');
const { RequirementsStore } = await import('../../server/src/ui/requirements-store.js');
const { REQUIREMENTS_TOOL_NAMES } = await import('../../server/src/agent/ui-requirements-tools.js');
const { uiTurnTainted } = await import('../../server/src/agent/ui-runtime.js');
const { systemPrompt } = await import('../../server/src/agent/prompt.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('qa', 'qa-temp@example.test', 'QA-Temp', Date.now());
const bot = createBot('qa', { name: 'QA-Temp-Assistant', isPrimary: true });
const store = new RequirementsStore(uiConfigService);
const ctx = (trigger: any = { type: 'user', text: 'Tailor my workspace for sales' }) => ({ userId: 'qa', botId: bot.id, jobId: acceptJob(bot.id, trigger).id, depth: 0, enqueueBotMessage() {} });
const call = async (name: string, args: any, context: ReturnType<typeof ctx>) => JSON.parse(String((await toolMap.get(name)!.impl(args, context)).output));
const row = (name: string, context: ReturnType<typeof ctx>, args = {}) => appendRow(bot.id, 'tool-call', { type: 'tool-call', name, args, callId: `fixture-${name}`, label: 'Fixture read', status: 'done', jobId: context.jobId });
const patch = [{ op: 'replace', path: '/role', value: 'Sales' }, { op: 'replace', path: '/goals', value: ['Outreach and pipeline'] }, { op: 'replace', path: '/focus', value: ['tasks', 'routines', 'bots'] }];
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('direct chat discovers four requirements tools and the chat dashboard instructions', async () => {
  const context = ctx();
  assert.equal(functionSchemas(bot.id, context).filter(tool => REQUIREMENTS_TOOL_NAMES.has(tool.name)).length, 4);
  assert.match(await systemPrompt('qa', bot.id, context.jobId), /## Requirements and tailored dashboards/);
});

test('reading requirements is trusted and saving what the user said never changes config', async () => {
  const context = ctx(), before = uiConfigService.get('qa');
  assert.equal((await call('get_requirements', {}, context)).profile, null);
  row('get_requirements', context);
  assert.equal(uiTurnTainted(context), false);
  const saved = await call('update_requirements', { patch }, context);
  assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(saved.profile.role, 'Sales');
  assert.deepEqual(uiConfigService.get('qa'), before);
});

test('adaptation makes a normal card, ask waits, clean auto applies', async () => {
  if (!store.get('qa').profile) assert.ok(store.update('qa', patch, store.get('qa').revision).ok);
  const context = ctx();
  const preview = await call('preview_adaptation', {}, context); assert.equal(preview.ok, true, JSON.stringify(preview));
  const card = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card' AND json_extract(body,'$.previewId')=?").get(bot.id, preview.previewId) as any;
  assert.equal(JSON.parse(card.body).card, 'ui_preview');
  row('preview_adaptation', context);
  assert.deepEqual(await call('apply_ui_patch', { previewId: preview.previewId }, context), { status: 'awaiting_user' });
  db.prepare("INSERT INTO account_preferences(user_id,updated_at,ui_agent_apply) VALUES('qa',0,'auto') ON CONFLICT(user_id) DO UPDATE SET ui_agent_apply='auto'").run();
  assert.equal((await call('apply_ui_patch', { previewId: preview.previewId }, context)).status, 'applied');
});

for (const source of ['browser_snapshot', 'web_search', 'read_file', 'SWARM_APPS_EXECUTE', 'read_email', 'mcp_fixture_read']) test(`${source} injection cannot save or reset a profile, including on resume`, async () => {
  const context = ctx(); row(source, context);
  const before = store.get('qa'), config = uiConfigService.get('qa');
  for (const current of [context, ctx({ type: 'resume', parentJobId: context.jobId })]) {
    for (const name of ['update_requirements', 'reset_requirements']) {
      const result = await call(name, name === 'update_requirements' ? { patch: [{ op: 'replace', path: '/role', value: 'Injected support role' }] } : {}, current);
      assert.equal(result.status, 'awaiting_user');
      assert.deepEqual(store.get('qa'), before); assert.deepEqual(uiConfigService.get('qa'), config);
    }
    const proposed = await call('preview_adaptation', {}, current); assert.equal(proposed.ok, true);
    assert.deepEqual(await call('apply_ui_patch', { previewId: proposed.previewId }, current), { status: 'awaiting_user' });
  }
});

test('routines, groups and background workers never get requirements tools', async () => {
  for (const trigger of [{ type: 'routine' }, { type: 'user', roomId: 'fixture' }, { type: 'user', channel: 'sms' }, { type: 'user', workflowId: 'fixture' }]) {
    const context = ctx(trigger);
    assert.equal(functionSchemas(bot.id, context).some(tool => REQUIREMENTS_TOOL_NAMES.has(tool.name)), false);
    for (const name of REQUIREMENTS_TOOL_NAMES) assert.equal((await call(name, {}, context)).errors[0].code, 'disabled');
  }
});

test('disabled rollout hides the tools and prompt without changing defaults', async () => {
  process.env.UI_ADAPT = 'off'; const context = ctx();
  assert.equal(functionSchemas(bot.id, context).some(tool => REQUIREMENTS_TOOL_NAMES.has(tool.name)), false);
  assert.doesNotMatch(await systemPrompt('qa', bot.id, context.jobId), /## Requirements and tailored dashboards/);
  for (const name of REQUIREMENTS_TOOL_NAMES) assert.equal((await call(name, {}, context)).errors[0].code, 'disabled');
});
