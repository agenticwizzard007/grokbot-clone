import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { connectionIdentity, createConnectionDetailsCache, visibleConnections, connectionStatusLabel } from '../server/src/connection-details.js';
import { createCatalogCache } from '../server/src/catalog-cache.js';
import { createSettingsCache, settingsRead } from '../web/src/lib/settingsReads.js';
import { Composio } from '@composio/core';
import { toolkitLogo } from '../web/src/lib/toolkitLogos.js';

const fixture = (slug = 'gmail', extra = {}) => ({ id: 'ca_fixture', toolkit: { slug }, status: 'ACTIVE', createdAt: '2026-11-19T10:00:00Z', ...extra });
const sdk = (profile: any = { emailAddress: 'fixture@example.test' }) => ({
  connectedAccounts: { get: async () => fixture() },
  toolkits: { get: async () => ({}) },
  tools: { proxyExecute: async (args: any) => { assert.equal(args.method, 'GET'); assert.equal(args.connectedAccountId, 'ca_fixture'); assert.equal(args.userId, 'owner'); return { status: 200, data: profile }; } },
}) as any;

test('Gmail parses current SDK OAUTH2 state.val.displayName and legacy nested identity fields', () => {
  for (const payload of [
    { state: { authScheme: 'OAUTH2', val: { status: 'ACTIVE', displayName: 'fixture@example.test', access_token: 'SECRET' } } },
    { data: { connectionParams: { member: { email: 'fixture@example.test' } } } },
    { params: { profile: { emailAddress: 'fixture@example.test' } } },
    { connection_params: { user: { email_address: 'fixture@example.test' } } },
  ]) assert.equal(connectionIdentity(payload, 'gmail'), 'fixture@example.test');
  assert.equal(connectionIdentity({ state: { val: { displayName: 'Person', access_token: 'SECRET' } }, userId: 'app-user' }, 'gmail'), undefined);
});

test('installed Composio SDK preserves Gmail displayName from a realistic raw connected account', async () => {
  const fetch = mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
    if (url.hostname === 'telemetry.composio.dev') return Response.json({});
    assert.equal(url.hostname, 'backend.composio.dev');
    assert.ok(url.pathname.endsWith('/connected_accounts/ca_fixture'));
    return Response.json({ id: 'ca_fixture', toolkit: { slug: 'gmail' },
      auth_config: { id: 'ac_fixture', auth_scheme: 'OAUTH2', is_composio_managed: true, is_disabled: false },
      status: 'ACTIVE', status_reason: null, is_disabled: false,
      created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z',
      state: { authScheme: 'OAUTH2', val: { status: 'ACTIVE', access_token: 'fixture-only', displayName: 'sdk@example.test', scope: 'openid email profile' } },
    });
  });
  try {
    const client = new Composio({ apiKey: 'fixture-only' });
    const account = await client.connectedAccounts.get('ca_fixture');
    assert.equal(connectionIdentity(account, 'gmail'), 'sdk@example.test');
    assert.equal(account.createdAt, '2026-11-19T10:00:00Z');
  } finally { fetch.mock.restore(); }
});

test('Slack parses OAuth team and authed user, auth.test response, and nested member profiles', () => {
  assert.equal(connectionIdentity({ state: { val: { team: { name: 'Fixture workspace' }, authed_user: { profile: { display_name: 'Riley' } } } } }, 'slack'), 'Fixture workspace · Riley');
  assert.equal(connectionIdentity({ ok: true, team: 'Fixture workspace', user: 'riley', user_id: 'U123', team_id: 'T123' }, 'slack'), 'Fixture workspace · riley');
  assert.equal(connectionIdentity({ connectionParams: { workspace_name: 'Fixture workspace', member: { profile: { email: 'riley@example.test' } } } }, 'slack'), 'Fixture workspace · riley@example.test');
});

test('GitHub login, Notion workspace, Drive and Calendar emails are toolkit-specific', () => {
  assert.equal(connectionIdentity({ login: 'fixture-login', name: 'Person', email: 'person@example.test' }, 'github'), 'fixture-login');
  assert.equal(connectionIdentity({ bot: { workspace_name: 'Fixture notes', owner: { user: { person: { email: 'riley@example.test' } } } } }, 'notion'), 'Fixture notes');
  for (const slug of ['googledrive', 'googlecalendar', 'googledocs', 'googlesheets']) assert.equal(connectionIdentity({ user: { emailAddress: 'riley@example.test' } }, slug), 'riley@example.test');
});

test('identity lookup uses toolkit current-user endpoint and exact owner/account with read-only GET', async () => {
  const client = sdk({ email: 'userinfo@example.test' });
  client.toolkits.get = async () => ({ getCurrentUserEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo', getCurrentUserEndpointMethod: 'GET' });
  let endpoint: string | undefined;
  const proxy = client.tools.proxyExecute;
  client.tools.proxyExecute = async (args: any) => { endpoint = args.endpoint; return proxy(args); };
  const result = await createConnectionDetailsCache().details(client, 'owner', fixture());
  assert.equal(result.accountLabel, 'userinfo@example.test');
  assert.equal(endpoint, 'https://openidconnect.googleapis.com/v1/userinfo');
});

test('Slack enriches SDK workspace-only state with auth.test user and keeps the richer cached label', async () => {
  const item = fixture('slack', { state: { authScheme: 'OAUTH2', val: { status: 'ACTIVE', team: { name: 'Fixture workspace' }, authed_user: { scope: 'identity.basic' } } } });
  const client = sdk({ ok: true, team: 'Fixture workspace', user: 'riley' });
  const cache = createConnectionDetailsCache();
  assert.equal((await cache.details(client, 'owner', item)).accountLabel, 'Fixture workspace · riley');
  assert.equal((await cache.details(client, 'owner', item)).accountLabel, 'Fixture workspace · riley');
});

test('Gmail insufficient profile scope falls back to OAuth userinfo email', async () => {
  const client = sdk(); const endpoints: string[] = [];
  client.tools.proxyExecute = async (args: any) => {
    assert.equal(args.method, 'GET'); endpoints.push(args.endpoint);
    return endpoints.length === 1 ? { status: 403, data: {} } : { status: 200, data: { email: 'oauth@example.test' } };
  };
  assert.equal((await createConnectionDetailsCache().details(client, 'owner', fixture())).accountLabel, 'oauth@example.test');
  assert.deepEqual(endpoints, ['https://gmail.googleapis.com/gmail/v1/users/me/profile', 'https://openidconnect.googleapis.com/v1/userinfo']);
});

test('identity cache deduplicates reads and preserves last good label through invalidation and failures', async () => {
  const client = sdk(); const cache = createConnectionDetailsCache(); let reads = 0;
  const original = client.tools.proxyExecute;
  client.tools.proxyExecute = async (args: any) => { reads++; return original(args); };
  const both = await Promise.all([cache.details(client, 'owner', fixture()), cache.details(client, 'owner', fixture())]);
  assert.equal(reads, 1); assert.equal(both[0].accountLabel, both[1].accountLabel);
  cache.invalidate('owner');
  client.tools.proxyExecute = async () => { throw new Error('SECRET must never be logged'); };
  const messages: string[] = []; const logger = mock.method(console, 'warn', (...args) => messages.push(JSON.stringify(args)));
  try {
    assert.equal((await cache.details(client, 'owner', fixture())).accountLabel, 'fixture@example.test');
    assert.equal((await cache.details(client, 'other', fixture())).accountLabel, 'Connected account ca_fixture');
    assert.ok(messages.some(line => line.includes('request_failed')));
    assert.doesNotMatch(messages.join(''), /SECRET|fixture@example.test/);
  } finally { logger.mock.restore(); }
});

test('pending, initiated, failed and unfinished expired records stay hidden; active first with no duplicate IDs', () => {
  const rows = ['EXPIRED', 'INITIATED', 'PENDING', 'AWAITING_AUTHORIZATION', 'FAILED', 'ACTIVE'].map(status => ({ id: status, status }));
  rows.push({ id: 'ACTIVE', status: 'EXPIRED' });
  const result = visibleConnections([...rows, { id: 'disabled-pending', status: 'INITIATED', isDisabled: true }, { id: 'unfinished', status: 'EXPIRED', authorizationIncomplete: true }]);
  assert.deepEqual(result.map(a => a.id), ['ACTIVE', 'EXPIRED']);
  assert.equal(connectionStatusLabel('needs_reauth'), 'Needs reconnecting');
});

test('catalog TTL serves stale metadata immediately and shares refreshes, with scope isolation', async () => {
  const cache = createCatalogCache<string[]>(100); let count = 0; let finish!: (value: string[]) => void;
  const load = async () => { count++; return ['gmail']; };
  assert.deepEqual(await Promise.all([cache.get('project', load), cache.get('project', load)]), [['gmail'], ['gmail']]);
  assert.equal(count, 1);
  const now = Date.now(); const clock = mock.method(Date, 'now', () => now + 101);
  try {
    assert.deepEqual(await cache.get('project', () => new Promise(resolve => { finish = resolve; })), ['gmail']);
    assert.deepEqual(await cache.get('project', load), ['gmail']);
    finish(['gmail', 'slack']); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await cache.get('project', load), ['gmail', 'slack']);
    assert.deepEqual(await cache.get('other', async () => ['notion']), ['notion']);
  } finally { clock.mock.restore(); }
});

test('client cached values are synchronous, coalesce reads and never cross account changes', async () => {
  const cache = createSettingsCache<string[]>(); cache.scope('one');
  await cache.refresh('catalog', async () => ['gmail']);
  assert.deepEqual(cache.peek('catalog'), ['gmail']);
  let finish!: (value: string[]) => void;
  const pending = cache.refresh('catalog', () => new Promise(resolve => { finish = resolve; }));
  cache.scope('two'); finish(['private']); await pending;
  assert.equal(cache.peek('catalog'), undefined);
});

test('status timeout bounds even a stalled decoder, aborts fetch, and a retry recovers', async () => {
  let signal!: AbortSignal;
  await assert.rejects(settingsRead(s => { signal = s; return new Promise(() => {}); }, undefined, 15), /Status unavailable/);
  assert.equal(signal.aborted, true);
  assert.equal(await settingsRead(async () => 'ready', undefined, 15), 'ready');
});

test('missing catalog logos use a letter immediately and known bundled art remains available', () => {
  for (const slug of ['agentphone', 'pylon_mcp', 'rootly']) assert.equal(toolkitLogo({ slug, name: slug }), undefined);
  assert.equal(toolkitLogo({ slug: 'gmail', name: 'Gmail' }), '/assets/toolkits/gmail.svg');
});

test('a stalled connected-account read cannot consume the separate profile deadline', async () => {
  const client = sdk();
  let signal!: AbortSignal;
  client.connectedAccounts.get = async (_id: string, options: any) => { signal = options.signal; return new Promise(() => {}); };
  const result = await createConnectionDetailsCache().details(client, 'owner', fixture());
  assert.equal(signal.aborted, true);
  assert.equal(result.accountLabel, 'fixture@example.test');
});

test('provider metadata never turns an identity lookup into a write', async () => {
  const client = sdk(); let calls = 0;
  client.toolkits.get = async () => ({ getCurrentUserEndpoint: '/write-profile', getCurrentUserEndpointMethod: 'POST' });
  client.tools.proxyExecute = async (args: any) => { calls++; assert.equal(args.method, 'GET'); assert.notEqual(args.endpoint, '/write-profile'); return { status: 200, data: {} }; };
  const result = await createConnectionDetailsCache().details(client, 'owner', fixture('unknown'));
  assert.equal(calls, 0);
  assert.equal(result.accountLabel, 'Connected account ca_fixture');
});
