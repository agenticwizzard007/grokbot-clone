import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-kk-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async input => {
  const url = new URL(String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  throw new Error('No external requests allowed');
});
const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { toolMap, executionPolicyFor, runComposioTool } = await import('../server/src/agent/tools.js');
const { saveAccountPreferences } = await import('../server/src/settings.js');
const { composio, resetAppDiscovery } = await import('../server/src/composio.js');
const { connectionSummary } = await import('../server/src/connection-details.js');
const { appArguments, ConnectionGateway } = await import('../server/src/platform/composio-policy.js');
const { saveMcpServer, mcpToolName, getMcpServer } = await import('../server/src/mcp/store.js');
const { Hono } = await import('hono');
const { api } = await import('../server/src/routes.js');
const http = new Hono().route('/api', api);
for (const id of ['codex', 'standard']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Fixture account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
}
selectCli('codex', 'codex');
const bots = Object.fromEntries(['codex', 'standard'].map(id => [id, createBot(id, { name: 'Fixture Bot', isPrimary: true })]));
const client = composio();
let accounts: any[] = [], tools: any[] = [], executions: any[] = [], failure: any;
mock.method(client.connectedAccounts, 'list', async () => ({ items: accounts }));
mock.method(client.tools, 'getRawComposioTools', async () => tools);
mock.method(client.tools, 'getRawComposioToolBySlug', async slug => tools.find(t => t.slug === slug));
mock.method(client.tools, 'execute', async (slug, args) => { if (failure) throw failure; executions.push({ slug, args }); return { successful: true, data: { subjects: ['Fixture one', 'Fixture two', 'Fixture three'] } }; });
beforeEach(() => { accounts = []; tools = []; executions = []; failure = undefined; db.exec('DELETE FROM policies'); resetAppDiscovery(); });
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const context = (id = 'codex', readOnlyApps = true) => ({ userId: id, botId: bots[id].id, depth: 0, readOnlyApps, enqueueBotMessage() {} });
const account = (toolkit = 'gmail', status = 'ACTIVE', extra = {}) => ({ id: `fixture-${toolkit}`, toolkit: { slug: toolkit }, status, createdAt: '2026-11-01T00:00:00Z', data: { email: 'fixture@example.test' }, ...extra });
const tool = (slug: string, tags = ['readOnlyHint']) => ({ slug, toolkit: { slug: slug.split('_')[0].toLowerCase() }, version: '20261101_00', tags, inputParameters: { type: 'object' } });
const args = (slug = 'GMAIL_FETCH_EMAILS', arguments_ = {}) => ({ connectionId: `fixture-${slug.split('_')[0].toLowerCase()}`, revision: 1, tool_slug: slug, arguments: arguments_ });

const internal = `get_team_state get_team_records read_team_source read_team_job inspect_teammate_setup prepare_teammate_setup list_app_connections search_apps request_app_connection tool_search tool_describe tool_call execute_code list_skills read_skill apply_procedure propose_skill session_search remember recall correct_memory forget_memory manage_skill manage_memory create_goal control_goal verify_goal get_workflows create_workflow start_workflow control_workflow add_workflow_dependency delegate_workflow_task complete_workflow_task list_deliverables routine_history get_platform_state save_agent_setup computer_screenshot computer_click computer_type computer_key computer_scroll computer_drag open_browser save_file shell create_routine list_event_triggers create_event_routine stay_silent set_checkins list_routines update_routine delete_routine create_task update_task send_to_bot create_bot replicate_bot retry_bot_setup spawn_subagent list_subagents message_subagent stop_subagent create_group post_to_group update_profile wait_for_browser_access present_draft ask_user browser_navigate browser_navigate_back browser_snapshot browser_click browser_type browser_fill_form browser_select_option browser_press_key browser_hover browser_drag browser_file_upload browser_handle_dialog browser_tabs browser_wait_for browser_take_screenshot browser_find browser_evaluate browser_console_messages`.split(' ');
// Appearance tools are internal; their handlers enforce direct-chat and preview Apply rules.
internal.push(...'get_ui_config list_ui_options preview_ui_patch apply_ui_patch discard_ui_preview undo_ui_change reset_ui apply_preset save_preset set_accent create_dashboard add_widget update_widget remove_widget move_widget delete_dashboard rename_dashboard'.split(' '));
// Dashboard reads and previews are internal; saved changes retain the UI-config Apply rules.
internal.push(...'list_dashboards duplicate_dashboard reorder_dashboards add_agent_widget'.split(' '));
// Requirements reads and previews are internal; profile writes retain handler confirmation rules.
internal.push(...'get_requirements preview_adaptation update_requirements reset_requirements'.split(' '));
// Handoffs use the same internal approval policy as send_to_bot and message_subagent.
internal.push(...'submit_output handoff_to_agent read_handoff list_handoffs submit_verdict start_loop write_flow_summary'.split(' '));
test('R11-2 audit covers every registered native tool', () => {
  const registered = [...toolMap.keys()].sort();
  const audited = [...internal, 'deliver_artifact', 'retry_delivery'].sort();
  const missing = registered.filter(name => !audited.includes(name));
  assert.deepEqual(registered, audited, missing.length ? `Missing native tools: ${missing.join(', ')}; add them to the audit list in this file` : undefined);
});
test('R11-2 requirements and dashboard tools follow UI-config approval rules at both API approval levels and on CLI plans', async () => {
  try {
    for (const apiApprovalLevel of ['standard', 'every_action'] as const) {
      for (const mode of ['codex', 'standard']) {
        saveAccountPreferences(mode, { apiApprovalLevel });
        for (const name of ['get_requirements', 'get_ui_config', 'preview_adaptation', 'preview_ui_patch', 'update_requirements', 'reset_requirements', 'save_preset', 'apply_ui_patch', 'undo_ui_change', 'list_dashboards', 'duplicate_dashboard', 'reorder_dashboards', 'add_agent_widget']) {
          const policy = await executionPolicyFor(mode, name, {}, bots[mode].id);
          const asks = mode === 'standard' && apiApprovalLevel === 'every_action';
          assert.equal(policy.decision, asks ? 'ask' : 'allow', `${mode} ${apiApprovalLevel} ${name}`);
          assert.equal(policy.key, asks ? `api_max:${name}` : name);
        }
      }
    }
  } finally {
    for (const mode of ['codex', 'standard']) saveAccountPreferences(mode, { apiApprovalLevel: 'standard' });
  }
});
test('R11-2 handoff sending follows teammate messaging at both API approval levels and on CLI plans', async () => {
  try {
    for (const apiApprovalLevel of ['standard', 'every_action'] as const) {
      for (const mode of ['codex', 'standard']) {
        saveAccountPreferences(mode, { apiApprovalLevel });
        for (const name of ['handoff_to_agent', 'send_to_bot', 'message_subagent', 'post_to_group']) {
          const policy = await executionPolicyFor(mode, name, {}, bots[mode].id);
          const asks = mode === 'standard' && apiApprovalLevel === 'every_action';
          assert.equal(policy.decision, asks ? 'ask' : 'allow', `${mode} ${apiApprovalLevel} ${name}`);
          assert.equal(policy.key, asks ? `api_max:${name}` : name);
        }
      }
    }
  } finally {
    for (const mode of ['codex', 'standard']) saveAccountPreferences(mode, { apiApprovalLevel: 'standard' });
  }
});
for (const mode of ['codex', 'standard']) {
  for (const name of internal) test(`R11-2 ${mode}: internal ${name} has no approval`, async () => {
    assert.equal((await executionPolicyFor(mode, name, {}, bots[mode].id)).decision, 'allow');
  });
  for (const channel of ['library', 'email', 'slack', 'telegram', 'whatsapp']) test(`R11-2 ${mode}: deliver_artifact ${channel}`, async () => {
    assert.equal((await executionPolicyFor(mode, 'deliver_artifact', { channel }, bots[mode].id)).decision, channel === 'library' ? 'allow' : 'ask');
  });
  test(`R11-2 ${mode}: retry_delivery asks and present_draft stays free`, async () => {
    assert.equal((await executionPolicyFor(mode, 'retry_delivery', {}, bots[mode].id)).decision, 'ask');
    assert.equal((await executionPolicyFor(mode, 'present_draft', { channel: 'email' }, bots[mode].id)).decision, 'allow');
  });
  for (const slug of ['GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'SLACK_SEND_MESSAGE', 'SLACK_CREATE_DRAFT', 'NOTION_UPDATE_PAGE', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLEDRIVE_DELETE_FILE', 'WHATSAPP_SEND_MESSAGE', 'LINKEDIN_CREATE_POST', 'TWITTER_POST_TWEET', 'WORDPRESS_PUBLISH_POST', 'GITHUB_GET_AND_DELETE', 'GMAIL_FETCH_AND_MARK_READ', 'ANYAPP_UPSERT_RECORD', 'ANYAPP_OPEN_CONVERSATION', 'ANYAPP_MAIL_DRAFT', 'ANYAPP_UNKNOWN']) test(`R11-2 ${mode}: external ${slug} asks even with readOnlyHint`, async () => {
    accounts = [account(slug.split('_')[0].toLowerCase())]; tools = [tool(slug, slug === 'ANYAPP_UNKNOWN' ? [] : ['readOnlyHint'])];
    assert.equal((await executionPolicyFor(mode, 'SWARM_APPS_EXECUTE', args(slug), bots[mode].id)).decision, 'ask');
    db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run(mode, slug);
    assert.equal((await executionPolicyFor(mode, 'SWARM_APPS_EXECUTE', args(slug), bots[mode].id)).decision, 'allow');
  });
  for (const slug of ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_DRAFTS', 'GMAIL_GET_DRAFT', 'GMAIL_GET_SEND_AS_ALIAS', 'WORDPRESS_GET_POST', 'GITHUB_GET_WORKFLOW_RUN', 'GITHUB_LIST_OPEN_ISSUES', 'GITHUB_GET_COMMIT', 'SLACK_LIST_MESSAGES', 'NOTION_RETRIEVE_PAGE', 'GOOGLECALENDAR_LIST_EVENTS', 'GOOGLEDRIVE_GET_FILE', 'ANYAPP_PEEK']) test(`R11-2 ${mode}: attested read ${slug} stays free`, async () => {
    accounts = [account(slug.split('_')[0].toLowerCase())]; tools = [tool(slug)];
    const policy = await executionPolicyFor(mode, 'SWARM_APPS_EXECUTE', args(slug), bots[mode].id);
    assert.equal(policy.decision, 'allow'); assert.equal(policy.readOnlyApps, true);
  });
}
test('R11-2 custom MCP send/post cannot bypass approval via server opt-out; Always allow still works', async () => {
  const saved = saveMcpServer('codex', { name: 'Fixture', transport: 'http', url: 'https://fixture.example.test/mcp', botIds: [bots.codex.id], requireApproval: false });
  for (const name of ['send_email', 'create_draft', 'publish_post', 'get_and_delete']) {
    db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{ name, inputSchema: { type: 'object' } }]), saved.id);
    const full = mcpToolName(getMcpServer('codex', saved.id)!, name);
    const policy = await executionPolicyFor('codex', full, {}, bots.codex.id); assert.equal(policy.decision, 'ask');
    db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run('codex', policy.key);
    assert.equal((await executionPolicyFor('codex', full, {}, bots.codex.id)).decision, 'allow');
  }
});
test('R11-3 Active Gmail reads accept only the authenticated mailbox selector and return three subjects', async () => {
  accounts = [account()]; tools = [tool('GMAIL_FETCH_EMAILS')];
  const input = args('GMAIL_FETCH_EMAILS', { user_id: 'me', max_results: 3 });
  const policy = await executionPolicyFor('codex', 'SWARM_APPS_EXECUTE', input, bots.codex.id);
  assert.equal(policy.decision, 'allow');
  const result = await runComposioTool(context(), 'SWARM_APPS_EXECUTE', input);
  assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.output as string).subjects.length, 3);
  assert.equal(executions[0].args.userId, 'codex'); assert.equal(executions[0].args.connectedAccountId, 'fixture-gmail');
  assert.equal(executions[0].args.arguments.user_id, 'me');
  for (const override of [{ user_id: 'other@example.test' }, { userId: 'me' }, { connectedAccountId: 'foreign' }, { tenantId: 'other' }]) assert.throws(() => appArguments(override, 'GMAIL_FETCH_EMAILS'), /overrides/);
  assert.throws(() => appArguments({ user_id: 'me' }, 'OTHER_FETCH'), /overrides/);
});
for (const [name, error, expected] of [
  ['rate limit', { status: 429 }, /too many requests/], ['provider error', { status: 503 }, /temporarily unavailable/],
  ['timeout', { name: 'TimeoutError' }, /timed out/], ['invalid arguments', { status: 400 }, /request arguments/],
  ['authorization rejected', { status: 401 }, /reconnect if needed/], ['permission denied', { status: 403 }, /account permissions/],
  ['unknown provider error', {}, /does not mean the account is disconnected/],
] as const) test(`R11-3 ${name} has an honest safe error`, async () => {
  accounts = [account()]; tools = [tool('GMAIL_FETCH_EMAILS')]; failure = Object.assign(new Error('PRIVATE_SENTINEL'), error);
  const result = await runComposioTool(context(), 'SWARM_APPS_EXECUTE', args());
  assert.equal(result.isError, true); assert.match(String(result.output), expected);
  assert.doesNotMatch(String(result.output), /connection failed|Native tool execution failed|PRIVATE_SENTINEL/);
});
test('R11-3 disabled Active accounts cannot execute or receive automatic read permission', async () => {
  accounts = [account('gmail', 'ACTIVE', { isDisabled: true })]; tools = [tool('GMAIL_FETCH_EMAILS')];
  assert.equal((await executionPolicyFor('codex', 'SWARM_APPS_EXECUTE', args(), bots.codex.id)).decision, 'ask');
  assert.equal((await runComposioTool(context(), 'SWARM_APPS_EXECUTE', args())).isError, true); assert.equal(executions.length, 0);
});
for (const scenario of ['active', 'expired plus active', 'zero', 'unfinished']) test(`R11-4 ${scenario}: Settings and agent agree on status and usable app count`, async () => {
  accounts = scenario === 'active' ? [account()] : scenario === 'expired plus active' ? [account(), account('slack', 'EXPIRED')]
    : scenario === 'unfinished' ? [account(), account('slack', 'EXPIRED', { statusReason: 'Authorization was started but not completed within 10 minutes' }), account('notion', 'INITIATED'), account('whatsapp', 'FAILED')] : [];
  const settings = await (await http.request('/api/apps/connections', { headers: { cookie: 'swarm_session=codex' } })).json() as any;
  const listed = JSON.parse((await toolMap.get('list_app_connections')!.impl({}, context())).output as string);
  assert.deepEqual(listed.connected, settings.connected); assert.equal(listed.connectedCount, settings.connectedCount);
  assert.deepEqual(listed.connections.map((a: any) => [a.id, a.status, a.displayStatus]), settings.connections.map((a: any) => [a.id, a.status, a.displayStatus]));
  assert.equal(listed.connectedCount, scenario === 'zero' ? 0 : 1);
  assert.equal(listed.connections.length, scenario === 'zero' ? 0 : scenario === 'expired plus active' ? 2 : 1);
});
test('R11-4 duplicate accounts and disabled accounts never inflate the connected app count', () => {
  assert.equal(connectionSummary([{ id: 'one', toolkit: 'gmail', status: 'ACTIVE' }, { id: 'two', toolkit: 'gmail', status: 'ACTIVE' }, { id: 'three', toolkit: 'slack', status: 'ACTIVE', isDisabled: true }]).connectedCount, 1);
});

test('R11-2 CLI account time zone changes are internal; API confirmation policy is preserved', async () => {
  assert.equal((await executionPolicyFor('codex', 'update_profile', { timezone: 'Europe/London' }, bots.codex.id)).decision, 'allow');
  assert.equal((await executionPolicyFor('standard', 'update_profile', { timezone: 'Europe/London' }, bots.standard.id)).decision, 'ask');
});
test('R11-3 tenant gateway permits Gmail me without changing the owned identity, revision, or write guard', async () => {
  const row = { id: 'fixture-gmail', tenant: 'codex', toolkit: 'gmail', revision: 7, state: 'active', isDefault: false };
  const dispatched: any[] = [];
  const gateway = new ConnectionGateway({ identity: async () => 'owned-provider-identity', list: async () => [row], get: async () => row,
    revoke: async () => false, begin: async () => true, finish: async () => {} }, {
    owned: async () => ({ toolkit: 'gmail', active: true }), tool: async () => ({ toolkit: 'gmail', version: '20261101_00', readOnly: true }),
    execute: async (...input: any[]) => { dispatched.push(input); return { subjects: ['Fixture one'] }; }, disconnect: async () => {}, refresh: async () => {},
  });
  const input = { connectionId: row.id, revision: 7, dispatchId: 'fixture_dispatch_123', slug: 'GMAIL_FETCH_EMAILS', arguments: { user_id: 'me' }, readOnly: true };
  assert.deepEqual(await gateway.execute('codex', input), { subjects: ['Fixture one'] });
  assert.deepEqual(dispatched[0].slice(0, 5), ['owned-provider-identity', row.id, input.slug, '20261101_00', input.arguments]);
  await assert.rejects(gateway.execute('codex', { ...input, revision: 8 }), /Connection not found/);
  await assert.rejects(gateway.execute('foreign', input), /Connection not found/);
  await assert.rejects(gateway.execute('codex', { ...input, arguments: { user_id: 'foreign' } }), /overrides/);
  await assert.rejects(gateway.execute('codex', { ...input, slug: 'GMAIL_SEND_EMAIL' }), /provider-verified read-only/);
  assert.equal(dispatched.length, 1);
});
