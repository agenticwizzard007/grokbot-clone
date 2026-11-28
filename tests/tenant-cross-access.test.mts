import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { generateKeyPair, exportPKCS8, exportSPKI, importSPKI, jwtVerify } from 'jose';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { Directory, hashToken, opaqueToken } from '../server/src/platform/directory.js';
import { RuntimeIdentity } from '../server/src/platform/runtime-identity.js';
import { TenantEnvelopes } from '../server/src/platform/envelopes.js';
import { TenantSessions } from '../server/src/platform/tenant-sessions.js';
import { TunnelBroker } from '../server/src/platform/tunnel.js';
import { runtimeOperations } from '../server/src/platform/runtime-operations.js';
import { BackupCatalog, backupRoutes } from '../server/src/platform/backups.js';
import { backupLocation, type BackupStorage } from '../server/src/platform/backup-storage.js';
import { restoreTenantEnvironment } from '../server/src/platform/recovery.js';
import { HostUsage, hostUsageRoutes } from '../server/src/platform/host-usage.js';
import { LifecycleWorker } from '../server/src/platform/lifecycle-worker.js';
import { openSecret } from '../server/src/security/secret-envelope.js';
import { prepareEventInbox, deliverRuntimeEvents } from '../server/src/runtime/event-inbox.js';
import { FakeFly } from './fixtures/fly-tenants.mjs';

const url = process.env.TEST_DATABASE_URL;
const image = `registry.example/fixture@sha256:${'a'.repeat(64)}`;
const json = (body: unknown, token?: string): RequestInit => ({ method: 'POST', headers: {
  'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
}, body: JSON.stringify(body) });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const cookie = (raw: string) => ({ cookie: `swarm_session=${raw}` });
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// A real directory and real authorization, with provider transports replaced in process.
// Missing PostgreSQL fails this proof instead of reporting a skipped pass.
test('MT-E two-tenant cross-access matrix', { timeout: 120_000 }, async t => {
  assert.ok(url, 'TEST_DATABASE_URL must name a disposable local PostgreSQL database');
  Object.assign(process.env, { SESSION_SECRET: 'mt-e-local-session-secret-0123456789012345',
    PLATFORM_URL: 'https://platform.example.test', TENANT_KMS_KEY_ID: 'mt-e-fake-kms',
    COMPOSIO_API_KEY: 'mt-e-fake-project', COMPOSIO_WEBHOOK_SECRET: 'mt-e-fake-webhook' });
  const { platformAuth } = await import('../server/src/platform/auth.js');
  const { platformTenantRequest, platformAccountRoutes } = await import('../server/src/platform/server.js');
  const { composioGatewayApp } = await import('../server/src/platform/composio-gateway.js');
  const { ComposioProvider } = await import('../server/src/platform/composio-service.js');
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const { MessagingOwnership } = await import('../server/src/platform/messaging-store.js');
  const { verifySignature } = await import('../server/src/messaging/inkbox/client.js');
  const admin = new Pool({ connectionString: url }), schema = `test_mt_e_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target = new URL(url); target.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(target.href), root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e-'));
  t.after(async () => {
    await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await directory.migrate();

  const wrapped = new Map<string, { key: Buffer; context: unknown; keyId: string }>();
  t.mock.method(KMSClient.prototype, 'send', async (command: any) => {
    const input = command.input;
    if (command instanceof GenerateDataKeyCommand) {
      assert.equal(input.KeyId, 'mt-e-fake-kms'); assert.equal(input.KeySpec, 'AES_256');
      assert.equal(input.EncryptionContext.purpose, 'swarm-tenant-master-v1');
      const ciphertext = randomBytes(32), key = randomBytes(32);
      wrapped.set(ciphertext.toString('hex'), { key, context: structuredClone(input.EncryptionContext), keyId: input.KeyId });
      return { CiphertextBlob: ciphertext, Plaintext: Buffer.from(key) };
    }
    assert.ok(command instanceof DecryptCommand, 'Unexpected KMS operation');
    const record = wrapped.get(Buffer.from(input.CiphertextBlob).toString('hex'));
    if (!record || record.keyId !== input.KeyId || JSON.stringify(record.context) !== JSON.stringify(input.EncryptionContext)) {
      throw Object.assign(new Error('Fake KMS refused encryption context'), { name: 'InvalidCiphertextException' });
    }
    return { Plaintext: Buffer.from(record.key) };
  });
  t.after(() => { for (const record of wrapped.values()) record.key.fill(0); });
  const unexpectedFetches: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const address = String(input);
    if (address === 'https://openrouter.ai/api/v1/auth/keys') {
      const { code } = JSON.parse(String(init?.body)); assert.ok(['A', 'B'].includes(code));
      return Response.json({ user_id: `mt-e-subject-${code}`, key: `sk-or-v1-fixture_only_${code.repeat(24)}` });
    }
    if (address === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { label: 'local fixture' } });
    // SDK housekeeping is also answered locally, never forwarded to the network.
    if (address === 'https://registry.npmjs.org/@composio/core/latest') return Response.json({ version: '0.0.0' });
    if (new URL(address).hostname === 'telemetry.composio.dev') return Response.json({});
    unexpectedFetches.push(address); throw new Error('Outbound network is forbidden in MT-E');
  });
  t.after(() => assert.deepEqual(unexpectedFetches, [], 'Every external transport must be replaced in process'));
  const envelopes = new TenantEnvelopes(directory);
  const auth = new Hono().route('/api/auth', platformAuth(directory, envelopes, () => {}));
  async function login(label: string) {
    const start = await auth.request('/api/auth/openrouter/start'); assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const attemptCookie = start.headers.getSetCookie()[0].split(';')[0];
    const finish = await auth.request(`/api/auth/openrouter/callback?state=${state}&code=${label}`, { headers: { cookie: attemptCookie } });
    assert.equal(finish.status, 303); assert.equal(finish.headers.get('location'), process.env.PLATFORM_URL);
    const header = finish.headers.getSetCookie().find(value => value.startsWith('swarm_session='))!;
    assert.ok(header); for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(flag));
    assert.ok(!header.includes('Domain='));
    const raw = header.split(';')[0].slice('swarm_session='.length), session = await directory.session(raw);
    assert.ok(session);
    return { label, tenant: session.tenant_id as string, raw, session, machine: `machine_${label}`, volume: `vol_${label}`, token: '', hostToken: '', refresh: '', delegated: '' };
  }
  const a = await login('A'), b = await login('B');
  assert.notEqual(a.tenant, b.tenant);
  const keys = await generateKeyPair('EdDSA', { extractable: true }), publicKey = await exportSPKI(keys.publicKey);
  const runtime = new RuntimeIdentity(directory, await exportPKCS8(keys.privateKey), publicKey);
  const sessions = new TenantSessions(directory, process.env.SESSION_SECRET!);
  const fly = new FakeFly();
  for (const tenant of [a, b]) {
    // Synthetic infrastructure metadata only. No qualification rows or run evidence are created.
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=$2,volume_id=$3,fly_app=$4,network_id=$5 WHERE id=$1",
      [tenant.tenant, tenant.machine, tenant.volume, fly.name(tenant.tenant), fly.network(tenant.tenant)]);
    await directory.pool.query(`INSERT INTO host_policies(tenant_id,generation,machine_id,desired,observed,acknowledged_revision,reported_at,usage_not_before)
      VALUES($1,1,$2,'run','running',1,now(),now()-interval '1 minute')`, [tenant.tenant, tenant.machine]);
    const bootstrap = opaqueToken();
    await directory.pool.query("INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at) VALUES($1,$2,$3,1,'bootstrap',now()+interval '1 minute')", [hashToken(bootstrap), tenant.tenant, tenant.machine]);
    await assert.rejects(runtime.exchange(bootstrap, tenant === a ? b.tenant : a.tenant, tenant.machine), /Invalid runtime/);
    await assert.rejects(runtime.exchange(bootstrap, tenant.tenant, tenant === a ? b.machine : a.machine), /Invalid runtime/);
    Object.assign(tenant, await runtime.exchange(bootstrap, tenant.tenant, tenant.machine));
    await assert.rejects(runtime.exchange(bootstrap, tenant.tenant, tenant.machine), /Invalid runtime/);
    tenant.delegated = (await sessions.bind({ tenant: tenant.tenant, machine: tenant.machine, generation: '1', session: tenant.session.hash })).hash;
  }
  const operations = runtimeOperations(runtime, () => {});
  const events = async (who: typeof a) => (await (await operations.request('/events', bearer(who.token))).json() as any).events as { id: string; ciphertext: string }[];
  const snapshot = async (table: string, tenant: string, column = 'tenant_id') =>
    (await directory.pool.query(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY 1,2`, [tenant])).rows;

  await t.test('MT-E sessions refuse foreign session deletion and delegated platform authentication', async () => {
    const before = await snapshot('sessions', b.tenant);
    const listed = await (await auth.request('/api/auth/sessions', { headers: cookie(a.raw) })).json() as any;
    assert.deepEqual(listed.sessions.map((s: any) => s.id), [a.session.hash]);
    assert.equal((await auth.request(`/api/auth/sessions/${b.session.hash}`, { method: 'DELETE', headers: cookie(a.raw) })).status, 404);
    assert.deepEqual(await snapshot('sessions', b.tenant), before);
    const delegated = sessions.token(a.tenant, '1', a.session.hash);
    assert.equal((await auth.request('/api/auth/sessions', { headers: cookie(delegated) })).status, 401);
    assert.equal((await auth.request('/api/auth/sessions', { headers: { cookie: `grok_session=${a.raw}` } })).status, 401);
    await assert.rejects(sessions.bind({ tenant: b.tenant, machine: b.machine, generation: '1', session: a.session.hash }), /authorization expired/);
  });

  await t.test('MT-E tunnel HTTP viewer and desktop routing cannot select a foreign tenant', async check => {
    const broker = new TunnelBroker(directory, runtime, [process.env.PLATFORM_URL!], process.env.SESSION_SECRET!);
    broker.setDirectoryReady(true);
    const server = createServer(); broker.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port, clients: WebSocket[] = [];
    check.after(async () => { broker.setDirectoryReady(false); for (const ws of clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
    async function socket(route: string, options: any = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`, options); clients.push(ws); await once(ws, 'open'); return ws;
    }
    const receivedA: any[] = [], receivedB: any[] = [];
    const wsB = await socket('/internal/runtime/tunnel', bearer(b.token));
    wsB.on('message', raw => receivedB.push(JSON.parse(raw.toString())));
    const wsA = await socket(`/internal/runtime/tunnel?tenant=${b.tenant}`, { headers: { ...bearer(a.token).headers, 'x-swarm-tenant': b.tenant } });
    wsA.on('message', raw => {
      const message = JSON.parse(raw.toString()); receivedA.push(message);
      if (message.type === 'request') { wsA.send(JSON.stringify({ type: 'head', id: message.id, status: 200 })); wsA.send(JSON.stringify({ type: 'end', id: message.id })); }
    });
    const app = new Hono(); app.all('/api/*', platformTenantRequest(directory, broker));
    for (const route of ['/api/bots/bot_B/screen', '/api/desktop', `/api/events?tenant=${b.tenant}`]) {
      const response = await app.request(route, { headers: { ...cookie(a.raw), 'x-swarm-tenant': b.tenant, authorization: `Bearer ${b.token}` } });
      assert.equal(response.status, 200); await response.text();
      const forwarded = receivedA.filter(m => m.type === 'request').at(-1);
      assert.equal(forwarded.path, route);
      assert.equal(forwarded.headers['x-swarm-tenant'], undefined); assert.equal(forwarded.headers.authorization, undefined);
      assert.notEqual(forwarded.headers.cookie, `swarm_session=${a.raw}`);
      const { payload } = await jwtVerify(forwarded.authorization, await importSPKI(publicKey, 'EdDSA'), { audience: `tenant:${a.tenant}` });
      assert.equal(payload.sub, a.tenant);
      await assert.rejects(jwtVerify(forwarded.authorization, await importSPKI(publicKey, 'EdDSA'), { audience: `tenant:${b.tenant}` }));
    }
    const incoming = once(wsA, 'message');
    const viewer = await socket(`/api/bots/bot_B/screen?tenant=${b.tenant}`, { headers: { ...cookie(a.raw), origin: process.env.PLATFORM_URL } });
    const [raw] = await incoming, frame = JSON.parse(raw.toString());
    assert.equal(frame.type, 'socket');
    assert.equal((await jwtVerify(frame.authorization, await importSPKI(publicKey, 'EdDSA'), { audience: `tenant:${a.tenant}` })).payload.sub, a.tenant);
    viewer.close();
    assert.equal(receivedB.filter(m => ['request', 'socket'].includes(m.type)).length, 0);
    // A has no B token. Changing A's signed claims must fail before registration.
    const parts = a.token.split('.'), payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    parts[1] = Buffer.from(JSON.stringify({ ...payload, sub: b.tenant, machine: b.machine })).toString('base64url');
    const forged = new WebSocket(`ws://127.0.0.1:${port}/internal/runtime/tunnel`, bearer(parts.join('.'))); clients.push(forged);
    await assert.rejects(once(forged, 'open'));
    // A response ID is meaningful only on its registered tunnel, even when guessed by another runtime.
    const bIncoming = once(wsB, 'message'), pending = broker.forward(new Request('https://platform.example.test/api/private'), await directory.session(b.raw));
    const [bRaw] = await bIncoming, bFrame = JSON.parse(bRaw.toString());
    wsA.send(JSON.stringify({ type: 'head', id: bFrame.id, status: 201 })); wsA.send(JSON.stringify({ type: 'end', id: bFrame.id }));
    await new Promise<void>(resolve => wsA.ping(() => resolve()));
    wsB.send(JSON.stringify({ type: 'head', id: bFrame.id, status: 200 })); wsB.send(JSON.stringify({ type: 'end', id: bFrame.id }));
    const result = await pending; assert.equal(result.status, 200); await result.text();
    assert.equal(wsB.readyState, WebSocket.OPEN);
  });

  // SDK method fakes retain the real ComposioProvider, ConnectionGateway and PgConnectionRegistry.
  // The SDK's webhook signature verifier is deliberately real.
  const probe = new ComposioProvider('mt-e-fake-project'), effects: { operation: string; args: any[] }[] = [];
  const remote = new Map<string, { id: string; identity: string; toolkit: string }>();
  for (const who of [a, b]) {
    await directory.pool.query('UPDATE tenants SET composio_user_id=$2 WHERE id=$1', [who.tenant, `private-${who.label}`]);
    await directory.pool.query("INSERT INTO connected_accounts(id,tenant_id,toolkit,state) VALUES($1,$2,'gmail','active')", [`account-${who.label}`, who.tenant]);
    remote.set(`account-${who.label}`, { id: `account-${who.label}`, identity: `private-${who.label}`, toolkit: 'gmail' });
  }
  t.mock.method(Object.getPrototypeOf(probe.sdk.connectedAccounts), 'list', async (input: any) => {
    assert.equal(input.accountType, 'PRIVATE'); assert.equal(input.userIds.length, 1);
    return { items: [...remote.values()].filter(row => row.identity === input.userIds[0]).map(row => ({ id: row.id, status: 'ACTIVE', toolkit: { slug: row.toolkit } })), nextCursor: null };
  });
  for (const method of ['delete', 'refresh']) t.mock.method(Object.getPrototypeOf(probe.sdk.connectedAccounts), method, async (...args: any[]) => { effects.push({ operation: method, args }); return {}; });
  t.mock.method(Object.getPrototypeOf(probe.sdk.tools), 'getRawComposioToolBySlug', async (slug: string) => ({ slug, toolkit: { slug: 'gmail' }, version: '20261101_00', tags: ['readOnlyHint'] }));
  t.mock.method(Object.getPrototypeOf(probe.sdk.tools), 'execute', async (...args: any[]) => { effects.push({ operation: 'execute', args }); return { successful: true }; });
  t.mock.method(Object.getPrototypeOf(probe.sdk.triggers), 'getType', async (slug: string) => ({ slug, toolkit: { slug: 'gmail' } }));
  t.mock.method(Object.getPrototypeOf(probe.sdk.triggers), 'create', async (...args: any[]) => { effects.push({ operation: 'trigger-create', args }); return { triggerId: `trigger-${args[0]}` }; });
  for (const method of ['enable', 'disable', 'delete']) t.mock.method(Object.getPrototypeOf(probe.sdk.triggers), method, async (...args: any[]) => { effects.push({ operation: `trigger-${method}`, args }); return {}; });
  const callbacks = new Map<string, string>();
  t.mock.method(Object.getPrototypeOf(probe.sdk.sessions), 'create', async (identity: string, options: any) => {
    effects.push({ operation: 'connect-session', args: [identity, options] });
    return { authorize: async (toolkit: string, options: any) => {
      effects.push({ operation: 'connect', args: [identity, toolkit, options] }); callbacks.set(identity, options.callbackUrl);
      const id = `new-${identity}`; remote.set(id, { id, identity, toolkit });
      return { id, redirectUrl: 'https://provider.example.test/authorize' };
    } };
  });
  const gateway = composioGatewayApp(directory, runtime);
  const rpc = (who: typeof a, operation: string, input: unknown, sessionHash?: string) => gateway.request('/rpc', json({ operation, input, ...(sessionHash ? { sessionHash } : {}) }, who.token));

  await t.test('MT-E gateway refuses every foreign connected-account operation without effects', async () => {
    const before = await snapshot('connected_accounts', b.tenant);
    const list = await rpc(a, 'connections', { userId: 'private-B', tenantId: b.tenant });
    assert.equal(list.status, 200); assert.deepEqual((await list.json() as any[]).map(row => row.id), ['account-A']);
    const actions: [string, any][] = ['disconnect', 'refresh', 'default'].map(operation => [operation, { connectionId: 'account-B' }]);
    actions.push(['execute', { connectionId: 'account-B', revision: 1, dispatchId: opaqueToken(), slug: 'GMAIL_LIST', arguments: {} }], ['search', { toolkit: 'gmail', connectionId: 'account-B' }], ['trigger-create', { slug: 'GMAIL_EVENT', connectionId: 'account-B' }]);
    for (const [operation, input] of actions) {
      assert.equal((await rpc(a, operation, input)).status, 404, operation);
      assert.deepEqual(await snapshot('connected_accounts', b.tenant), before, operation);
    }
    for (const key of ['tenantId', 'userId', 'user_id', 'connectedAccountId', 'connected_account_id', 'authConfigId', 'sessionId']) {
      assert.equal((await rpc(a, 'execute', { connectionId: 'account-A', revision: 1, dispatchId: opaqueToken(), slug: 'GMAIL_LIST', arguments: { [key]: 'foreign' } })).status, 400, key);
    }
    assert.deepEqual(effects, []); assert.deepEqual(await snapshot('dispatches', a.tenant), []);
    // A stale local account row is insufficient when upstream now reports a different owner.
    remote.get('account-A')!.identity = 'private-B';
    try {
      assert.equal((await rpc(a, 'execute', { connectionId: 'account-A', revision: 1, dispatchId: opaqueToken(), slug: 'GMAIL_LIST', arguments: {} })).status, 404);
      assert.deepEqual(effects, []); assert.deepEqual(await snapshot('connected_accounts', b.tenant), before);
    } finally { remote.get('account-A')!.identity = 'private-A'; }
    assert.equal((await rpc(a, 'execute', { connectionId: 'account-A', revision: 1, dispatchId: opaqueToken(), slug: 'GMAIL_LIST', arguments: {} })).status, 200);
    const effect = effects.at(-1)!; assert.equal(effect.operation, 'execute');
    assert.equal(effect.args[1].userId, 'private-A'); assert.equal(effect.args[1].connectedAccountId, 'account-A');
    assert.deepEqual(await snapshot('connected_accounts', b.tenant), before);
  });

  await t.test('MT-E connect links bind the delegated session and callback to the private provider identity', async () => {
    const count = effects.length;
    for (const hash of [b.delegated, b.session.hash, a.session.hash, hashToken('unknown')]) {
      assert.equal((await rpc(a, 'connect', { toolkit: 'gmail', userId: 'private-B' }, hash)).status, 401);
    }
    assert.equal(effects.length, count); assert.deepEqual(await snapshot('connection_attempts', a.tenant), []);
    assert.equal((await rpc(b, 'connect', { toolkit: 'gmail' }, b.delegated)).status, 200);
    const callback = callbacks.get('private-B')!, before = await snapshot('connection_attempts', b.tenant);
    assert.equal((await gateway.request(callback, { headers: cookie(a.raw) })).status, 400);
    assert.deepEqual(await snapshot('connection_attempts', b.tenant), before);
    assert.equal((await gateway.request(callback, { headers: cookie(b.raw) })).status, 200);
    assert.equal((await gateway.request(callback, { headers: cookie(b.raw) })).status, 400);
    assert.equal((await rpc(a, 'connect', { toolkit: 'gmail', userId: 'private-B', connectedAccountId: 'account-B' }, a.delegated)).status, 200);
    assert.equal(effects.at(-1)!.args[0], 'private-A');
    assert.equal((await gateway.request(callbacks.get('private-A')!, { headers: cookie(a.raw) })).status, 200);
    assert.deepEqual((await snapshot('connected_accounts', a.tenant)).map(row => row.id), ['account-A', 'new-private-A']);
  });

  await t.test('MT-E trigger subscriptions and signed events reach only their registered tenant', async () => {
    for (const who of [a, b]) assert.equal((await rpc(who, 'trigger-create', { slug: 'GMAIL_EVENT', connectionId: `account-${who.label}` })).status, 200);
    const created = effects.filter(effect => effect.operation === 'trigger-create');
    assert.deepEqual(created.map(effect => [effect.args[0], effect.args[2].connectedAccountId]), [['private-A', 'account-A'], ['private-B', 'account-B']]);
    const before = await snapshot('provider_triggers', b.tenant), count = effects.length;
    for (const operation of ['trigger-check', 'trigger-enable', 'trigger-disable', 'trigger-delete']) {
      assert.equal((await rpc(a, operation, { triggerId: 'trigger-private-B' })).status, 404, operation);
      assert.deepEqual(await snapshot('provider_triggers', b.tenant), before);
    }
    assert.equal(effects.length, count);
    const payload = { id: 'delivery-B', timestamp: new Date().toISOString(), type: 'composio.trigger.message',
      metadata: { log_id: 'local-log', trigger_slug: 'GMAIL_EVENT', trigger_id: 'trigger-private-B', connected_account_id: 'account-B', auth_config_id: 'fixture-auth', user_id: 'private-B' },
      data: { text: 'Private B event' } };
    async function webhook(body: typeof payload, id: string, invalid = false, age = 0) {
      const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000) - age);
      const signature = createHmac('sha256', process.env.COMPOSIO_WEBHOOK_SECRET!).update(`${id}.${timestamp}.${raw}`).digest('base64');
      return gateway.request('/webhooks/composio', { method: 'POST', body: raw, headers: {
        'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${invalid ? 'invalid' : signature}`,
      } });
    }
    const aEvents = await snapshot('wake_events', a.tenant), bEvents = await snapshot('wake_events', b.tenant);
    assert.equal((await webhook(payload, 'bad-signature', true)).status, 400);
    assert.equal((await webhook(payload, 'expired', false, 600)).status, 400);
    for (const metadata of [{ ...payload.metadata, user_id: 'private-A' }, { ...payload.metadata, connected_account_id: 'account-A' }, { ...payload.metadata, trigger_id: 'trigger-private-A' }]) {
      assert.equal((await webhook({ ...payload, metadata }, opaqueToken())).status, 404);
    }
    assert.deepEqual(await snapshot('wake_events', b.tenant), bEvents);
    assert.equal((await webhook(payload, 'delivery-B')).status, 200);
    assert.equal((await webhook(payload, 'delivery-B')).status, 200);
    assert.deepEqual(await snapshot('wake_events', a.tenant), aEvents);
    assert.equal((await snapshot('wake_events', b.tenant)).length, bEvents.length + 1, 'signed replay is deduplicated');
    assert.deepEqual((await directory.pool.query("SELECT tenant_id FROM lifecycle_jobs WHERE operation='wake'")).rows, [{ tenant_id: b.tenant }]);
    assert.equal((await rpc(b, 'trigger-disable', { triggerId: 'trigger-private-B' })).status, 200);
    const disabled = await snapshot('wake_events', b.tenant);
    assert.equal((await webhook(payload, 'disabled-B')).status, 404);
    assert.deepEqual(await snapshot('wake_events', b.tenant), disabled);
    assert.equal((await rpc(b, 'trigger-enable', { triggerId: 'trigger-private-B' })).status, 200);
  });

  await t.test('MT-E provider keys enforce KMS context tenant and event-purpose binding', async () => {
    const event = (await events(b)).find(event => event.id.startsWith('openrouter-'))!;
    assert.ok(event); assert.ok(!event.ciphertext.includes('sk-or-v1-'));
    const aKey = await envelopes.key(a.tenant), bKey = await envelopes.key(b.tenant);
    try {
      const opened = openSecret<any>(bKey, b.tenant, `event:${event.id}`, event.ciphertext);
      assert.equal(opened.provider, 'openrouter'); assert.equal(opened.key, `sk-or-v1-fixture_only_${'B'.repeat(24)}`);
      for (const [key, tenant, purpose] of [[aKey, a.tenant, `event:${event.id}`], [bKey, a.tenant, `event:${event.id}`], [bKey, b.tenant, 'event:other']] as const) {
        assert.throws(() => openSecret(key, tenant, purpose, event.ciphertext), /ownership or integrity/);
      }
      const aRow = (await snapshot('tenants', a.tenant, 'id'))[0], bRow = (await snapshot('tenants', b.tenant, 'id'))[0];
      await directory.pool.query('UPDATE tenants SET encrypted_data_key=$2 WHERE id=$1', [a.tenant, bRow.encrypted_data_key]);
      try { await assert.rejects(envelopes.key(a.tenant), { name: 'InvalidCiphertextException' }); }
      finally { await directory.pool.query('UPDATE tenants SET encrypted_data_key=$2 WHERE id=$1', [a.tenant, aRow.encrypted_data_key]); }
      assert.deepEqual(await snapshot('tenants', b.tenant, 'id'), [bRow]);
      const kms = new KMSClient({});
      await assert.rejects(kms.send(new DecryptCommand({ KeyId: 'mt-e-fake-kms', CiphertextBlob: bRow.encrypted_data_key, EncryptionContext: { tenant: b.tenant, purpose: 'wrong-purpose' } })), { name: 'InvalidCiphertextException' });
      kms.destroy();
    } finally { aKey.fill(0); bKey.fill(0); }
  });

  await t.test('MT-E runtime event reads acknowledgements and inbox delivery cannot wake A for B', async () => {
    await envelopes.event(a.tenant, 'same-event-id', { type: 'provider-key', provider: 'openrouter', key: 'fixture-A' });
    await envelopes.event(b.tenant, 'same-event-id', { type: 'provider-key', provider: 'openrouter', key: 'fixture-B' });
    const bBefore = await snapshot('wake_events', b.tenant), bEvents = await events(b), aEvents = await events(a);
    assert.ok(bEvents.some(event => event.id.startsWith('composio-')));
    assert.ok(!aEvents.some(event => bEvents.some(other => other.ciphertext === event.ciphertext)));
    assert.equal((await operations.request('/events/ack', json({ ids: bEvents.map(event => event.id) }, a.token))).status, 200);
    assert.deepEqual(await events(a), aEvents.filter(event => event.id !== 'same-event-id'));
    assert.deepEqual(await snapshot('wake_events', b.tenant), bBefore);
    assert.equal((await operations.request('/events/ack', json({ ids: bEvents.map(event => event.id), tenant: b.tenant }, a.token))).status, 400);
    assert.equal((await operations.request('/events', bearer(a.hostToken))).status, 401);
    assert.equal((await operations.request('/events', { headers: cookie(a.raw) })).status, 401);
    const inboxA = new Database(':memory:'), inboxB = new Database(':memory:');
    const aKey = await envelopes.key(a.tenant), bKey = await envelopes.key(b.tenant);
    try {
      for (const db of [inboxA, inboxB]) { prepareEventInbox(db); db.exec('CREATE TABLE applied(id TEXT PRIMARY KEY,type TEXT)'); }
      const delivery = (who: typeof a, db: Database.Database, key: Buffer) => ({
        open: (event: { id: string; ciphertext: string }) => openSecret<any>(key, who.tenant, `event:${event.id}`, event.ciphertext),
        async authorize(payload: any) {
          if (payload.type === 'provider-trigger') assert.equal((await rpc(who, 'trigger-check', { triggerId: payload.triggerId })).status, 200);
        },
        apply(payload: any, event: { id: string }) { db.prepare('INSERT INTO applied VALUES(?,?)').run(event.id, payload.type); },
        retryable: () => false,
      });
      await deliverRuntimeEvents(inboxA, bEvents, delivery(a, inboxA, aKey));
      assert.deepEqual(inboxA.prepare('SELECT * FROM applied').all(), [], 'foreign ciphertext never reaches the routine apply callback');
      assert.equal((inboxA.prepare('SELECT count(*) n FROM runtime_event_failures').get() as any).n, bEvents.length);
      const ack = await deliverRuntimeEvents(inboxB, bEvents, delivery(b, inboxB, bKey));
      assert.deepEqual(ack, bEvents.map(event => event.id));
      assert.equal((inboxB.prepare('SELECT count(*) n FROM applied').get() as any).n, bEvents.length);
      await deliverRuntimeEvents(inboxB, bEvents, delivery(b, inboxB, bKey));
      assert.equal((inboxB.prepare('SELECT count(*) n FROM applied').get() as any).n, bEvents.length, 'lost acknowledgements cannot apply twice');
      assert.equal((await operations.request('/events/ack', json({ ids: ack }, b.token))).status, 200);
      assert.deepEqual(await events(b), []); assert.deepEqual(await events(a), aEvents.filter(event => event.id !== 'same-event-id'));
    } finally { inboxA.close(); inboxB.close(); aKey.fill(0); bKey.fill(0); }
  });

  await t.test('MT-E Inkbox signatures phone routes and revocations never route B messages to A', async () => {
    const ownership = new MessagingOwnership(directory, envelopes);
    for (const who of [a, b]) {
      const phone = who === a ? '15550001001' : '15550001002';
      assert.equal(await directory.identity('phone', phone, { name: `Tenant ${who.label}` }, who.session.hash), who.tenant);
      await ownership.link(who.tenant, phone, 'imessage', `conversation-${who.label}`, who.session.hash);
    }
    const messenger = { ready: () => true, line: async () => null,
      verify: (raw: string, h: Record<string, string | undefined>) => verifySignature(raw, { requestId: h['x-inkbox-request-id'], timestamp: h['x-inkbox-timestamp'], signature: h['x-inkbox-signature'] }, 'mt-e-inkbox'),
      send: async () => { assert.fail('This inbound proof must not send messages'); },
    };
    const app = platformMessaging(directory, envelopes, runtime, () => {}, messenger);
    async function inbound(id: string, invalid = false, age = 0) {
      const raw = JSON.stringify({ event_type: 'imessage.received', tenant: a.tenant, data: { message: { id,
        remote_number: '+15550001002', conversation_id: 'conversation-B', content: 'Private B inbound', tenant_id: a.tenant } } });
      const timestamp = String(Math.floor(Date.now() / 1000) - age);
      const signature = createHmac('sha256', 'mt-e-inkbox').update(`${id}.${timestamp}.${raw}`).digest('hex');
      return app.request('/api/messaging/inkbox/webhook', { method: 'POST', body: raw, headers: {
        ...cookie(a.raw), 'x-swarm-tenant': a.tenant, 'x-inkbox-request-id': id, 'x-inkbox-timestamp': timestamp, 'x-inkbox-signature': `sha256=${invalid ? '0'.repeat(64) : signature}`,
      } });
    }
    const aBefore = await snapshot('wake_events', a.tenant), bBefore = await snapshot('wake_events', b.tenant);
    assert.equal((await inbound('bad', true)).status, 401); assert.equal((await inbound('old', false, 600)).status, 401);
    assert.deepEqual(await snapshot('wake_events', b.tenant), bBefore);
    assert.equal((await inbound('message-B')).status, 204); assert.equal((await inbound('message-B')).status, 204);
    assert.deepEqual(await snapshot('wake_events', a.tenant), aBefore);
    const delivered = (await events(b)).filter(event => event.id.startsWith('inkbox-')); assert.equal(delivered.length, 1);
    const key = await envelopes.key(b.tenant);
    try { assert.equal(openSecret<any>(key, b.tenant, `event:${delivered[0].id}`, delivered[0].ciphertext).event.text, 'Private B inbound'); }
    finally { key.fill(0); }
    assert.deepEqual((await snapshot('messaging_receipts', a.tenant)), []);
    assert.deepEqual((await snapshot('messaging_receipts', b.tenant)).map(row => row.id), ['message-B']);
    const bRoute = await snapshot('messaging_routes', b.tenant);
    assert.equal((await app.request('/internal/runtime/messaging', json({ operation: 'disconnect', channel: 'imessage', tenant: b.tenant }, a.token))).status, 400);
    assert.equal((await app.request('/internal/runtime/messaging', json({ operation: 'validate', channel: 'imessage', revision: bRoute[0].revision, receipt: 'message-B' }, a.token))).status, 404);
    assert.deepEqual(await snapshot('messaging_routes', b.tenant), bRoute);
    await ownership.disconnect(b.tenant, 'imessage');
    const revoked = await snapshot('wake_events', b.tenant);
    assert.equal((await inbound('revoked-route')).status, 204);
    assert.deepEqual(await snapshot('wake_events', b.tenant), revoked); assert.deepEqual(await snapshot('wake_events', a.tenant), aBefore);
    assert.deepEqual((await directory.pool.query("SELECT tenant_id FROM lifecycle_jobs WHERE operation='wake'")).rows, [{ tenant_id: b.tenant }]);
  });

  const objects = new Map<string, Buffer>(), storageEffects: string[] = [];
  const storage: BackupStorage = {
    async put(tenant, id, name, body, bytes, checksum) {
      const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); const data = Buffer.concat(chunks);
      assert.equal(data.length, bytes); assert.equal(sha256(data), checksum);
      const location = backupLocation(tenant, id, name); storageEffects.push(`put:${location}`); objects.set(location, data);
    },
    async get(tenant, id, name) { const location = backupLocation(tenant, id, name); storageEffects.push(`get:${location}`); const data = objects.get(location); assert.ok(data); return { body: Readable.from([data]), bytes: data.length }; },
    async remove(tenant, id) { const prefix = backupLocation(tenant, id); storageEffects.push(`remove:${prefix}`); for (const location of objects.keys()) if (location.startsWith(prefix)) objects.delete(location); },
  };
  const catalog = new BackupCatalog(directory, storage), backups = backupRoutes(catalog, runtime);
  const backupA = 'a'.repeat(32), backupB = 'b'.repeat(32);
  await t.test('MT-E backup host routes and restore refuse foreign catalog IDs before object access', async () => {
    for (const [who, id] of [[a, backupA], [b, backupB]] as const) {
      const owner = { tenant: who.tenant, generation: '1' };
      await catalog.begin(owner, { id, scope: 'environment', parts: 2, bytes: 2 });
      for (const name of ['manifest.bin', '0.bin']) { const bytes = Buffer.from(who.label); await catalog.put(owner, id, name, Readable.from([bytes]), 1, sha256(bytes)); }
      await catalog.complete(owner, id);
    }
    const before = await snapshot('backups', b.tenant), stored = [...objects], effectsBefore = storageEffects.length;
    assert.deepEqual((await (await backups.request('/', bearer(a.hostToken))).json() as any).backups.map((row: any) => row.id), [backupA]);
    assert.equal((await backups.request('/', bearer(a.token))).status, 401);
    assert.equal((await backups.request(`/${backupB}/complete`, json({}, a.hostToken))).status, 409);
    assert.equal((await backups.request(`/${backupB}/0.bin`, { method: 'PUT', headers: { ...bearer(a.hostToken).headers, 'content-length': '1', 'x-backup-sha256': sha256(Buffer.from('X')) }, body: 'X' })).status, 409);
    assert.equal((await backups.request('/', json({ id: backupB, scope: 'environment', parts: 2, bytes: 2, tenant: b.tenant }, a.hostToken))).status, 400);
    await assert.rejects(restoreTenantEnvironment(directory, envelopes, storage, { tenant: a.tenant, fullBackup: backupB, destination: path.join(root, 'foreign-restore'), volume: a.volume }), /Backup not found/);
    assert.equal(fs.existsSync(path.join(root, 'foreign-restore')), false);
    assert.equal(storageEffects.length, effectsBefore); assert.deepEqual([...objects], stored); assert.deepEqual(await snapshot('backups', b.tenant), before);
    for (const name of ['../manifest.bin', `${b.tenant}/manifest.bin`, '0.bin/../manifest.bin']) assert.throws(() => backupLocation(a.tenant, backupB, name));
  });

  await t.test('MT-E host usage and runtime registrations refuse foreign volume machine and companion claims', async () => {
    const usage = hostUsageRoutes(new HostUsage(directory, runtime), runtime, true);
    const report = { version: 1, volume: b.volume, stream: randomUUID(), sequence: 1, at: Date.now(), intervalMs: 15000, cpu: 0.2, memory: 0.3, usedBytes: 1000 };
    assert.equal((await usage.request('/', json(report, a.token))).status, 401);
    assert.equal((await usage.request('/', json(report, a.hostToken))).status, 409);
    assert.equal((await usage.request('/', json({ ...report, tenant: b.tenant }, a.hostToken))).status, 409);
    assert.deepEqual(await snapshot('host_usage_samples', b.tenant), []);
    for (const who of [a, b]) assert.equal((await usage.request('/', json({ ...report, volume: who.volume }, who.hostToken))).status, 204);
    const usageB = await snapshot('host_usage_samples', b.tenant);
    await assert.rejects(runtime.exchange(a.refresh, b.tenant, b.machine), /Invalid runtime/);
    await assert.rejects(runtime.exchange(a.refresh, a.tenant, b.machine), /Invalid runtime/);
    const route = { scope: 'desktop', hash: hashToken('B-companion') };
    assert.equal((await operations.request('/companions', json(route, b.token))).status, 200);
    const before = await snapshot('companion_routes', b.tenant);
    assert.equal((await operations.request('/companions', json({ ...route, tenant: b.tenant }, a.token))).status, 400);
    assert.equal((await operations.request('/companions', json(route, a.token))).status, 409);
    assert.deepEqual(await snapshot('companion_routes', b.tenant), before);
    assert.deepEqual(await snapshot('host_usage_samples', b.tenant), usageB);
    assert.equal((await runtime.verify(b.token)).tenant, b.tenant);
  });

  await t.test('MT-E infrastructure names reject foreign inventory and deletion purges only A', async () => {
    for (const method of ['name', 'network', 'volumeName'] as const) {
      assert.notEqual(fly[method](a.tenant), fly[method](b.tenant));
      assert.equal(fly[method](a.tenant), new FakeFly()[method](a.tenant));
      assert.throws(() => fly[method](`../${b.tenant}`));
    }
    assert.notEqual(fly.deploymentVolumeName(a.tenant, backupA), fly.deploymentVolumeName(b.tenant, backupA));
    for (const who of [a, b]) { await fly.ensureApp(who.tenant); await fly.ensureVolume(fly.name(who.tenant), who.tenant, 'iad'); }
    const calls = fly.calls.length;
    await assert.rejects(fly.destroy(fly.name(b.tenant), a.tenant), /Foreign tenant application/);
    await assert.rejects(fly.ensureVolume(fly.name(b.tenant), a.tenant, 'iad'), /Foreign tenant application/);
    assert.equal(fly.calls.length, calls);
    const account = platformAccountRoutes(directory, () => {});
    const remove = (id: string) => account.request('/api/account', { ...json({ confirmation: 'DELETE', expectedUserId: id }), method: 'DELETE', headers: { ...cookie(a.raw), 'content-type': 'application/json' } });
    // Keep synthetic create/wake jobs out of this deletion tick before taking B's snapshot.
    await directory.pool.query("UPDATE lifecycle_jobs SET retry_at=now()+interval '1 day' WHERE operation!='delete'");
    const tables = ['tenants', 'sessions', 'runtime_credentials', 'connected_accounts', 'provider_triggers', 'wake_events', 'messaging_routes', 'messaging_receipts', 'companion_routes', 'host_usage_samples', 'backups', 'backup_parts', 'host_policies', 'lifecycle_jobs'];
    const before = await Promise.all(tables.map(table => snapshot(table, b.tenant, table === 'tenants' ? 'id' : 'tenant_id')));
    assert.equal((await remove(b.tenant)).status, 409);
    assert.equal((await remove(a.tenant)).status, 202);
    assert.equal(await directory.session(a.raw), null); await assert.rejects(runtime.verify(a.token), /revoked/);
    await assert.rejects(runtime.exchange(a.refresh, a.tenant, a.machine), /Invalid runtime/);
    assert.equal((await operations.request('/events', bearer(a.token))).status, 401);
    assert.equal((await rpc(a, 'connections', {})).status, 401);
    assert.deepEqual(await snapshot('host_usage_samples', a.tenant), []);
    assert.deepEqual(await Promise.all(tables.map(table => snapshot(table, b.tenant, table === 'tenants' ? 'id' : 'tenant_id'))), before);
    // Reconcile the in-process provider cleanup, then exercise the real lifecycle deletion worker.
    await directory.pool.query("UPDATE connected_accounts SET state='deleted' WHERE tenant_id=$1 AND state='revoked'", [a.tenant]);
    const bJobs = await snapshot('lifecycle_jobs', b.tenant), bObjects = [...objects].filter(([name]) => name.startsWith(`${b.tenant}/`));
    const bInfrastructure = structuredClone({ app: fly.apps.get(fly.name(b.tenant)), volumes: fly.volumes.get(fly.name(b.tenant)) });
    const worker = new LifecycleWorker(directory, { fly, envelopes, backups: catalog, image, region: 'iad' });
    assert.equal(await worker.tick(), 'completed');
    const deleted = (await snapshot('tenants', a.tenant, 'id'))[0];
    assert.equal(deleted.state, 'deleted'); assert.equal(deleted.encrypted_data_key, null);
    assert.deepEqual(await snapshot('wake_events', a.tenant), []); assert.deepEqual(await snapshot('host_policies', a.tenant), []);
    assert.equal([...objects.keys()].some(name => name.startsWith(`${a.tenant}/`)), false);
    assert.deepEqual([...objects].filter(([name]) => name.startsWith(`${b.tenant}/`)), bObjects);
    assert.equal(fly.apps.has(fly.name(a.tenant)), false);
    assert.deepEqual({ app: fly.apps.get(fly.name(b.tenant)), volumes: fly.volumes.get(fly.name(b.tenant)) }, bInfrastructure);
    assert.deepEqual(await snapshot('lifecycle_jobs', b.tenant), bJobs);
    assert.deepEqual(await Promise.all(tables.slice(0, -1).map(table => snapshot(table, b.tenant, table === 'tenants' ? 'id' : 'tenant_id'))), before.slice(0, -1));
    assert.equal((await directory.session(b.raw)).tenant_id, b.tenant); assert.equal((await runtime.verify(b.token)).tenant, b.tenant);
    assert.equal((await rpc(b, 'execute', { connectionId: 'account-B', revision: 1, dispatchId: opaqueToken(), slug: 'GMAIL_LIST', arguments: {} })).status, 200);
    assert.equal((await directory.pool.query('SELECT * FROM release_gates')).rowCount, 0, 'Local proof never creates qualification evidence');
  });
});
