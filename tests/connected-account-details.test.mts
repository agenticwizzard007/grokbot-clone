import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionStatus, connectedDate, createConnectionDetailsCache } from '../server/src/connection-details.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-details-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'app.db'),
  FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'details-test-only', COMPOSIO_API_KEY: '',
  COMPOSIO_ORG_ID: '', COMPOSIO_PROJECT_ID: '', COMPUTER_PROVIDER: 'local', APP_URL: 'http://localhost:3000' });
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname === '/api/v3.1/toolkits') return Response.json({ items: [
    { slug: 'gmail', name: 'Gmail', meta: { categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] },
    { slug: 'github', name: 'GitHub', meta: { categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] },
  ] });
  throw new Error('External request blocked by account details fixture');
});
const { db } = await import('../server/src/db.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio, connectionsDetail, connectedToolkits, invalidateComposioSession } = await import('../server/src/composio.js');
const { Hono } = await import('hono');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, 'Test account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
const createdAt = '2026-11-21T09:30:00.000Z';
const account = (id: string, extra = {}) => ({ id, toolkit: { slug: 'gmail' }, status: 'ACTIVE', createdAt, ...extra });
let accounts: any[], client: ReturnType<typeof composio>, retrieves: string[], profiles: string[], project = 0;
beforeEach(() => {
  setEnvOverride('COMPOSIO_API_KEY', `details-fixture-${++project}`);
  client = composio(); accounts = []; retrieves = []; profiles = [];
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    assert.equal(query.accountType, 'PRIVATE');
    assert.equal(query.userIds.length, 1);
    return { items: query.userIds[0] === 'owner' ? structuredClone(accounts) : [], nextCursor: null };
  });
  mock.method(client.connectedAccounts, 'get', async (id: string) => { retrieves.push(id); return accounts.find(a => a.id === id); });
  mock.method(client.toolkits, 'get', async () => ({}));
  mock.method(client.tools, 'proxyExecute', async (input: any) => {
    assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    assert.equal(input.method, 'GET');
    profiles.push(input.connectedAccountId);
    return { status: 200, data: { emailAddress: 'profile@gmail.com' } };
  });
  mock.method(client.connectedAccounts, 'delete', async () => { throw new Error('Account mutations forbidden'); });
  mock.method(client.tools, 'execute', async () => { throw new Error('Tool execution forbidden'); });
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const request = (url: string, owner = 'owner') => app.request(`/api${url}`, { headers: { cookie: `swarm_session=${owner}` } });
const details = () => connectionsDetail('owner', { details: true });

test('maps provider states without treating expired, disabled or unfinished authorization as active', () => {
  for (const raw of ['ACTIVE', 'CONNECTED']) assert.equal(connectionStatus(raw), 'active');
  for (const raw of ['EXPIRED', 'REVOKED', 'INACTIVE', 'DISABLED', 'NEEDS_REAUTH']) assert.equal(connectionStatus(raw), 'needs_reauth');
  for (const raw of ['FAILED', 'ERROR']) assert.equal(connectionStatus(raw), 'failed');
  for (const raw of ['INITIATED', 'INITIALIZING', 'INITIATING', 'PENDING']) assert.equal(connectionStatus(raw), 'pending');
  assert.equal(connectionStatus('ACTIVE', true), 'needs_reauth');
  assert.equal(connectionStatus('NEW_PROVIDER_STATE'), 'unknown');
  assert.equal(connectedDate(createdAt), 'Connected 21 Nov 2026');
});

test('both listing APIs include email, mapped status and actual connect date for every account', async () => {
  accounts = [account('ca_primary', { data: { email: 'name@gmail.com', access_token: 'fixture-private-value' } }),
    account('ca_secondary', { data: { email: 'second@gmail.com' }, createdAt: '2026-11-20T11:00:00Z' }),
    account('ca_expired', { status: 'EXPIRED', data: { email: 'expired@gmail.com' } }),
    account('ca_failed', { status: 'FAILED', data: { email: 'failed@gmail.com' } })];
  const response = await request('/apps/connections');
  assert.equal(response.status, 200);
  const payload: any = await response.json();
  assert.deepEqual(payload.connections.map((a: any) => [a.id, a.accountLabel, a.displayStatus, a.connectedAt]), [
    ['ca_primary', 'name@gmail.com', 'active', createdAt],
    ['ca_secondary', 'second@gmail.com', 'active', '2026-11-20T11:00:00.000Z'],
    ['ca_expired', 'expired@gmail.com', 'needs_reauth', createdAt],
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /access_token|fixture-private-value/);
  const catalog: any = await (await request('/apps')).json();
  assert.equal(catalog.connectedApps[0].name, 'Gmail');
  assert.deepEqual(catalog.connectedApps[0].accounts, payload.connections);
  assert.deepEqual(catalog.apps.find((a: any) => a.slug === 'gmail').accounts, payload.connections);
  assert.deepEqual(retrieves, []); assert.deepEqual(profiles, []);
  assert.deepEqual(await (await request('/apps/connections', 'other')).json(), { connections: [] });
});

test('Gmail falls back to users.getProfile emailAddress and caches the identity between list loads', async () => {
  accounts = [account('ca_profile')];
  const [first, second] = await Promise.all([details(), details()]);
  assert.equal(first[0].accountLabel, 'profile@gmail.com');
  assert.deepEqual(first, second);
  await details();
  assert.deepEqual(retrieves, ['ca_profile']); assert.deepEqual(profiles, ['ca_profile']);
  // Raw status must refresh even when the display label is warm.
  accounts[0].status = 'EXPIRED';
  assert.equal((await details())[0].displayStatus, 'needs_reauth');
  assert.deepEqual([...await connectedToolkits('owner')], []);
  assert.deepEqual(profiles, ['ca_profile']);
});

test('uses connected account retrieval before Gmail profile and preserves the actual creation timestamp', async () => {
  accounts = [account('ca_lookup', { createdAt: undefined })];
  mock.method(client.connectedAccounts, 'get', async () => ({ data: { email: 'retrieved@gmail.com' }, createdAt }));
  const [result] = await details();
  assert.equal(result.accountLabel, 'retrieved@gmail.com'); assert.equal(result.connectedAt, createdAt);
  assert.deepEqual(profiles, []);
});

test('missing identifiers and failed Gmail profile reads produce a nonblank shortened-id fallback', async () => {
  accounts = [account('ca_C3Ru123456789', { toolkit: { slug: 'github' } }), account('ca_Gmail12345678')];
  mock.method(client.tools, 'proxyExecute', async () => { throw new Error('Provider unavailable'); });
  const result = await details();
  assert.equal(result[0].accountLabel, 'Connected account ca_C3Ru12...');
  assert.equal(result[1].accountLabel, 'Connected account ca_Gmail1...');
  assert.ok(result.every(a => a.connectedAt === createdAt && a.displayStatus === 'active'));
});

test('other apps use a profile identifier and missing dates are explicit, never invented', async () => {
  accounts = [account('ca_username', { toolkit: { slug: 'github' }, data: { username: 'fixture-team' }, createdAt: 'invalid' })];
  const [result] = await details();
  assert.equal(result.accountLabel, 'fixture-team'); assert.equal(result.connectedAt, null);
  assert.equal(connectedDate(result.connectedAt), 'Connected date unavailable');
});

test('successful connect callback refreshes metadata even when cached', async () => {
  accounts = [account('ca_callback')];
  await details();
  mock.method(client.tools, 'proxyExecute', async () => { profiles.push('refreshed'); return { status: 200, data: { emailAddress: 'refreshed@gmail.com' } }; });
  assert.equal((await request('/apps/callback?slug=gmail')).status, 200);
  assert.equal((await details())[0].accountLabel, 'refreshed@gmail.com');
  assert.deepEqual(profiles, ['ca_callback', 'refreshed']);
});

test('cache retries stale metadata and isolates users, project changes and invalidation', async () => {
  const cache = createConnectionDetailsCache(), item = account('ca_scoped');
  await cache.details(client, 'owner', item);
  await cache.details(client, 'other', item);
  assert.equal(profiles.length, 2);
  const time = Date.now();
  const clock = mock.method(Date, 'now', () => time + 301_000);
  try { await cache.details(client, 'owner', item); } finally { clock.mock.restore(); }
  assert.equal(profiles.length, 3);
  accounts = [item]; await details();
  invalidateComposioSession('owner'); await details();
  assert.equal(profiles.length, 5);
  setEnvOverride('COMPOSIO_API_KEY', 'details-new-project');
  const next = composio();
  mock.method(next.connectedAccounts, 'list', async () => ({ items: [account('ca_scoped', { data: { email: 'project@gmail.com' } })] }));
  assert.equal((await details())[0].accountLabel, 'project@gmail.com');
});

test('tenant display lists include inactive account details without authorizing their use', async () => {
  const { ComposioProvider } = await import('../server/src/platform/composio-service.js');
  const { ConnectionGateway } = await import('../server/src/platform/composio-policy.js');
  const provider = new ComposioProvider('tenant-details-fixture');
  const remote = [account('registered', { state: { val: { email: 'tenant@gmail.com' } } }),
    account('expired', { status: 'EXPIRED', data: { email: 'expired@gmail.com' } }),
    account('failed', { status: 'FAILED', data: { email: 'failed@gmail.com' } }),
    account('disabled', { isDisabled: true, data: { email: 'disabled@gmail.com' } }),
    account('unregistered', { data: { email: 'unregistered@gmail.com' } })];
  mock.method(provider.sdk.connectedAccounts, 'list', async (query: any) => {
    assert.deepEqual(query.userIds, ['provider-owner']); assert.equal(query.accountType, 'PRIVATE');
    return { items: remote, nextCursor: null };
  });
  const rows = remote.slice(0, 4).map(a => ({ id: a.id, tenant: 'owner', toolkit: 'gmail', revision: 1, state: 'active', isDefault: false }));
  const registry = {
    identity: async () => 'provider-owner', list: async () => rows,
    get: async (tenant: string, id: string) => rows.find(r => r.id === id && r.tenant === tenant),
    revoke: async () => { throw new Error('Mutations forbidden'); }, begin: async () => false, finish: async () => {},
  };
  const gateway = new ConnectionGateway(registry, provider);
  assert.deepEqual((await gateway.list('owner')).map(a => a.id), ['registered']);
  const visible = await gateway.list('owner', true);
  assert.deepEqual(visible.map(a => [a.id, a.accountLabel, a.displayStatus, a.connectedAt]), [
    ['registered', 'tenant@gmail.com', 'active', createdAt],
    ['expired', 'expired@gmail.com', 'needs_reauth', createdAt],
    ['failed', 'failed@gmail.com', 'failed', createdAt],
    ['disabled', 'disabled@gmail.com', 'needs_reauth', createdAt],
  ]);
  for (const id of ['expired', 'failed', 'disabled', 'unregistered']) await assert.rejects(gateway.own('owner', id), /Connection not found/);
  assert.deepEqual(await gateway.list('other', true), []);
});

test('messaging apps command lists each account with its identity, status and date using an in-memory adapter', async () => {
  const { registerAdapter, handleInbound } = await import('../server/src/messaging/bridge.js');
  const { upsertLink } = await import('../server/src/messaging/store.js');
  accounts = [account('ca_text_first', { data: { email: 'name@gmail.com' } }),
    account('ca_text_second', { status: 'EXPIRED', data: { email: 'second@gmail.com' } })];
  let received!: (text: string) => void;
  const delivered = new Promise<string>(resolve => { received = resolve; });
  registerAdapter({ transport: 'inkbox', ready: () => true, format: text => text, maxChars: () => 10000,
    send: async (_link, message) => { received(message.text ?? ''); return 'fixture-message'; } });
  upsertLink('owner', 'imessage', 'inkbox', { status: 'connected', chatRef: 'fixture-thread' });
  await handleInbound({ userId: 'owner', channel: 'imessage', waId: 'fixture-inbound', text: '/apps' });
  const text = await delivered;
  assert.match(text, /Gmail: name@gmail.com\n\s+Active · Connected 21 Nov 2026/);
  assert.match(text, /Gmail: second@gmail.com\n\s+Needs reconnecting/);
});
