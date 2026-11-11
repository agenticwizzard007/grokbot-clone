import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-app-readonly-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'app-readonly-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async input => {
  const host = new URL(String(input)).hostname;
  if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (host === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Unexpected real provider request.');
});
const { db } = await import('../server/src/db.js');
const { composio, executeComposio } = await import('../server/src/composio.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { trustedReadOnly } = await import('../server/src/platform/composio-policy.js');
const { ComposioProvider } = await import('../server/src/platform/composio-service.js');
const { composioGatewayApp } = await import('../server/src/platform/composio-gateway.js');
for (const id of ['alice', 'bob']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@test.example`, id, Date.now());
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('bulk provider ownership shares private account pages and stops when all requested accounts are found', async t => {
  const provider = new ComposioProvider('test-bulk-project');
  const queries: any[] = [];
  t.mock.method(provider.sdk.connectedAccounts, 'list', async (args: any) => {
    queries.push(args);
    return args.cursor ? { items: [{ id: 'second', toolkit: { slug: 'gmail' }, status: 'EXPIRED' }], nextCursor: 'unused-third' }
      : { items: [{ id: 'first', toolkit: { slug: 'notion' }, status: 'ACTIVE' }, { id: 'unrequested', toolkit: { slug: 'slack' }, status: 'ACTIVE' }], nextCursor: 'second-page' };
  });
  const result = await provider.ownedMany('owner', ['first', 'second']);
  assert.deepEqual([...result], [['first', { toolkit: 'notion', active: true }], ['second', { toolkit: 'gmail', active: false }]]);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(q => q.accountType === 'PRIVATE' && q.userIds.length === 1 && q.userIds[0] === 'owner'));
  assert.deepEqual(await provider.owned('owner', 'first'), { toolkit: 'notion', active: true });
  assert.equal(queries.length, 3);
});

const parameters = { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], additionalProperties: false };
const rawTool = (slug = 'GITHUB_PEEK', tags: unknown = ['readOnlyHint']) => ({ slug, name: 'GitHub account read', description: 'Inspect repository access.',
  toolkit: { slug: 'github', name: 'GitHub' }, version: '20261101_00', tags, inputParameters: parameters, internalKey: 'never-project-secret' });
let next = 0;
function dev(t: any) {
  setEnvOverride('COMPOSIO_API_KEY', `test-project-${++next}`);
  const client = composio();
  let tool: any = rawTool(), available = true, fail = '';
  const calls: any[] = [];
  t.mock.method(client.connectedAccounts, 'list', async ({ userIds }: any) => ({ items: available ? [
    { id: `github-${userIds[0]}`, toolkit: { slug: 'github' }, status: 'ACTIVE' },
  ] : [], nextCursor: null }));
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => { if (fail === 'metadata') throw new Error('Metadata provider failure.'); return tool; });
  t.mock.method(client.tools, 'getRawComposioTools', async () => [tool, rawTool('COMPOSIO_REMOTE_WORKBENCH'), { ...rawTool('GMAIL_GET_EMAIL'), toolkit: { slug: 'gmail' } }]);
  t.mock.method(client.tools, 'execute', async (...args: any[]) => { calls.push(args); if (fail === 'execute') throw new Error('Provider execution failure.'); return { data: { repo: 'verified' }, successful: true, error: null, logId: 'test-log' }; });
  const args = () => ({ connectionId: 'github-alice', revision: 1, tool_slug: tool.slug, arguments: { owner: 'alice', repo: 'project' } });
  return { client, calls, args, setTool: (value: any) => { tool = value; }, revoke: () => { available = false; }, fail: (value: string) => { fail = value; } };
}

test('actual SDK tag array is required; names, parameter readOnly and conflicting hints cannot authorize', () => {
  assert.equal(trustedReadOnly({ tags: ['readOnlyHint'] }), true);
  for (const tags of [undefined, [], ['read_only'], ['readOnlyHint', 'createHint'], ['readOnlyHint', 'updateHint'], ['readOnlyHint', 'destructiveHint'], { readOnlyHint: true }]) {
    assert.equal(trustedReadOnly({ tags } as any), false);
  }
});

test('dev discovery projects trusted metadata and exact params; restricted GitHub read executes without slug heuristics', async t => {
  const f = dev(t);
  const discovery: any = (await executeComposio('alice', 'SWARM_APPS_SEARCH', { toolkit: 'github', query: 'verify repository' }, { readOnly: true })).data;
  assert.deepEqual(discovery, { connectionId: 'github-alice', revision: 1, tools: [{ slug: 'GITHUB_PEEK', description: 'Inspect repository access.', parameters, readOnly: true }] });
  assert.ok(!JSON.stringify(discovery).includes('never-project-secret'));
  assert.deepEqual(await executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), { data: { repo: 'verified' }, successful: true, error: null, logId: 'test-log' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ['GITHUB_PEEK', { userId: 'alice', connectedAccountId: 'github-alice', version: '20261101_00', arguments: f.args().arguments }]);
});

test('dev restricted execution refuses write/unknown/faked metadata despite saved allow policies, and rechecks after discovery', async t => {
  const f = dev(t);
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice','GITHUB_GET_AND_DELETE','always_allow')").run();
  for (const tags of [undefined, [], ['destructiveHint'], ['readOnlyHint', 'createHint']]) {
    f.setTool({ ...rawTool('GITHUB_GET_AND_DELETE'), tags, readOnlyHint: true, inputParameters: { ...parameters, readOnly: true } });
    const discovery: any = (await executeComposio('alice', 'SWARM_APPS_SEARCH', { toolkit: 'github', query: 'read' })).data;
    assert.equal(discovery.tools[0].readOnly, false);
    await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', { ...f.args(), readOnly: true }, { readOnly: true }), /provider-verified read-only/);
  }
  f.setTool(rawTool());
  await executeComposio('alice', 'SWARM_APPS_SEARCH', { toolkit: 'github', query: 'read' });
  f.setTool(rawTool('GITHUB_PEEK', ['updateHint']));
  await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), /provider-verified read-only/);
  assert.equal(f.calls.length, 0);
  await executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args());
  assert.equal(f.calls.length, 1, 'ordinary API remains compatible; root applies normal write approvals');
});

test('dev preserves ownership, revision, pinned tool and identity fences', async t => {
  const f = dev(t);
  for (const patch of [{ connectionId: 'github-bob' }, { revision: 2 }, { tool_slug: 'COMPOSIO_REMOTE_WORKBENCH' }, { arguments: { userId: 'bob' } }, { arguments: [] }]) {
    await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', { ...f.args(), ...patch }, { readOnly: true }));
  }
  for (const patch of [{ version: 'latest' }, { toolkit: { slug: 'gmail' } }, { slug: 'GITHUB_OTHER' }]) {
    f.setTool({ ...rawTool(), ...patch });
    await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', { ...f.args(), tool_slug: 'GITHUB_PEEK' }, { readOnly: true }));
  }
  f.setTool(rawTool());
  t.mock.method(f.client.tools, 'getRawComposioToolBySlug', async () => { f.revoke(); return rawTool(); });
  await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), /Connection not found/);
  assert.equal(f.calls.length, 0);
});

test('dev refuses a project credential change while metadata is in flight', async t => {
  const f = dev(t);
  t.mock.method(f.client.tools, 'getRawComposioToolBySlug', async () => {
    setEnvOverride('COMPOSIO_API_KEY', `changed-project-${++next}`);
    return rawTool();
  });
  await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), /key changed/);
  assert.equal(f.calls.length, 0);
});

test('dev surfaces provider failures once and preserves unsuccessful SDK envelopes', async t => {
  const f = dev(t);
  f.fail('metadata');
  await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), /Metadata provider failure/);
  assert.equal(f.calls.length, 0);
  f.fail('execute');
  await assert.rejects(executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), /Provider execution failure/);
  assert.equal(f.calls.length, 1);
  t.mock.method(f.client.tools, 'execute', async () => ({ data: { reason: 'permission denied' }, successful: false, error: null }));
  assert.deepEqual(await executeComposio('alice', 'SWARM_APPS_EXECUTE', f.args(), { readOnly: true }), { data: { reason: 'permission denied' }, successful: false, error: null });
});

function gateway(t: any) {
  const row = { id: 'github-alice', tenant_id: 'alice', toolkit: 'github', state: 'active', revision: 3, is_default: true };
  let tool: any = rawTool(), fail = '', onMetadata = () => {};
  const dispatches = new Map<string, string>(), calls: any[] = [];
  const query = async (sql: string, args: any[] = []) => {
    let rows: any[] = [];
    if (sql.includes('SELECT composio_user_id')) rows = [{ composio_user_id: `provider-${args[0]}` }];
    else if (sql.includes('INSERT INTO dispatches')) {
      if (!dispatches.has(args[1])) { dispatches.set(args[1], 'dispatching'); rows = [{ id: args[1] }]; }
    } else if (sql.includes('UPDATE dispatches')) dispatches.set(args[1], args[2]);
    else if (sql.includes('connected_accounts')) {
      const valid = args[0] === row.tenant_id && row.state === 'active' && (args[1] === undefined || args[1] === row.id) && (args[2] === undefined || args[2] === row.revision);
      if (valid) rows = [{ ...row }];
    } else throw new Error(`Unexpected test SQL: ${sql}`);
    return { rows, rowCount: rows.length };
  };
  const directory: any = { pool: { query }, transaction: (fn: any) => fn({ query }) };
  const runtime: any = { verify: async (token: string) => { if (!['alice', 'bob'].includes(token)) throw new Error('revoked'); return { tenant: token }; } };
  const probe = new ComposioProvider('test-project');
  t.mock.method(Object.getPrototypeOf(probe.sdk.connectedAccounts), 'list', async ({ userIds }: any) => ({ items: userIds[0] === 'provider-alice' && row.state === 'active'
    ? [{ id: row.id, status: 'ACTIVE', toolkit: { slug: 'github' } }] : [], nextCursor: null }));
  t.mock.method(Object.getPrototypeOf(probe.sdk.tools), 'getRawComposioToolBySlug', async () => { onMetadata(); if (fail === 'metadata') throw new Error('never-project-secret'); return tool; });
  t.mock.method(Object.getPrototypeOf(probe.sdk.tools), 'getRawComposioTools', async () => [tool, rawTool('COMPOSIO_PROXY_EXECUTE'), { ...rawTool(), toolkit: { slug: 'gmail' } }]);
  t.mock.method(Object.getPrototypeOf(probe.sdk.tools), 'execute', async (...args: any[]) => { calls.push(args); if (fail === 'execute') throw new Error('never-project-secret'); return { data: { repo: 'verified' }, successful: true, error: null }; });
  const app = composioGatewayApp(directory, runtime);
  const input = () => ({ connectionId: row.id, revision: 3, dispatchId: `dispatch_${String(++next).padStart(16, '0')}`, slug: tool.slug, arguments: { owner: 'alice', repo: 'project' }, readOnly: true });
  const rpc = async (operation: string, input: any, user = 'alice') => {
    const response = await app.request('/rpc', { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { row, calls, dispatches, input, rpc, setTool: (value: any) => { tool = value; }, fail: (value: string) => { fail = value; }, onMetadata: (fn: () => void) => { onMetadata = fn; } };
}

test('gateway RPC projects exact discovery metadata and permits attested reads with pinned account identity', async t => {
  const f = gateway(t);
  const discovery = await f.rpc('search', { toolkit: 'github', query: 'verify', connectionId: f.row.id });
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.body, { connectionId: 'github-alice', revision: 3, tools: [{ slug: 'GITHUB_PEEK', description: 'Inspect repository access.', parameters, readOnly: true }] });
  const result = await f.rpc('execute', f.input());
  assert.deepEqual(result, { status: 200, body: { data: { repo: 'verified' }, successful: true, error: null } });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], { userId: 'provider-alice', connectedAccountId: 'github-alice', version: '20261101_00', arguments: { owner: 'alice', repo: 'project' } });
});

test('gateway RPC refuses writes, unknown or conflicting metadata and never reserves a restricted dispatch', async t => {
  const f = gateway(t);
  for (const tags of [undefined, [], ['updateHint'], ['readOnlyHint', 'destructiveHint']]) {
    f.setTool({ ...rawTool('GITHUB_GET_AND_DELETE'), tags });
    const result = await f.rpc('execute', f.input());
    assert.equal(result.status, 400);
    assert.ok(!JSON.stringify(result.body).includes('never-project-secret'));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.dispatches.size, 0);
  const ordinary = await f.rpc('execute', { ...f.input(), readOnly: false });
  assert.equal(ordinary.status, 200);
});

test('gateway RPC retains ownership/revision/tool/identity fences and denies a mid-discovery revocation', async t => {
  const f = gateway(t);
  assert.equal((await f.rpc('execute', f.input(), 'bob')).status, 404);
  assert.equal((await f.rpc('execute', { ...f.input(), revision: 2 })).status, 404);
  for (const patch of [{ slug: 'COMPOSIO_PROXY_EXECUTE' }, { arguments: { connectedAccountId: 'github-bob' } }, { readOnly: 'false' }]) {
    assert.equal((await f.rpc('execute', { ...f.input(), ...patch })).status, 400);
  }
  f.setTool({ ...rawTool(), version: 'latest' });
  assert.equal((await f.rpc('execute', f.input())).status, 400);
  f.setTool({ ...rawTool(), toolkit: { slug: 'gmail' } });
  assert.equal((await f.rpc('execute', f.input())).status, 400);
  f.setTool(rawTool());
  f.onMetadata(() => { f.row.revision++; });
  assert.equal((await f.rpc('execute', f.input())).status, 400);
  assert.equal(f.calls.length, 0);
});

test('gateway RPC hides metadata failures and marks execution failures uncertain without replay', async t => {
  const f = gateway(t);
  f.fail('metadata');
  assert.equal((await f.rpc('execute', f.input())).status, 400);
  assert.equal(f.dispatches.size, 0);
  f.fail('execute');
  const input = f.input();
  const failed = await f.rpc('execute', input);
  assert.deepEqual(failed, { status: 400, body: { error: 'Connected app operation refused.' } });
  assert.equal(f.dispatches.get(input.dispatchId), 'uncertain');
  assert.equal((await f.rpc('execute', input)).status, 400);
  assert.equal(f.calls.length, 1);
});

test('tenant adapter forwards readOnly and returns one SDK envelope rather than nesting data', () => {
  const tenant = 'usr_readonly123';
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ tenantId: tenant, volumeId: 'test-volume' }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    fs.readFile = async () => 'test-runtime';
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      if (request.operation === 'connections') return Response.json([{id:'github-alice',toolkit:'github',status:'ACTIVE',revision:3}]);
      return Response.json(request.operation === 'search' ? {connectionId:'github-alice',revision:3,tools:[]} : {data:{repo:'verified'},successful:false,error:null,logId:'test-log'});
    };
    const {executeComposio,connectedToolkits,connectionsDetail,invalidateComposioSession} = await import('./server/src/composio.ts');
    const args = {connectionId:'github-alice',revision:3,tool_slug:'GITHUB_PEEK',arguments:{}};
    const result = await executeComposio('${tenant}','SWARM_APPS_EXECUTE',args,{readOnly:true});
    assert.deepEqual(result,{data:{repo:'verified'},successful:false,error:null,logId:'test-log'});
    assert.equal(requests[0].input.readOnly,true);
    const search = await executeComposio('${tenant}','SWARM_APPS_SEARCH',{toolkit:'github',query:'verify'});
    assert.equal(search.data.connectionId,'github-alice');
    assert.equal(requests.length,2);
    const [a,b] = await Promise.all([connectedToolkits('${tenant}',true),connectedToolkits('${tenant}',true)]);
    assert.deepEqual([...a],['github']); assert.deepEqual([...b],['github']);
    assert.equal(requests.length,3,'concurrent tenant prompts share a connection snapshot');
    a.clear();
    assert.deepEqual([...await connectedToolkits('${tenant}',true)],['github']);
    await assert.rejects(connectedToolkits('another-tenant',true),/Tenant identity mismatch/);
    assert.equal(requests.length,3);
    await connectionsDetail('${tenant}');
    assert.equal(requests.length,4,'explicit account checks bypass prompt cache');
    invalidateComposioSession('${tenant}');
    await connectedToolkits('${tenant}',true);
    assert.equal(requests.length,5,'connection changes invalidate prompt metadata');
    console.log('tenant envelope verified');
  `;
  const childEnv = { ...process.env, SWARM_ROLE: 'tenant', SWARM_TENANT_ID: tenant, SWARM_VOLUME_ID: 'test-volume',
    TENANT_MANIFEST_FILE: manifest, TENANT_DATA_KEY_FILE: path.join(root, 'unused-key'), DB_PATH: path.join(root, 'tenant.db'),
    COMPOSIO_GATEWAY_URL: 'https://gateway.test', RUNTIME_TOKEN_FILE: '/run/swarm/test-token' };
  for (const name of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'FLY_API_TOKEN', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'INKBOX_ADMIN_API_KEY', 'INKBOX_API_KEY', 'DIRECT_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'APPLE_PRIVATE_KEY']) delete childEnv[name];
  assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8', timeout: 15_000 }), /tenant envelope verified/);
});
