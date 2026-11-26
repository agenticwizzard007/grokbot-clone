import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, mock } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-approval-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', DIRECT_API_KEY: 'fixture', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', INKBOX_TUNNEL: '0', LLM_PROVIDER: 'direct' });
const { db, appArgs, appExecutions, planAction, offeredTools } = await import('./fixtures/api-approval-backends.mjs');
const { createBot } = await import('../server/src/bots.js');
const { toolMap, functionSchemas, executionPolicyFor, policyFor } = await import('../server/src/agent/tools.js');
const { accountPreferences, saveAccountPreferences } = await import('../server/src/settings.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { withUsage } = await import('../server/src/usage.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { serverTools } = await import('../server/src/lib/llm.js');
const { appendRow, listRows } = await import('../server/src/store.js');
const { enqueue, settleAgentJobs, resolveApproval } = await import('../server/src/agent/loop.js');
const { toolSchemaHash } = await import('../server/src/agent/tool-catalog.js');
const { createRoom } = await import('../server/src/agent/rooms.js');
const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
const { Hono } = await import('hono');
const { requireUser } = await import('../server/src/lib/auth.js');
const { voiceControlTools } = await import('../server/src/voice-controls.js');
const { asksBeforeEveryAction } = await import('../server/src/agent/approval-level.js');
const { voiceApi, VOICE_TOOLS } = await import('../server/src/voice.js');
const app = new Hono(); app.use('*', requireUser); app.route('/voice', voiceApi);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'fixture@example.test', 'Fixture', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('fixture', 'owner', Date.now(), Date.now() + 3600000);
const bot = createBot('owner', { name: 'Approval fixture', isPrimary: true });
const setLevel = (apiApprovalLevel: 'standard' | 'every_action') => saveAccountPreferences('owner', { apiApprovalLevel });
const save = (key: string) => db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run('owner', key);
const pol = (name: string, args: any = {}) => executionPolicyFor('owner', name, args, bot.id);
const pending = (id = bot.id) => db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending' ORDER BY created_at DESC").get(id) as any;
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('R11 matrix: every native tool, app discovery, attested reads, writes and MCP isolate Standard, max and both CLI plans', async () => {
  assert.equal(accountPreferences('owner').apiApprovalLevel, 'standard');
  const server = saveMcpServer('owner', { name: 'Fixture MCP', transport: 'http', url: 'https://fixture.example/mcp', botIds: [bot.id], requireApproval: true });
  db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{ name: 'inspect', inputSchema: { type: 'object' } }]), server.id);
  const mcp = mcpToolName(server, 'inspect');
  const cases = [...toolMap.keys()].map(name => ({ name, args: name === 'deliver_artifact' ? { channel: 'library' } : {} }));
  cases.push({ name: 'SWARM_APPS_SEARCH', args: {} }, { name: 'SWARM_APPS_EXECUTE', args: appArgs }, { name: 'SWARM_APPS_EXECUTE', args: { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' } }, { name: mcp, args: {} });
  for (const { name, args } of cases) {
    db.exec('DELETE FROM policies'); selectCli('owner', null); setLevel('standard');
    const standard = await pol(name, args);
    const expected = name === 'retry_delivery' || name === mcp || (args as any).tool_slug === 'GITHUB_CREATE_ISSUE' ? 'ask' : 'allow';
    assert.equal(standard.decision, expected, `Standard ${name}`);
    for (const provider of ['claude', 'codex'] as const) { selectCli('owner', provider); setLevel('every_action'); assert.deepEqual(await pol(name, args), standard, `CLI unchanged ${provider} ${name}`); }
    selectCli('owner', null);
    const maximum = await pol(name, args); assert.equal(maximum.decision, 'ask', `max ${name}`);
    save(standard.key); assert.equal((await pol(name, args)).decision, 'ask', `Standard grant cannot bypass max ${name}`);
    save(maximum.key); assert.equal((await pol(name, args)).decision, 'allow', `max grant ${name}`);
    setLevel('standard'); setLevel('every_action'); assert.equal((await pol(name, args)).decision, 'allow', `max grant survives toggle ${name}`);
    selectCli('owner', 'codex'); assert.equal((await pol(name, args)).decision, 'allow', `CLI honors Standard grant ${name}`);
    db.prepare('DELETE FROM policies WHERE tool=?').run(standard.key); assert.deepEqual(await pol(name, args), standard, `CLI ignores max grant ${name}`);
  }
  selectCli('owner', null); db.exec('DELETE FROM policies');
});

test('R11 provider search: direct web_search and x_search are offered only in API Standard', () => {
  withUsage({ userId: 'owner', botId: bot.id }, () => {
    setLevel('standard'); assert.deepEqual(serverTools().map(t => t.type), ['web_search', 'x_search']);
    setLevel('every_action'); assert.deepEqual(serverTools(), []);
    // Local configuration only: never connect to or execute an OpenRouter request.
    setEnvOverride('OPENROUTER_API_KEY', 'local-fixture-never-sent');
    setEnvOverride('LLM_PROVIDER', 'openrouter');
    assert.deepEqual(serverTools(), []);
    setLevel('standard'); assert.deepEqual(serverTools().map(t => t.type), ['openrouter:web_search']);
    setLevel('every_action'); setEnvOverride('LLM_PROVIDER', 'direct'); setEnvOverride('OPENROUTER_API_KEY', null);
    for (const provider of ['claude', 'codex'] as const) { selectCli('owner', provider); assert.deepEqual(serverTools(), []); }
    selectCli('owner', null);
  });
});

test('R11 time zone remains one-time approval at maximum', async () => {
  setLevel('every_action'); save('update_profile:timezone');
  assert.equal((await pol('update_profile', { timezone: 'Asia/Dubai' })).decision, 'ask');
});

async function run(name: string, args: any, roomId?: string) {
  planAction(name, args);
  enqueue(bot.id, { type: 'user', text: 'Local fixture action', ...(roomId ? { roomId } : {}) });
  await settleAgentJobs();
  assert.ok(pending(), `${name} must pause with a card`);
  return pending();
}
async function decide(decision: 'allow' | 'always' | 'deny') { resolveApproval('owner', pending().id, decision); await settleAgentJobs(); }

test('R11 execution: memory, files and app reads stay undone until approved; denial never dispatches', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const memory = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'My preferred fixture color is green.' });
  for (const [name, args] of [['remember', { text: 'My preferred fixture color is green.', evidence: [{ botId: bot.id, generation: memory.generation, seq: memory.seq }] }], ['save_file', { filename: 'denied.txt', content: 'never saved' }], ['SWARM_APPS_EXECUTE', appArgs]] as const) {
    await run(name, args); await decide('deny');
    assert.equal(pending(), undefined);
  }
  assert.equal(appExecutions.length, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM output_artifacts').get() as any).n, 0);
  await run('save_file', { filename: 'allowed.txt', content: 'saved after approval' }); await decide('allow');
  assert.equal((db.prepare('SELECT count(*) n FROM output_artifacts').get() as any).n, 1);
  assert.ok(offeredTools.every(tools => !tools.some(t => ['web_search', 'x_search', 'openrouter:web_search'].includes(t.type))));
});

test('R11 execute_code and catalog wrapper each pause before their inner action and resume without repeating the outer approval', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  for (const name of ['execute_code', 'tool_call']) {
    const args = name === 'execute_code' ? { tools: ['save_file'], code: 'return tools.call("save_file", {filename:"inner.txt",content:"nested"});' } : { tool_name: 'save_file', schema_hash: toolSchemaHash(functionSchemas(bot.id).find(t => t.name === 'save_file')!), arguments: { filename: 'wrapped.txt', content: 'nested' } };
    await run(name, args); assert.equal(pending().tool, `api_max:${name}`);
    await decide('allow'); assert.equal(pending()?.tool, 'api_max:save_file');
    await decide('deny'); assert.equal(pending(), undefined);
  }
});

test('R11 group tools show an actionable approval card and group notice instead of silent denial', async () => {
  const other = createBot('owner', { name: 'Other fixture', isPrimary: true });
  const roomId = createRoom('owner', 'Fixture room', [bot.id, other.id]);
  setLevel('every_action'); await run('recall', { query: 'fixture' }, roomId);
  assert.ok(listRows(roomId).some(r => r.body.type === 'notice' && r.body.text.includes('Open this Bot')));
  await decide('deny');
});

const voicePost = (endpoint: string, body: any) => app.request(`/voice/${endpoint}`, { method: 'POST', headers: { cookie: 'swarm_session=fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('R11 voice tools wait for cards; approved delegation resumes once and denied reads do not run', async () => {
  setLevel('every_action');
  const session = await voicePost('session', { botId: bot.id }); assert.equal(session.status, 200);
  const { callId } = await session.json() as any;
  const request = { botId: bot.id, callId, name: 'send_task', args: { request: 'Fixture delegated work' }, toolCallId: 'voice-task-1' };
  const before = (db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n;
  const response = await voicePost('tool', request); assert.match((await response.json() as any).output, /Approval required/);
  assert.equal((db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n, before);
  resolveApproval('owner', pending().id, 'allow'); await new Promise(r => setTimeout(r, 50)); await settleAgentJobs();
  const afterCount = (db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n; assert.ok(afterCount > before);
  const repeat = await voicePost('tool', request); assert.match((await repeat.json() as any).output, /Queued/);
  assert.equal((db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n, afterCount);
  await voicePost('tool', { ...request, name: 'get_platform_state', args: {}, toolCallId: 'voice-read-1' });
  resolveApproval('owner', pending().id, 'deny'); await new Promise(r => setTimeout(r, 20));
  const denied = await voicePost('tool', { ...request, name: 'get_platform_state', args: {}, toolCallId: 'voice-read-1' });
  assert.match((await denied.json() as any).output, /declined/);
  await voicePost('end', { botId: bot.id, callId });
});

test('R11 explicit maximum Always allow persists separately and never grants CLI permission', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  await run('SWARM_APPS_EXECUTE', { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' });
  const approval = pending(); await decide('always');
  assert.equal((await pol('SWARM_APPS_EXECUTE', { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' })).decision, 'allow');
  assert.ok(db.prepare('SELECT 1 FROM policies WHERE tool=?').get(approval.tool));
  setLevel('standard'); assert.equal((await pol('SWARM_APPS_EXECUTE', { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' })).decision, 'ask');
  selectCli('owner', 'claude'); assert.equal((await pol('SWARM_APPS_EXECUTE', { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' })).decision, 'ask');
  selectCli('owner', null); setLevel('every_action'); assert.equal((await pol('SWARM_APPS_EXECUTE', { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' })).decision, 'allow');
});

test('R11 background memory and skill review tools also wait for explicit approval', async () => {
  const learning = await import('../server/src/agent/learning.js');
  const reviewBot = createBot('owner', { name: 'Review fixture', isPrimary: true });
  appendRow(reviewBot.id, 'message', { type: 'message', role: 'user', text: 'I prefer short summaries.' });
  let responses = 0;
  learning.configureLearningModelExecutor(async () => ++responses === 1
    ? { output: [{ type: 'function_call', name: 'recall', call_id: 'review-recall', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }
    : { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Review finished.' }] }], output_text: 'Review finished.', usage: { input_tokens: 1, output_tokens: 1 } });
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const review = withUsage({ userId: 'owner', botId: reviewBot.id }, () => learning.refineLearning('owner', reviewBot.id));
  const running = learning.runLearningReview(review.id);
  try {
    for (let n = 0; n < 200 && !pending(reviewBot.id); n++) await new Promise(r => setTimeout(r, 20));
    assert.equal(pending(reviewBot.id)?.tool, 'api_max:recall'); assert.equal(responses, 1);
    const jobs = (db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n;
    resolveApproval('owner', pending(reviewBot.id).id, 'allow');
    assert.equal((await running)?.status, 'completed');
    assert.equal((db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n, jobs, 'review approval must not resume chat');
  } finally { learning.configureLearningModelExecutor(); }
});

test('R11 preferences are account-scoped, partial, validated and default to Standard', async () => {
  const { preferencesApi } = await import('../server/src/routes-preferences.js');
  const prefs = new Hono().route('/account', preferencesApi);
  const patch = (body: any) => prefs.request('/account/preferences', { method: 'PATCH', headers: { cookie: 'swarm_session=fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await patch({ apiApprovalLevel: 'every_action' }); assert.equal(response.status, 200);
  assert.equal((await response.json() as any).apiApprovalLevel, 'every_action');
  await patch({ askBeforeComputer: true }); assert.equal(accountPreferences('owner').apiApprovalLevel, 'every_action');
  assert.equal((await patch({ apiApprovalLevel: 'anything' })).status, 400);
  assert.equal((await patch({})).status, 400);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('other', 'other@example.test', 'Other', Date.now());
  assert.deepEqual(accountPreferences('other'), { askBeforeComputer: false, apiApprovalLevel: 'standard' });
});


test('R11 all voice coordinator tools require maximum grants while Standard and CLI retain direct dispatch', async () => {
  const names = [...new Set([...VOICE_TOOLS, ...voiceControlTools(bot.id)].map(t => t.name))];
  for (const name of names) {
    selectCli('owner', null); setLevel('every_action'); db.exec('DELETE FROM policies');
    const policy = await pol(name); assert.equal(policy.decision, 'ask', name);
    save(policy.key); assert.equal((await pol(name)).decision, 'allow', name);
    setLevel('standard'); assert.equal(asksBeforeEveryAction('owner'), false);
    setLevel('every_action'); selectCli('owner', 'claude'); assert.equal(asksBeforeEveryAction('owner'), false);
    selectCli('owner', 'codex'); assert.equal(asksBeforeEveryAction('owner'), false);
  }
  selectCli('owner', null);
});


test('R11 hidden helper approvals are actionable in the parent chat and resolve the original helper call', async () => {
  const { createSubagent } = await import('../server/src/agent/subagents.js');
  const { needsYou } = await import('../server/src/routes-attention.js');
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const helper = createSubagent(bot.id, 'Inspect fixture memory', 'Fixture helper');
  planAction('recall', { query: 'fixture' });
  enqueue(helper.id, { type: 'user', text: 'Inspect fixture memory' }); await settleAgentJobs();
  const approval = pending(helper.id); assert.ok(approval);
  const mirror = listRows(bot.id).find(r => r.body.type === 'card' && r.body.card === 'approval' && r.body.approvalId === approval.id)!;
  assert.ok(mirror, 'visible parent contains the card');
  assert.deepEqual(needsYou('owner').filter(i => i.id === `approval:${approval.id}`).map(i => [i.botId, i.seq]), [[bot.id, mirror.seq]]);
  resolveApproval('owner', approval.id, 'deny'); await settleAgentJobs();
  assert.equal((listRows(bot.id).find(r => r.seq === mirror.seq)!.body as any).status, 'denied');
  assert.equal(pending(helper.id), undefined);
});
