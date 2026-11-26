import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, mock } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-approval-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', DIRECT_API_KEY: 'fixture', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', INKBOX_TUNNEL: '0', LLM_PROVIDER: 'direct' });
const { db, appArgs, appExecutions, planAction, planDiscoveredAction, mockModelClient, offeredTools } = await import('./fixtures/api-approval-backends.mjs');
const { createBot } = await import('../server/src/bots.js');
const { toolMap, functionSchemas, executionPolicyFor, policyFor } = await import('../server/src/agent/tools.js');
const { accountPreferences, saveAccountPreferences } = await import('../server/src/settings.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { withUsage } = await import('../server/src/usage.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { serverTools } = await import('../server/src/lib/llm.js');
const { appendRow, listRows, updateRow } = await import('../server/src/store.js');
const { approvalBinding } = await import('../server/src/security/approval.js');
const { beginTool } = await import('../server/src/agent/jobs.js');
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
  const trusted = saveMcpServer('owner', { name: 'Trusted fixture MCP', transport: 'http', url: 'https://fixture.example/trusted', botIds: [bot.id], requireApproval: false });
  db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{ name: 'inspect', inputSchema: { type: 'object' } }]), trusted.id);
  const trustedMcp = mcpToolName(trusted, 'inspect');
  const cases = [...toolMap.keys()].map(name => ({ name, args: name === 'deliver_artifact' ? { channel: 'library' } : {} }));
  cases.push({ name: 'SWARM_APPS_SEARCH', args: {} }, { name: 'SWARM_APPS_EXECUTE', args: appArgs }, { name: 'SWARM_APPS_EXECUTE', args: { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' } }, { name: mcp, args: {} }, { name: trustedMcp, args: {} });
  for (const { name, args } of cases) {
    db.exec('DELETE FROM policies'); selectCli('owner', null); setLevel('standard');
    const standard = await pol(name, args);
    const expected = name === 'retry_delivery' || name === mcp || (args as any).tool_slug === 'GITHUB_CREATE_ISSUE' ? 'ask' : 'allow';
    assert.equal(standard.decision, expected, `Standard ${name}`);
    for (const provider of ['claude', 'codex'] as const) { selectCli('owner', provider); setLevel('every_action'); assert.deepEqual(await pol(name, args), standard, `CLI unchanged ${provider} ${name}`); }
    selectCli('owner', null);
    if (name === 'tool_search' || name === 'tool_describe') {
      assert.equal((await pol(name, args)).decision, 'allow', `catalog-only ${name}`);
      continue;
    }
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
    for (const type of ['web_search', 'x_search', 'openrouter:web_search']) { save(type); save(`api_max:${type}`); }
    assert.deepEqual(serverTools(), [], 'neither Standard nor max grants enable unguarded provider tools');
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
  setLevel('every_action'); save('update_profile:timezone'); save('api_max:update_profile');
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

test('R11 execute_code pauses for its program and inner action without repeating the program approval', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const before = fileCount();
  await run('execute_code', { tools: ['save_file'], code: 'return tools.call("save_file", {filename:"inner.txt",content:"nested"});' });
  assert.equal(pending().tool, 'api_max:execute_code');
  await decide('allow'); assert.equal(pending()?.tool, 'api_max:save_file');
  assert.equal(fileCount(), before);
  await decide('deny'); assert.equal(pending(), undefined);
  assert.equal(fileCount(), before);
});

const fileCount = () => (db.prepare('SELECT count(*) n FROM output_artifacts').get() as any).n;
const wrapped = (name: string, args: any) => ({ tool_name: name, schema_hash: toolSchemaHash(functionSchemas(bot.id).find(t => t.name === name)!), arguments: args });
test('R16 wrapped saves and reads show one actual-action card and only dispatch after Allow', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  for (const legacyGrant of [false, true]) for (const name of ['save_file', 'recall']) {
    // Exercise fresh accounts and old wrapper grants, neither authorizes the action.
    if (legacyGrant) save('api_max:tool_call');
    const impl = mock.method(toolMap.get(name)!, 'impl');
    try {
      for (const decision of ['deny', 'allow'] as const) {
        const before = fileCount(), calls = impl.mock.callCount();
        const cards = listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length;
        const args = name === 'save_file' ? { filename: 'wrapped.txt', content: 'nested' } : { query: 'fixture' };
        const approval = await run('tool_call', wrapped(name, args));
        assert.equal(approval.tool, `api_max:${name}`);
        const card = listRows(bot.id).find(r => r.seq === approval.row_seq)!.body as any;
        assert.equal(card.tool, name); assert.match(card.title, new RegExp(name.replaceAll('_', ' ')));
        assert.deepEqual(card.args, args);
        assert.equal(impl.mock.callCount(), calls); assert.equal(fileCount(), before);
        await decide(decision);
        assert.equal(pending(), undefined);
        assert.equal(impl.mock.callCount(), calls + Number(decision === 'allow'));
        assert.equal(fileCount(), before + Number(name === 'save_file' && decision === 'allow'));
        assert.equal(listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length, cards + 1);
      }
    } finally { impl.mock.restore(); }
  }
});

test('R16 wrapped approvals retain schema checks and Always allow grants only the actual maximum action', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const args = { filename: 'schema-bound.txt', content: 'Fixture' };
  const before = fileCount();
  await run('tool_call', wrapped('save_file', args));
  const tool = toolMap.get('save_file')!, original = tool.parameters;
  try {
    tool.parameters = { ...original, description: 'Changed fixture schema' };
    await decide('allow');
    assert.equal(pending(), undefined); assert.equal(fileCount(), before);
    assert.ok(listRows(bot.id).some(r => r.body.type === 'tool-call' && r.body.summary?.includes('schema changed')));
  } finally { tool.parameters = original; }
  await run('tool_call', wrapped('save_file', args)); await decide('always');
  assert.equal(fileCount(), before + 1);
  assert.deepEqual(db.prepare('SELECT tool FROM policies').all(), [{ tool: 'api_max:save_file' }]);
  assert.equal((await pol('recall')).decision, 'ask');
  planAction('tool_call', wrapped('save_file', args)); enqueue(bot.id, { type: 'user', text: 'Repeat allowed fixture save' }); await settleAgentJobs();
  assert.equal(pending(), undefined); assert.equal(fileCount(), before + 2);
  db.exec('DELETE FROM policies');
});

test('R16 in-flight wrappers from an older server retain their inner approval and dispatch identity', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  for (const decision of ['deny', 'allow'] as const) {
    const before = fileCount(), args = { filename: 'legacy-wrapped.txt', content: 'Fixture' };
    const approval = await run('save_file', args);
    const state = JSON.parse((db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(bot.id) as any).state);
    const original = state.calls[0], outerId = `${original.call_id}:wrapper`, innerId = `${outerId}:resolved`;
    const wrapperArgs = wrapped('save_file', args);
    const outerRow = appendRow(bot.id, 'tool-call', { type: 'tool-call', callId: outerId, name: 'tool_call', args: wrapperArgs, label: 'Using selected tool', status: 'running' });
    const innerRow = listRows(bot.id).find(r => r.seq === original.rowSeq)!;
    updateRow(bot.id, innerRow.seq, { ...innerRow.body as any, callId: innerId });
    beginTool(bot.id, outerId, 'tool_call', approvalBinding('owner', bot.id, outerId, 'tool_call', wrapperArgs));
    db.prepare('UPDATE approvals SET call_id=?,binding_hash=? WHERE id=?').run(innerId, approvalBinding('owner', bot.id, innerId, 'save_file', args), approval.id);
    state.calls = [{ call_id: outerId, name: 'tool_call', arguments: JSON.stringify(wrapperArgs), rowSeq: outerRow.seq }];
    state.approvedWrappers = [outerId];
    db.prepare('UPDATE pending_turns SET state=? WHERE bot_id=?').run(JSON.stringify(state), bot.id);
    const cards = listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length;
    enqueue(bot.id, { type: 'resume' }); await settleAgentJobs();
    assert.equal(pending()?.id, approval.id); assert.equal(fileCount(), before);
    await decide(decision);
    assert.equal(pending(), undefined); assert.equal(fileCount(), before + Number(decision === 'allow'));
    assert.equal(listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length, cards);
  }
});

test('R16 old generic wrapper cards never authorize the inner action on upgrade', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  for (const decision of ['deny', 'allow', 'always'] as const) {
    const before = fileCount(), args = { filename: 'old-card.txt', content: 'Fixture' };
    const approval = await run('save_file', args);
    const state = JSON.parse((db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(bot.id) as any).state);
    const call = state.calls[0], wrapperArgs = wrapped('save_file', args);
    state.calls = [{ ...call, name: 'tool_call', arguments: JSON.stringify(wrapperArgs) }];
    const row = listRows(bot.id).find(r => r.seq === call.rowSeq)!;
    updateRow(bot.id, row.seq, { ...row.body as any, name: 'tool_call', args: wrapperArgs });
    db.prepare('UPDATE approvals SET tool=?,binding_hash=? WHERE id=?').run('api_max:tool_call', approvalBinding('owner', bot.id, call.call_id, 'tool_call', wrapperArgs), approval.id);
    db.prepare('UPDATE pending_turns SET state=? WHERE bot_id=?').run(JSON.stringify(state), bot.id);
    await decide(decision);
    assert.equal(fileCount(), before); assert.equal(dispatch(call.call_id), undefined);
    if (decision === 'deny') assert.equal(pending(), undefined);
    else {
      assert.equal(pending()?.tool, 'api_max:save_file');
      await decide('allow'); assert.equal(fileCount(), before + 1); assert.equal(pending(), undefined);
    }
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


test('R11 catalog-wrapped code retains each approval and programs still refuse unsupported wrappers', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const file = { tool_name: 'save_file', schema_hash: toolSchemaHash(functionSchemas(bot.id).find(t => t.name === 'save_file')!), arguments: { filename: 'nested-wrappers.txt', content: 'nested' } };
  await run('execute_code', { tools: ['tool_call'], code: `return tools.call("tool_call", ${JSON.stringify(file)});` });
  assert.equal(pending().tool, 'api_max:execute_code');
  await decide('allow'); assert.equal(pending(), undefined);
  assert.ok(listRows(bot.id).some(r => r.body.type === 'tool-call' && r.body.summary?.includes('Programs may use only explicitly listed')), 'unsupported nested program wrappers remain refused');
  const program = { tools: ['save_file'], code: 'return tools.call("save_file", {filename:"wrapped-code.txt",content:"nested"});' };
  await run('tool_call', { tool_name: 'execute_code', schema_hash: toolSchemaHash(functionSchemas(bot.id).find(t => t.name === 'execute_code')!), arguments: program });
  assert.equal(pending().tool, 'api_max:execute_code');
  await decide('allow'); assert.equal(pending()?.tool, 'api_max:save_file');
  await decide('deny'); assert.equal(pending(), undefined);
});

test('R11 review Always allow belongs to the mode selected when the card is resolved', async () => {
  const { approveReviewAction } = await import('../server/src/agent/review-approvals.js');
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const running = approveReviewAction({ userId: 'owner', botId: bot.id, jobId: 'fixture-review' }, 'recall', {}, new AbortController().signal, () => {});
  for (let n = 0; n < 100 && !pending(); n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(pending()?.tool, 'api_max:recall');
  setLevel('standard'); resolveApproval('owner', pending().id, 'always');
  assert.equal(await running, true);
  assert.ok(db.prepare("SELECT 1 FROM policies WHERE tool='recall'").get());
  setLevel('every_action'); assert.equal((await pol('recall')).decision, 'ask', 'a Standard decision cannot create a maximum grant');
});

test('R11 voice approvals stay independent when separate calls reuse a provider tool ID', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const actionIds: string[] = [];
  for (const decision of ['deny', 'allow'] as const) {
    const { callId } = await (await voicePost('session', { botId: bot.id })).json() as any;
    await voicePost('tool', { botId: bot.id, callId, name: 'get_platform_state', args: {}, toolCallId: 'reused-provider-id' });
    const approval = pending(); assert.ok(approval); actionIds.push(approval.call_id);
    resolveApproval('owner', approval.id, decision);
    const step = () => listRows(bot.id).find(r => r.body.type === 'tool-call' && r.body.callId === approval.call_id)?.body as any;
    for (let n = 0; n < 100 && step()?.status === 'awaiting-approval'; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(step().status, decision === 'deny' ? 'denied' : 'done');
    await voicePost('end', { botId: bot.id, callId });
  }
  assert.notEqual(actionIds[0], actionIds[1]);
  assert.deepEqual(actionIds.map(id => (listRows(bot.id).find(r => r.body.type === 'tool-call' && r.body.callId === id)?.body as any)?.status), ['denied', 'done']);
});

const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n;
const effects = () => ({ memories: count('memories'), tasks: count('tasks'), skills: count('knowledge_skill_proposals'), files: fileCount(), apps: appExecutions.length });
const dispatch = (callId: string) => db.prepare('SELECT state FROM tool_dispatches WHERE call_id=?').get(callId) as any;
test('R16 memory, task, skill, file, app discovery, app read and app write wait and deny without effects', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'My fixture summary preference is short. Create a skill to write short summaries.' });
  const evidence = [{ botId: bot.id, generation: source.generation, seq: source.seq }];
  const cases = [
    { name: 'remember', args: { text: 'My fixture summary preference is short.', evidence }, effect: 'memories' },
    { name: 'create_task', args: { title: 'Fixture task' }, effect: 'tasks' },
    { name: 'propose_skill', args: { expected_revision: 0, name: 'Fixture summaries', description: 'Write short summaries', body: 'Keep summaries short.', reason: 'Requested in chat', evidence }, effect: 'skills' },
    { name: 'save_file', args: { filename: 'matrix.txt', content: 'Fixture' }, effect: 'files' },
    { name: 'SWARM_APPS_SEARCH', args: { toolkit: 'github', query: 'peek', connectionId: 'fixture-github' } },
    { name: 'SWARM_APPS_EXECUTE', args: appArgs, effect: 'apps' },
    { name: 'SWARM_APPS_EXECUTE', args: { ...appArgs, tool_slug: 'GITHUB_CREATE_ISSUE' }, effect: 'apps' },
  ] as const;
  for (const action of cases) for (const decision of ['deny', 'allow'] as const) {
    const before = effects();
    const approval = await run(action.name, action.args);
    assert.equal(dispatch(approval.call_id), undefined, `${action.name} has not dispatched`);
    assert.deepEqual(effects(), before);
    await decide(decision);
    assert.equal(pending(), undefined);
    if (decision === 'deny') {
      assert.deepEqual(effects(), before, `${action.name} denial changes no action state`);
      assert.equal(dispatch(approval.call_id), undefined);
    } else {
      assert.equal(dispatch(approval.call_id)?.state, 'completed', `${action.name} completes after Allow`);
      if ('effect' in action) assert.deepEqual(effects(), { ...before, [action.effect]: before[action.effect] + 1 });
    }
  }
});

test('R16 ordinary and search turns never append the provider-search Settings explanation to chat', async () => {
  setLevel('every_action');
  for (const text of ['Hello', 'Search the web', 'Tell me about tasks']) {
    enqueue(bot.id, { type: 'user', text }); await settleAgentJobs();
  }
  assert.equal(listRows(bot.id).filter(r => r.body.type === 'notice' && /Provider search is unavailable/.test(r.body.text)).length, 0);
  assert.ok(offeredTools.every(tools => !tools.some(t => ['web_search', 'x_search', 'openrouter:web_search'].includes(t.type))));
});

test('R16 scheduled and unattended actions keep visible cards and wait for allow or deny', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const backgroundBot = createBot('owner', { name: 'Background fixture', isPrimary: true });
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('fixture-routine', backgroundBot.id, 'Fixture schedule', 'Save a file', '0 9 * * *', 'UTC', 1, Date.now());
  const triggers = [
    { type: 'routine', routineId: 'fixture-routine', name: 'Fixture schedule', prompt: 'Save a file' },
    { type: 'system', text: 'Save a file', audience: 'internal' },
  ] as const;
  for (const trigger of triggers) for (const decision of ['deny', 'allow'] as const) {
    const before = fileCount();
    planAction('save_file', { filename: 'background.txt', content: 'Fixture background file' });
    enqueue(backgroundBot.id, trigger); await settleAgentJobs();
    const approval = pending(backgroundBot.id); assert.equal(approval?.tool, 'api_max:save_file');
    const card = listRows(backgroundBot.id).find(r => r.seq === approval.row_seq)!.body as any;
    assert.equal(card.audience, 'user');
    assert.equal(fileCount(), before); assert.equal(dispatch(approval.call_id), undefined);
    resolveApproval('owner', approval.id, decision); await settleAgentJobs();
    assert.equal(pending(backgroundBot.id), undefined);
    assert.equal(fileCount(), before + Number(decision === 'allow'));
  }
});

test('R16 program approvals resume successive actions once and denial leaves later saves undone', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const before = fileCount();
  await run('tool_call', wrapped('execute_code', { tools: ['save_file'], code: 'tools.call("save_file", {filename:"first.txt",content:"first"}); return tools.call("save_file", {filename:"second.txt",content:"second"});' }));
  assert.equal(pending().tool, 'api_max:execute_code'); assert.equal(fileCount(), before);
  await decide('allow'); assert.equal(pending()?.tool, 'api_max:save_file'); assert.equal(fileCount(), before);
  const first = pending().call_id;
  await decide('allow'); assert.equal(pending()?.tool, 'api_max:save_file'); assert.equal(fileCount(), before + 1);
  assert.notEqual(pending().call_id, first);
  await decide('deny'); assert.equal(pending(), undefined); assert.equal(fileCount(), before + 1);
});

test('R16 learning review memory and skill mutations wait for Allow and do nothing on denial', async () => {
  const learning = await import('../server/src/agent/learning.js');
  setLevel('every_action'); db.exec('DELETE FROM policies');
  for (const name of ['remember', 'propose_skill']) for (const decision of ['deny', 'allow'] as const) {
    const reviewBot = createBot('owner', { name: 'Learning fixture', isPrimary: true });
    const source = appendRow(reviewBot.id, 'message', { type: 'message', role: 'user', text: 'My fixture report preference is short. Save a skill for short reports.' });
    const evidence = [{ botId: reviewBot.id, generation: source.generation, seq: source.seq }];
    const args = name === 'remember' ? { text: 'My fixture report preference is short.', evidence }
      : { expected_revision: 0, name: 'Fixture reports', description: 'Write short reports', body: 'Keep reports short.', reason: 'Requested in chat', evidence };
    let responses = 0;
    learning.configureLearningModelExecutor(async () => ++responses === 1
      ? { output: [{ type: 'function_call', name, call_id: 'review-mutation', arguments: JSON.stringify(args) }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { output: [], output_text: 'Review finished.', usage: { input_tokens: 1, output_tokens: 1 } });
    const before = effects();
    const review = withUsage({ userId: 'owner', botId: reviewBot.id }, () => learning.refineLearning('owner', reviewBot.id));
    const running = learning.runLearningReview(review.id);
    try {
      for (let n = 0; n < 200 && !pending(reviewBot.id); n++) await new Promise(r => setTimeout(r, 20));
      assert.equal(pending(reviewBot.id)?.tool, `api_max:${name}`);
      assert.equal(responses, 1); assert.deepEqual(effects(), before);
      resolveApproval('owner', pending(reviewBot.id).id, decision);
      assert.equal((await running)?.status, 'completed');
      const effect = name === 'remember' ? 'memories' : 'skills';
      assert.deepEqual(effects(), { ...before, [effect]: before[effect] + Number(decision === 'allow') });
    } finally { learning.configureLearningModelExecutor(); }
  }
});


test('R16 WW discovery asks first for the actual task, skill or browser action and denial never dispatches', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const evidence = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'Create API perm test and api-perm-test, then find Vienna weather.' });
  const skill = { expected_revision: 0, name: 'api-perm-test', description: 'Local permission fixture', body: 'Local fixture instructions', reason: 'Requested fixture', evidence: [{ botId: bot.id, generation: evidence.generation, seq: evidence.seq }] };
  for (const [name, args] of [
    ['create_task', { title: 'API perm test' }],
    ['propose_skill', skill], ['manage_skill', { ...skill, action: 'create' }],
    ['open_browser', { url: 'https://example.test/search?q=Vienna+weather' }],
  ] as const) {
    const action = mock.method(toolMap.get(name)!, 'impl');
    const search = mock.method(toolMap.get('tool_search')!, 'impl');
    const describe = mock.method(toolMap.get('tool_describe')!, 'impl');
    try {
      const before = listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length;
      await planDiscoveredAction(name, args);
      enqueue(bot.id, { type: 'user', text: 'Discover and run the local fixture action' }); await settleAgentJobs();
      assert.equal(search.mock.callCount(), 1); assert.equal(describe.mock.callCount(), 1);
      assert.equal(pending()?.tool, `api_max:${name}`);
      const card = listRows(bot.id).find(r => r.seq === pending().row_seq)!.body as any;
      assert.match(card.title, new RegExp(name.replaceAll('_', ' ')));
      assert.doesNotMatch(card.title, /tool search|tool describe|tool call/i);
      assert.equal(action.mock.callCount(), 0);
      await decide('deny');
      assert.equal(action.mock.callCount(), 0); assert.equal(pending(), undefined);
      assert.equal(listRows(bot.id).filter(r => r.body.type === 'card' && r.body.card === 'approval').length, before + 1);
    } finally { action.mock.restore(); search.mock.restore(); describe.mock.restore(); }
  }
});

test('R17 current-message skill, task and memory creates ask for the action first and use current evidence', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const cards = () => (db.prepare('SELECT count(*) n FROM approvals WHERE bot_id=?').get(bot.id) as any).n;
  const search = mock.method(toolMap.get('session_search')!, 'impl');
  try {
    for (const [text, name] of [
      ['YY create a skill named Fixture checklist. Check the result and report it.', 'propose_skill'],
      ['YY create a task named Fixture review.', 'create_task'],
      ['YY remember: The fixture color preference is teal.', 'remember'],
    ]) for (const decision of ['deny', 'allow'] as const) {
      const action = mock.method(toolMap.get(name)!, 'impl');
      try {
        const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text });
        const before = cards();
        enqueue(bot.id, { type: 'user', text }); await settleAgentJobs();
        assert.equal(pending()?.tool, `api_max:${name}`);
        const card = listRows(bot.id).find(r => r.seq === pending().row_seq)!.body as any;
        if (name !== 'create_task') {
          assert.equal(card.args.evidence[0].seq, source.seq);
          assert.equal(card.args.evidence[0].generation, source.generation);
        }
        assert.equal(action.mock.callCount(), 0);
        await decide(decision);
        assert.equal(action.mock.callCount(), Number(decision === 'allow'));
        if (decision === 'allow') assert.notEqual((await action.mock.calls[0].result).isError, true);
        assert.equal(pending(), undefined);
        assert.equal(cards(), before + 1);
      } finally { action.mock.restore(); }
    }
    assert.equal(search.mock.callCount(), 0);
  } finally { search.mock.restore(); }
});

test('R17 past-chat lookup stays gated with intent wording, bounded query and a decline does not block a new skill', async () => {
  setLevel('every_action'); db.exec('DELETE FROM policies');
  const search = mock.method(toolMap.get('session_search')!, 'impl');
  try {
    for (const query of ['the checklist: weekly review', 'Long query '.repeat(40), '']) {
      await run('session_search', { query });
      const card = listRows(bot.id).find(r => r.seq === pending().row_seq)!.body as any;
      assert.ok(card.title.startsWith(`Allow ${bot.name} to search your past chats`));
      if (query.length > 120) { assert.ok(card.title.endsWith('...?')); assert.ok(card.title.length < 200); }
      else if (query) assert.ok(card.title.endsWith(` for ${query}?`));
      await decide('deny');
    }
    assert.equal(search.mock.callCount(), 0);
    const text = 'YY create a skill named Fixture checklist. Check the result and report it.';
    const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text });
    // A model can still choose an optional older lookup. Its refusal must not
    // prevent the requested create action in the same API continuation.
    planAction('session_search', { query: 'an older checklist' });
    enqueue(bot.id, { type: 'user', text }); await settleAgentJobs();
    assert.equal(pending()?.tool, 'api_max:session_search');
    planAction('propose_skill', { expected_revision: 0, name: 'Fixture checklist after decline', description: 'Current request', body: 'Check the result and report it.', reason: 'Requested in the current message', evidence: [{ botId: bot.id, generation: source.generation, seq: source.seq }] });
    await decide('deny');
    assert.equal(pending()?.tool, 'api_max:propose_skill');
    await decide('allow');
    assert.equal(pending(), undefined);
    assert.equal(search.mock.callCount(), 0);
  } finally { search.mock.restore(); }
});

test('R17 current-message provenance follows approval resumes and excludes older, later or internal messages', async () => {
  const { currentUserMessageRef } = await import('../server/src/knowledge/sessions.js');
  const { acceptJob } = await import('../server/src/agent/jobs.js');
  const text = 'Create a skill named Source fixture.';
  const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text });
  const job = acceptJob(bot.id, { type: 'user', text });
  const ref = currentUserMessageRef('owner', bot.id, job.id);
  assert.equal(ref?.seq, source.seq);
  const later = appendRow(bot.id, 'message', { type: 'message', role: 'user', text });
  db.prepare('UPDATE rows SET created_at=created_at+10000 WHERE bot_id=? AND seq=?').run(bot.id, later.seq);
  const resume = acceptJob(bot.id, { type: 'resume', parentJobId: job.id });
  assert.deepEqual(currentUserMessageRef('owner', bot.id, resume.id), ref);
  for (const trigger of [{ type: 'system', text }, { type: 'user', text, audience: 'internal' }, { type: 'user', text: 'No matching current message' }, { type: 'user', text, roomId: 'fixture-room' }]) {
    assert.equal(currentUserMessageRef('owner', bot.id, acceptJob(bot.id, trigger).id), null);
  }
  const other = createBot('owner', { name: 'Other fixture' });
  assert.equal(currentUserMessageRef('owner', other.id, job.id), null);
});

test('R16 WW API turns record pending, denied and allowed actions for direct, native and personal OpenRouter without replacing CLI history', async () => {
  const { apiRuns, lastCliRun, cliRunsByProvider, recordCliRun } = await import('../server/src/cli/run-diagnostics.js');
  const { withCliDiagnostics, cliDiagnostic } = await import('../server/src/cli/diagnostics.js');
  const { saveOpenRouterKey } = await import('../server/src/providers/openrouter.js');
  setLevel('every_action'); db.exec('DELETE FROM policies');
  await withCliDiagnostics({ provider: 'claude', nativeTools: [{ name: 'create_task' }] }, 'server', async () => {
    cliDiagnostic()?.({ event: 'tool_result', tool: 'create_task', admission: 'returned' });
  }, undefined, recordCliRun('owner'));
  const oldCli = lastCliRun('owner'), oldProviders = cliRunsByProvider('owner');
  for (const route of ['direct', 'native-openrouter', 'personal-openrouter']) {
    setEnvOverride('LLM_PROVIDER', route === 'native-openrouter' ? 'openrouter' : 'direct');
    setEnvOverride('OPENROUTER_API_KEY', 'local-native-key-never-sent');
    if (route === 'personal-openrouter') saveOpenRouterKey('owner', 'local-personal-key-never-sent', 'manual');
    const model = withUsage({ userId: 'owner', botId: bot.id }, () => mockModelClient());
    try {
      for (const decision of ['deny', 'allow'] as const) {
        const before = fileCount();
        await run('tool_call', wrapped('save_file', { filename: 'private-filename-sentinel.txt', content: 'private-content-sentinel' }));
        const waiting = apiRuns('owner');
        assert.equal(waiting.latest.result, 'pending_approval');
        assert.deepEqual(waiting.lastToolRun, waiting.latest);
        assert.equal(waiting.latest.lastTool, 'save_file');
        assert.equal(waiting.latest.runtime, 'api');
        assert.equal(waiting.latest.provider, route === 'direct' ? 'direct' : 'openrouter');
        assert.ok(waiting.latest.toolsOffered > 0);
        assert.equal(fileCount(), before);
        await decide(decision);
        assert.equal(apiRuns('owner').lastToolRun.result, decision === 'deny' ? 'denied' : 'allowed');
        assert.equal(apiRuns('owner').latest.result, decision === 'deny' ? 'denied' : 'completed');
        assert.equal(apiRuns('owner').latest.errorCode, null);
        assert.equal(apiRuns('owner').lastToolRun.errorCode, null);
        assert.equal(fileCount(), before + Number(decision === 'allow'));
        assert.deepEqual(lastCliRun('owner'), oldCli); assert.deepEqual(cliRunsByProvider('owner'), oldProviders);
        assert.doesNotMatch(JSON.stringify(apiRuns('owner')), /sentinel|never-sent|arguments|message/);
        assert.deepEqual(Object.keys(apiRuns('owner').lastToolRun).sort(), ['errorCode', 'lastTool', 'provider', 'result', 'runtime', 'startedAt', 'toolsOffered', 'trigger']);
      }
    } finally { model.mock.restore(); }
  }
  db.prepare("DELETE FROM provider_connections WHERE user_id='owner'").run();
  setEnvOverride('LLM_PROVIDER', 'direct'); setEnvOverride('OPENROUTER_API_KEY', null);
});
