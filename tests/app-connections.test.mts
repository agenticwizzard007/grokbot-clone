import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-app-connections-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'app-connections-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0' });
let services: any[] = [], catalogFailure = false;
let catalogRequests: string[] = [];
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  assert.equal(url.hostname, 'backend.composio.dev', 'No real network calls are permitted');
  assert.equal(url.pathname, '/api/v3.1/toolkits');
  catalogRequests.push(url.href);
  if (catalogFailure) throw new Error('SECRET provider bearer credential https://oauth.example.com/private');
  const offset = Number(url.searchParams.get('cursor') ?? 0);
  return Response.json({ items: services.slice(offset, offset + 500), next_cursor: offset + 500 < services.length ? String(offset + 500) : null });
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio } = await import('../server/src/composio.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, clearConversation, getRow, listRows } = await import('../server/src/store.js');
const { systemPrompt } = await import('../server/src/agent/prompt.js');
const { APP_CONNECTION_TOOLS, requestAppConnection } = await import('../server/src/agent/app-connections.js');
for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
let primary: any, draft: any, foreign: any, client: any, accountFailure = false, sequence = 0;
let accounts: Record<string, any[]> = {}, accountQueries: any[] = [], authorizations = 0;
const service = (slug: string, name = slug, categories = ['Code']) => ({ slug, name, meta: { description: `${name} service`, categories: categories.map(name => ({ name })), logo: `https://static.example.com/${slug}.svg` }, composio_managed_auth_schemes: ['OAUTH2'], secret: 'CATALOG-SECRET' });
const account = (id: string, toolkit = 'github', status = 'ACTIVE') => ({ id, toolkit: { slug: toolkit }, status, data: { access_token: 'ACCOUNT-SECRET' }, metadata: { client_secret: 'PRIVATE' } });
beforeEach(() => {
  db.exec('DELETE FROM bots');
  primary = createBot('owner', { name: 'Chief', isPrimary: true });
  draft = createBot('owner', { name: 'Repository helper' });
  foreign = createBot('other', { name: 'Foreign chief', isPrimary: true });
  services = [service('github', 'GitHub'), service('gmail', 'Gmail', ['Email'])];
  catalogRequests = []; catalogFailure = false; accountFailure = false; accounts = {}; accountQueries = []; authorizations = 0;
  setEnvOverride('COMPOSIO_API_KEY', `local-sdk-key-${++sequence}`);
  client = composio();
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    accountQueries.push(query);
    assert.equal(query.accountType, 'PRIVATE'); assert.equal(query.userIds.length, 1);
    if (accountFailure) throw new Error('SECRET SDK token https://oauth.example.com/secret');
    const all = accounts[query.userIds[0]] ?? [], offset = Number(query.cursor ?? 0);
    return { items: all.slice(offset, offset + 100), nextCursor: offset + 100 < all.length ? String(offset + 100) : null };
  });
  mock.method(client, 'create', async () => { authorizations++; throw new Error('Native helpers must not start OAuth'); });
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const context = (botId = draft.id, userId = 'owner', jobId: string | undefined = 'job-current') => ({
  botId, userId, jobId, depth: 0, enqueueBotMessage: () => { throw new Error('Must not enqueue a task'); },
});
async function run(name: string, args: unknown = {}, ctx = context()) {
  const tool = APP_CONNECTION_TOOLS.find(tool => tool.name === name)!;
  assert.ok(tool); const response = await tool.impl(args, ctx);
  assert.equal(typeof response.output, 'string');
  return { response, data: JSON.parse(response.output as string) };
}
const cards = (botId = draft.id) => listRows(botId).filter(row => row.body.type === 'card' && row.body.card === 'connect');

test('exports shared text/voice definitions with strict bounded schemas', () => {
  assert.deepEqual(APP_CONNECTION_TOOLS.map(tool => tool.name), ['list_app_connections', 'search_apps', 'request_app_connection']);
  for (const tool of APP_CONNECTION_TOOLS) {
    assert.ok(tool.description); assert.equal(tool.activity, 'connecting_service'); assert.ok(tool.label);
    assert.equal(tool.parameters.type, 'object'); assert.equal(tool.parameters.additionalProperties, false); assert.equal(typeof tool.impl, 'function');
  }
  const search = APP_CONNECTION_TOOLS.find(tool => tool.name === 'search_apps')!.parameters as any;
  assert.equal(search.properties.limit.maximum, 100); assert.equal(search.properties.limit.default, 20);
  assert.equal(search.properties.offset.minimum, 0);
  const request = APP_CONNECTION_TOOLS.find(tool => tool.name === 'request_app_connection')!.parameters as any;
  assert.deepEqual(request.required, ['toolkit', 'reason']);
});

test('lists every private owned account across pages with revisions/status and no credential data', async () => {
  accounts.owner = Array.from({ length: 205 }, (_, i) => account(`own-${i}`, i % 2 ? 'gmail' : 'github', i % 3 ? 'ACTIVE' : 'EXPIRED'));
  accounts.other = [account('foreign-account')];
  const { data } = await run('list_app_connections');
  assert.equal(data.ok, true); assert.equal(data.available, true); assert.equal(data.connections.length, 205);
  assert.equal(new Set(data.connections.map((connection: any) => connection.id)).size, 205);
  assert.ok(data.connections.every((connection: any) => connection.revision === 1 && typeof connection.status === 'string'));
  assert.ok(data.connections.some((connection: any) => connection.status === 'EXPIRED'));
  assert.equal(accountQueries.length, 3); assert.ok(accountQueries.every(query => query.userIds[0] === 'owner'));
  assert.doesNotMatch(JSON.stringify(data), /SECRET|PRIVATE|foreign-account|access_token|local-sdk-key/);
  assert.equal(catalogRequests.length, 0, 'Connection listing does not depend on the service catalog');
});

test('an available empty list differs from disabled and failed provider lookups', async () => {
  const empty = (await run('list_app_connections')).data;
  assert.equal(empty.ok, true); assert.equal(empty.available, true); assert.equal(empty.status, 'none'); assert.deepEqual(empty.connections, []);
  accountFailure = true;
  const failed = (await run('list_app_connections')).data;
  assert.equal(failed.ok, false); assert.equal(failed.available, false); assert.equal(failed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|oauth\.example/);
  setEnvOverride('COMPOSIO_API_KEY', '');
  const calls = accountQueries.length;
  for (const [name, args] of [['list_app_connections', {}], ['search_apps', {}], ['request_app_connection', { toolkit: 'github', reason: 'Validate access' }]] as const) {
    assert.equal((await run(name, args)).data.status, 'unavailable');
  }
  assert.equal(accountQueries.length, calls); assert.equal(cards().length, 0);
});

test('validates actor ownership before reading private connections or creating any card', async () => {
  for (const botId of [foreign.id, 'missing']) {
    for (const [name, args] of [['list_app_connections', {}], ['search_apps', {}], ['request_app_connection', { toolkit: 'github', reason: 'Access' }]] as const) {
      assert.equal((await run(name, args, context(botId))).data.status, 'not_found');
    }
  }
  assert.equal(accountQueries.length, 0); assert.equal(catalogRequests.length, 0); assert.equal(cards().length, 0);
  accounts.other = [account('other-owned')];
  const ownForeign = await run('list_app_connections', {}, context(foreign.id, 'other'));
  assert.equal(ownForeign.data.connections[0].id, 'other-owned');
  assert.equal(accountQueries[0].userIds[0], 'other');
});

test('search enumerates all provider catalog pages before filtering and bounding results', async () => {
  services = Array.from({ length: 1723 }, (_, i) => service(`app${i}`, `Service ${i}`, [i % 2 ? 'Code' : 'Email']));
  const first = (await run('search_apps')).data;
  assert.equal(catalogRequests.length, 4); assert.equal(first.total, 1723); assert.equal(first.apps.length, 20); assert.equal(first.nextOffset, 20);
  const last = (await run('search_apps', { query: 'APP1722', offset: 0, limit: 1 })).data;
  assert.equal(last.total, 1); assert.equal(last.apps[0].slug, 'app1722'); assert.equal(last.nextOffset, null);
  const category = (await run('search_apps', { query: 'code', offset: 10, limit: 3 })).data;
  assert.equal(category.total, 861); assert.equal(category.apps.length, 3); assert.equal(category.nextOffset, 13);
  assert.ok(category.apps.every((app: any) => app.categories.includes('Code')));
  const end = (await run('search_apps', { offset: 9999, limit: 100 })).data;
  assert.deepEqual(end.apps, []); assert.equal(end.nextOffset, null);
  assert.doesNotMatch(JSON.stringify(first), /CATALOG-SECRET/);
  assert.equal(catalogRequests.length, 4, 'Uses the canonical credential-bound catalog cache');
});

test('bad schemas cannot choose another owner, start OAuth or request an unbounded catalog', async () => {
  for (const [name, args] of [
    ['list_app_connections', { userId: 'other' }], ['list_app_connections', null],
    ['search_apps', { limit: 101 }], ['search_apps', { limit: 0 }], ['search_apps', { limit: 1.5 }],
    ['search_apps', { offset: -1 }], ['search_apps', { offset: Infinity }], ['search_apps', { query: 'x'.repeat(301) }],
    ['request_app_connection', { toolkit: '../github', reason: 'Access' }], ['request_app_connection', { toolkit: 'github', reason: '' }],
    ['request_app_connection', { toolkit: 'github', reason: 'Access', callbackUrl: 'https://evil.example.com' }],
    ['request_app_connection', { toolkit: 'github', reason: 'Access', connectionId: 'foreign' }],
  ] as const) assert.equal((await run(name, args)).data.status, 'invalid_request');
  assert.equal(catalogRequests.length, 0); assert.equal(accountQueries.length, 0); assert.equal(cards().length, 0); assert.equal(authorizations, 0);
});

test('existing ACTIVE private account returns directly without a connect card or OAuth request', async () => {
  accounts.owner = [account('active-github'), account('expired-github', 'github', 'EXPIRED')];
  accounts.other = [account('foreign-active')];
  const { data, response } = await run('request_app_connection', { toolkit: ' GitHub ', reason: 'Verify repository scope' });
  assert.equal(data.ok, true); assert.equal(data.status, 'connected'); assert.equal(data.connection.id, 'active-github');
  assert.equal(data.connection.revision, 1); assert.equal(data.connectionRequest, undefined); assert.equal(response.endTurn, undefined);
  assert.equal(cards().length, 0); assert.equal(authorizations, 0); assert.doesNotMatch(JSON.stringify(data), /SECRET|foreign-active|redirectUrl/);
});

test('multiple active private accounts remain explicit rather than choosing one silently', async () => {
  accounts.owner = [account('work'), account('personal')];
  const { data } = await run('request_app_connection', { toolkit: 'github', reason: 'Access a repository' });
  assert.equal(data.status, 'connected'); assert.equal(data.connection, undefined);
  assert.deepEqual(data.connections.map((connection: any) => connection.id), ['work', 'personal']);
  assert.match(data.note, /exact account ID/); assert.equal(cards().length, 0); assert.equal(authorizations, 0);
});

test('request helper creates/reuses a native pending card and preserves its durable job lineage', async () => {
  accounts.owner = [account('not-active', 'github', 'INITIATED')];
  const first = await requestAppConnection({ toolkit: 'github', reason: 'Verify the chosen repository' }, context());
  const data = JSON.parse(first.output as string);
  assert.equal(data.status, 'pending'); assert.equal(first.endTurn, true);
  assert.deepEqual(first.connectionRequest, data.connectionRequest);
  assert.deepEqual(data.connectionRequest, { botId: draft.id, seq: data.connectionRequest.seq, toolkit: 'github', toolkitName: 'GitHub' });
  const row = getRow(draft.id, data.connectionRequest.seq)!;
  assert.equal((row.body as any).jobId, 'job-current'); assert.equal((row.body as any).status, 'pending');
  const reused = await run('request_app_connection', { toolkit: 'github', reason: 'Check access' }, context(draft.id, 'owner', 'new-job'));
  assert.equal(reused.data.connectionRequest.seq, row.seq); assert.equal(cards().length, 1);
  assert.equal((getRow(draft.id, row.seq)!.body as any).jobId, 'job-current');
  assert.equal(authorizations, 0); assert.doesNotMatch(first.output as string, /redirectUrl|oauth\.example|access_token/);
});

test('a legacy pending card adopts the current job without replacing the card', async () => {
  const existing = appendRow(draft.id, 'card', { type: 'card', card: 'connect', toolkit: 'github', toolkitName: 'GitHub', reason: 'Access', status: 'pending' });
  const { data } = await run('request_app_connection', { toolkit: 'github', reason: 'Verify access' });
  assert.equal(data.connectionRequest.seq, existing.seq); assert.equal(cards().length, 1);
  assert.equal((getRow(draft.id, existing.seq)!.body as any).jobId, 'job-current');
});

test('connect-card reuse is scoped to this bot and generation and ignores completed cards', async () => {
  const card = { type: 'card', card: 'connect', toolkit: 'github', toolkitName: 'GitHub', reason: 'Access', status: 'pending' } as const;
  appendRow(foreign.id, 'card', card); appendRow(primary.id, 'card', card); appendRow(draft.id, 'card', card);
  clearConversation(draft.id);
  appendRow(draft.id, 'card', { ...card, status: 'connected' });
  const { data } = await run('request_app_connection', { toolkit: 'github', reason: 'Verify own access' });
  assert.equal(cards().length, 2); assert.equal(data.connectionRequest.botId, draft.id);
  assert.equal((getRow(draft.id, data.connectionRequest.seq)!.body as any).status, 'pending');
  assert.equal(cards(foreign.id).length, 1); assert.equal(cards(primary.id).length, 1);
});

test('overlapping requests reuse one pending card without starting OAuth', async () => {
  const requests = await Promise.all(Array.from({ length: 4 }, () => run('request_app_connection', { toolkit: 'github', reason: 'Check repository scope' })));
  assert.equal(new Set(requests.map(request => request.data.connectionRequest.seq)).size, 1);
  assert.equal(cards().length, 1); assert.equal(authorizations, 0);
});

test('unknown services and provider failures never create a card or expose raw errors', async () => {
  assert.equal((await run('request_app_connection', { toolkit: 'not_a_real_service', reason: 'Access' })).data.status, 'unknown_toolkit');
  accountFailure = true;
  const failed = await run('request_app_connection', { toolkit: 'github', reason: 'Access' });
  assert.equal(failed.data.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(failed), /SECRET|oauth\.example/);
  assert.equal(cards().length, 0); assert.equal(authorizations, 0);
});

test('catalog lookup failures differ from an available empty search and are sanitized', async () => {
  catalogFailure = true;
  const failed = (await run('search_apps', { query: 'github' })).data;
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.available, false);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|bearer|oauth\.example/);
  catalogFailure = false; services = [];
  const empty = (await run('search_apps')).data;
  assert.equal(empty.available, true); assert.equal(empty.total, 0); assert.deepEqual(empty.apps, []); assert.equal(empty.nextOffset, null);
});

test('public services still request the private account required by the app executor', async () => {
  services.push({ ...service('public_service', 'Public service'), no_auth: true });
  services.push(service('1password', '1Password'));
  const { data } = await run('request_app_connection', { toolkit: 'public_service', reason: 'Read public information' });
  assert.equal(data.ok, true); assert.equal(data.status, 'pending'); assert.equal(cards().length, 1); assert.equal(authorizations, 0);
  const numericSlug = await run('request_app_connection', { toolkit: '1password', reason: 'Verify the requested resource scope' });
  assert.equal(numericSlug.data.connectionRequest.toolkit, '1password');
});

test('a conversation change during provider discovery fails closed before saving a card', async () => {
  let release!: () => void, queried!: () => void;
  const started = new Promise<void>(resolve => { queried = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  mock.method(client.connectedAccounts, 'list', async () => { queried(); await held; return { items: [] }; });
  const request = run('request_app_connection', { toolkit: 'github', reason: 'Access' });
  await started; clearConversation(draft.id); release();
  const { data } = await request;
  assert.equal(data.status, 'unavailable'); assert.equal(cards().length, 0);
});

test('setup and active prompts teach native connections and verified read-only setup bounds', async () => {
  const setup = await systemPrompt('owner', draft.id);
  for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(setup.includes(name));
  assert.match(setup, /provider-verified read-only/); assert.match(setup, /repository scope/);
  assert.match(setup, /do not create or start routines before/i); assert.match(setup, /does not activate the agent/);
  assert.doesNotMatch(setup, /You have only ask_user|COMPOSIO_SEARCH_TOOLS|COMPOSIO_MULTI_EXECUTE_TOOL/);
  const active = await systemPrompt('owner', primary.id);
  assert.match(active, /list_app_connections/); assert.match(active, /SWARM_APPS_SEARCH/); assert.match(active, /SWARM_APPS_EXECUTE/);
  assert.doesNotMatch(active, /COMPOSIO_SEARCH_TOOLS|COMPOSIO_MULTI_EXECUTE_TOOL/);
});
