import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-app-text-policy-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'test.db'),
  FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'app-policy-test', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: 'test-project', INKBOX_TUNNEL: '0', ADMIN_EMAILS: '', ADMIN_PHONES: '' });
mock.method(globalThis, 'fetch', async input => {
  const host = new URL(String(input)).hostname;
  if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (host === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Unexpected real provider request.');
});
const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { composio, resetAppDiscovery } = await import('../server/src/composio.js');
const { executionPolicyFor, policyFor, runComposioTool } = await import('../server/src/agent/tools.js');
const { setEnvOverride } = await import('../server/src/env.js');
for (const id of ['alice', 'bob']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
  .run(id, `${id}@example.test`, id, Date.now());
let active: any, draft: any, sequence = 0;
beforeEach(() => {
  db.exec('DELETE FROM bots; DELETE FROM policies');
  active = createBot('alice', { name: 'Active', isPrimary: true });
  draft = createBot('alice', { name: 'Setup' });
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const rawTool = (slug = 'GITHUB_PEEK', tags: unknown = ['readOnlyHint']) => ({ slug,
  toolkit: { slug: 'github' }, description: 'Inspect repository access.', version: '20261101_00', tags,
  inputParameters: { type: 'object', properties: { repo: { type: 'string' } } }, internal: 'NEVER-PROJECT' });
const args = (slug = 'GITHUB_PEEK', extra = {}) => ({ connectionId: 'github-alice', revision: 1,
  tool_slug: slug, arguments: { repo: 'alice/project' }, ...extra });
const ctx = (readOnlyApps: boolean, botId = active.id) => ({ userId: 'alice', botId, depth: 0,
  readOnlyApps, enqueueBotMessage: () => { throw new Error('Unexpected delegation'); } });
const save = (slug: string, mode: string, userId = 'alice') => db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES(?,?,?)').run(userId, slug, mode);

function fixture(t: any) {
  setEnvOverride('COMPOSIO_API_KEY', `test-project-${++sequence}`);
  const client = composio();
  let tools: any[] = [rawTool()], activeAccount = true, fail = '';
  const dispatched: any[] = [], queries: any[] = [];
  t.mock.method(client.connectedAccounts, 'list', async (input: any) => {
    queries.push(input);
    if (fail === 'connections') throw new Error('PRIVATE provider credential');
    return { items: activeAccount ? [{ id: `github-${input.userIds[0]}`, toolkit: { slug: 'github' }, status: 'ACTIVE' }] : [], nextCursor: null };
  });
  t.mock.method(client.tools, 'getRawComposioTools', async () => {
    if (fail === 'metadata') throw new Error('PRIVATE provider credential');
    return tools;
  });
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async slug => tools.find(tool => tool.slug === slug));
  t.mock.method(client.tools, 'execute', async (...input: any[]) => {
    dispatched.push(input);
    return { data: { repository: 'alice/project' }, successful: true, error: null };
  });
  return { client, dispatched, queries, setTools: (value: any[]) => { tools = value; },
    revoke: () => { activeAccount = false; }, fail: (value: string) => { fail = value; } };
}

test('verified reads auto-allow regardless of slug verbs and pin fresh provider checks at execution', async t => {
  const f = fixture(t);
  assert.equal(policyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id).decision, 'ask');
  const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id);
  assert.equal(policy.decision, 'allow'); assert.equal(policy.readOnlyApps, true);
  assert.ok(f.queries.every(q => q.accountType === 'PRIVATE' && q.userIds.length === 1 && q.userIds[0] === 'alice'));
  assert.doesNotMatch(JSON.stringify(policy), /NEVER-PROJECT|parameters/);
  assert.equal((await runComposioTool(ctx(policy.readOnlyApps), 'SWARM_APPS_EXECUTE', args())).summary, 'done');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0][1].connectedAccountId, 'github-alice');
  assert.equal(f.dispatched[0][1].version, '20261101_00');
});

test('read-looking writes, unknown/conflicting metadata and fake hints require approval', async t => {
  const f = fixture(t), slug = 'GITHUB_GET_AND_DELETE';
  assert.equal(policyFor('alice', 'SWARM_APPS_EXECUTE', args(slug), active.id).decision, 'allow');
  for (const tags of [undefined, [], ['destructiveHint'], ['readOnlyHint', 'updateHint'], ['readOnlyHint', 'createHint'], { readOnlyHint: true }]) {
    f.setTools([{ ...rawTool(slug), tags, readOnlyHint: true, readOnly: true }]); resetAppDiscovery();
    const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(slug), active.id);
    assert.equal(policy.decision, 'ask'); assert.equal(policy.readOnlyApps, false);
  }
  assert.equal(f.dispatched.length, 0);
});

test('saved policies are owner-scoped, honored before lookup, and explicit write permission remains usable', async t => {
  const f = fixture(t), slug = 'GITHUB_GET_AND_DELETE';
  f.setTools([rawTool(slug, ['destructiveHint'])]);
  save(slug, 'always_allow', 'bob');
  assert.equal((await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(slug), active.id)).decision, 'ask');
  f.fail('connections');
  for (const [mode, decision] of [['blocked', 'block'], ['needs_approval', 'ask'], ['always_allow', 'allow']]) {
    save(slug, mode);
    const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(slug), active.id);
    assert.equal(policy.decision, decision); assert.equal(policy.readOnlyApps, false);
  }
  f.fail('');
  assert.equal((await runComposioTool(ctx(false), 'SWARM_APPS_EXECUTE', args(slug))).summary, 'done');
  assert.equal(f.dispatched.length, 1);
  save('GITHUB_PEEK', 'needs_approval');
  assert.equal((await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id)).decision, 'ask');
});

test('foreign/inactive accounts, stale revisions, unknown/meta slugs and wrong-toolkit metadata cannot auto-allow', async t => {
  const f = fixture(t);
  for (const patch of [{ connectionId: 'github-bob' }, { revision: 2 }, { revision: '1' }, { tool_slug: 'GITHUB_OTHER' }, { tool_slug: 'COMPOSIO_SEARCH_TOOLS' }]) {
    const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args('GITHUB_PEEK', patch), active.id);
    assert.equal(policy.decision, 'ask'); assert.equal(policy.readOnlyApps, false);
  }
  f.setTools([{ ...rawTool(), toolkit: { slug: 'gmail' } }]); resetAppDiscovery();
  assert.equal((await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id)).decision, 'ask');
  f.revoke();
  assert.equal((await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id)).decision, 'ask');
  assert.equal(f.dispatched.length, 0);
});

test('duplicate contradictory provider entries and provider lookup failures fail closed without leaking errors', async t => {
  const f = fixture(t);
  f.setTools([rawTool(), rawTool('GITHUB_PEEK', ['destructiveHint'])]);
  assert.equal((await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id)).decision, 'ask');
  for (const fail of ['connections', 'metadata']) {
    f.fail(fail); resetAppDiscovery();
    const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id);
    assert.equal(policy.decision, 'ask'); assert.equal(policy.readOnlyApps, false);
    assert.doesNotMatch(JSON.stringify(policy), /PRIVATE|credential/);
  }
});

test('cached discovery cannot authorize a changed write and per-call read pins do not leak to following writes', async t => {
  const f = fixture(t);
  const first = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id);
  assert.equal(first.readOnlyApps, true);
  f.setTools([rawTool('GITHUB_PEEK', ['destructiveHint']), rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  const cached = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id);
  assert.equal(cached.decision, 'allow'); assert.equal(cached.readOnlyApps, true);
  await assert.rejects(runComposioTool(ctx(cached.readOnlyApps), 'SWARM_APPS_EXECUTE', args()), /provider-verified read-only/);
  assert.equal(f.dispatched.length, 0);
  const write = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args('GITHUB_CREATE_ISSUE'), active.id);
  assert.equal(write.decision, 'ask'); assert.equal(write.readOnlyApps, false);
  await runComposioTool(ctx(write.readOnlyApps), 'SWARM_APPS_EXECUTE', args('GITHUB_CREATE_ISSUE'));
  assert.equal(f.dispatched.length, 1, 'after the caller approves, the exact write remains executable');
});

test('setup still enforces provider read-only checks despite an explicit allow policy or caller false pin', async t => {
  const f = fixture(t), slug = 'GITHUB_GET_AND_DELETE';
  f.setTools([rawTool(slug, ['destructiveHint'])]); save(slug, 'always_allow');
  const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(slug), draft.id);
  assert.equal(policy.decision, 'allow'); assert.equal(policy.readOnlyApps, false);
  await assert.rejects(runComposioTool(ctx(policy.readOnlyApps, draft.id), 'SWARM_APPS_EXECUTE', args(slug)), /provider-verified read-only/);
  assert.equal(f.dispatched.length, 0);
});

test('policy changes during discovery take precedence over cached metadata', async t => {
  const f = fixture(t);
  t.mock.method(f.client.tools, 'getRawComposioTools', async () => {
    save('GITHUB_PEEK', 'blocked');
    return [rawTool()];
  });
  const policy = await executionPolicyFor('alice', 'SWARM_APPS_EXECUTE', args(), active.id);
  assert.equal(policy.decision, 'block'); assert.equal(policy.readOnlyApps, false);
  assert.equal(f.dispatched.length, 0);
});

test('non-execution tools preserve native policies without provider lookup', async t => {
  const f = fixture(t); f.fail('connections');
  for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'remember']) {
    assert.deepEqual(await executionPolicyFor('alice', name, {}, active.id), { ...policyFor('alice', name, {}, active.id), readOnlyApps: false });
  }
  assert.equal(f.queries.length, 0);
});

test('tenant classification uses exact gateway account/revision metadata and pins gateway execution', () => {
  const tenant = 'usr_textpolicy123', manifest = path.join(root, 'tenant-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ tenantId: tenant, volumeId: 'test-volume' }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    fs.readFile = async () => 'runtime-token';
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const r = JSON.parse(init.body); requests.push(r);
      const data = r.operation === 'connections' ? [{id:'private-github',toolkit:'github',status:'ACTIVE',revision:7}]
        : r.operation === 'search' ? {connectionId:'private-github',revision:7,tools:[{slug:'GITHUB_PEEK',readOnly:true}]}
        : {data:{verified:true},successful:true};
      return Response.json(data);
    };
    const {executionPolicyFor,runComposioTool} = await import('./server/src/agent/tools.ts');
    const args = {connectionId:'private-github',revision:7,tool_slug:'GITHUB_PEEK',arguments:{}};
    const p = await executionPolicyFor('${tenant}','SWARM_APPS_EXECUTE',args);
    assert.equal(p.decision,'allow'); assert.equal(p.readOnlyApps,true);
    await runComposioTool({userId:'${tenant}',botId:'unused',depth:0,readOnlyApps:p.readOnlyApps},'SWARM_APPS_EXECUTE',args);
    assert.deepEqual(requests.map(r=>r.operation),['connections','search','execute']);
    assert.equal(requests[1].input.connectionId,'private-github');
    assert.equal(requests[1].input.query,'GITHUB_PEEK');
    assert.equal(requests[2].input.readOnly,true);
    assert.equal(requests[2].input.revision,7);
    const stale = await executionPolicyFor('${tenant}','SWARM_APPS_EXECUTE',{...args,revision:6});
    assert.equal(stale.decision,'ask'); assert.equal(stale.readOnlyApps,false);
    console.log('tenant policy verified');
  `;
  const childEnv = { ...process.env, SWARM_ROLE: 'tenant', SWARM_TENANT_ID: tenant, SWARM_VOLUME_ID: 'test-volume',
    TENANT_MANIFEST_FILE: manifest, TENANT_DATA_KEY_FILE: path.join(root, 'unused-key'), DB_PATH: path.join(root, 'tenant.db'),
    COMPOSIO_GATEWAY_URL: 'https://gateway.test', RUNTIME_TOKEN_FILE: '/run/swarm/test-token' };
  for (const name of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'FLY_API_TOKEN', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'INKBOX_ADMIN_API_KEY', 'INKBOX_API_KEY', 'DIRECT_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'APPLE_PRIVATE_KEY']) delete childEnv[name];
  assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8', timeout: 15_000 }), /tenant policy verified/);
});
