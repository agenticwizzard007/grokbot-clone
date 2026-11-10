import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-composio-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'composio-test-only', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', APP_URL: 'https://app.example.com' });
const backgroundFetch = (url: string | URL | Request) => {
  const host = new URL(String(url)).hostname;
  if (host === 'registry.npmjs.org') return Promise.resolve(Response.json({ version: '0.28.0' }));
  if (host === 'telemetry.composio.dev') return Promise.resolve(Response.json({}));
  throw new Error(`Unexpected network request in isolated test: ${host}`);
};
mock.method(globalThis, 'fetch', backgroundFetch);
const { db } = await import('../server/src/db.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio, sessionFor, invalidateComposioSession, connectionsDetail, connectedToolkits, disconnect, catalog, executeComposio } = await import('../server/src/composio.js');
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
let n = 0;
function freshClient() {
  setEnvOverride('COMPOSIO_API_KEY', `test-project-${++n}`);
  const client = composio();
  const created: string[] = [];
  mock.method(client, 'create', async (userId: string) => {
    created.push(userId);
    return { sessionId: `session-${n}-${userId}`, execute: async () => ({ resultType: 'success', data: { userId } }) };
  });
  return { client, created };
}
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('one project gives each user a separate session and deduplicates concurrent first use', async () => {
  const { created } = freshClient();
  const [one, same, other] = await Promise.all([sessionFor('owner'), sessionFor('owner'), sessionFor('other')]);
  assert.equal(one, same);
  assert.notEqual(one.sessionId, other.sessionId);
  assert.deepEqual(created.sort(), ['other', 'owner']);
  assert.deepEqual((await executeComposio('other', 'READ', {})).data, { userId: 'other' });
});

test('a new project never reuses cached or saved sessions from the previous key', async () => {
  freshClient();
  const old = await sessionFor('owner');
  const { client, created } = freshClient();
  const use = mock.method(client, 'use', async () => { throw new Error('Must not retrieve an old project session'); });
  const next = await sessionFor('owner');
  assert.notEqual(next.sessionId, old.sessionId);
  assert.deepEqual(created, ['owner']);
  assert.equal(use.mock.callCount(), 0);
});

test('legacy saved sessions without a project fingerprint are replaced', async () => {
  const { client } = freshClient();
  db.prepare('INSERT OR REPLACE INTO composio_sessions(user_id,session_id) VALUES (?,?)').run('other', 'legacy');
  const use = mock.method(client, 'use', async () => { throw new Error('Legacy session is not scoped to a key'); });
  assert.notEqual((await sessionFor('other')).sessionId, 'legacy');
  assert.equal(use.mock.callCount(), 0);
});

test('an in-flight session cannot repopulate the cache after a project change', async () => {
  const { client } = freshClient();
  let release!: (value: any) => void;
  mock.method(client, 'create', () => new Promise((resolve) => { release = resolve; }));
  const pending = sessionFor('owner');
  freshClient();
  const current = await sessionFor('owner');
  release({ sessionId: 'stale' });
  await assert.rejects(pending, /key changed/);
  assert.equal((await sessionFor('owner')).sessionId, current.sessionId);
  assert.equal((db.prepare('SELECT session_id FROM composio_sessions WHERE user_id=?').get('owner') as any).session_id, current.sessionId);
});

test('connection changes invalidate persistent sessions as well as memory', async () => {
  const { created } = freshClient();
  await sessionFor('owner');
  invalidateComposioSession('owner');
  assert.equal(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('owner'), undefined);
  await sessionFor('owner');
  assert.equal(created.length, 2);
});

test('all connection pages stay scoped to the requesting user, including disconnect', async () => {
  const { client } = freshClient();
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    assert.deepEqual(query.userIds, ['other']);
    assert.equal(query.accountType, 'PRIVATE');
    return query.cursor
      ? { items: [{ id: 'second', toolkit: { slug: 'slack' }, status: 'ACTIVE' }], nextCursor: null }
      : { items: [{ id: 'first', toolkit: { slug: 'gmail' }, status: 'EXPIRED' }], nextCursor: 'page-two' };
  });
  const removed: string[] = [];
  mock.method(client.connectedAccounts, 'delete', async (id: string) => { removed.push(id); });
  assert.equal((await connectionsDetail('other')).length, 2);
  assert.deepEqual([...await connectedToolkits('other')], ['slack']);
  await sessionFor('other');
  await disconnect('other', 'slack');
  assert.deepEqual(removed, ['second']);
  assert.equal(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('other'), undefined);
});

test('catalog loads beyond three pages and is refreshed immediately after a key change', async () => {
  freshClient();
  let calls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    if (new URL(url).hostname !== 'backend.composio.dev') return backgroundFetch(url);
    calls++;
    const page = Number(new URL(url).searchParams.get('cursor') ?? '1');
    return Response.json({ items: [{ slug: `app${page}`, name: `App ${page}` }], next_cursor: page < 4 ? String(page + 1) : null });
  });
  assert.equal((await catalog()).length, 4);
  assert.equal((await catalog()).length, 4);
  assert.equal(calls, 4);
  freshClient();
  assert.equal((await catalog()).length, 4);
  assert.equal(calls, 8);
  fetchMock.mock.restore();
});

test('cached sessions are periodically checked and only missing sessions are recreated', async () => {
  const { client, created } = freshClient();
  await sessionFor('owner');
  const clock = mock.method(Date, 'now', () => new Date('2040-01-01').getTime());
  const use = mock.method(client, 'use', async () => { throw Object.assign(new Error('not authorized'), { status: 401 }); });
  try {
    await assert.rejects(sessionFor('owner'), /not authorized/);
    assert.equal(created.length, 1);
    use.mock.mockImplementation(async () => { throw Object.assign(new Error('expired'), { status: 404 }); });
    await sessionFor('owner');
    assert.equal(created.length, 2);
  } finally { clock.mock.restore(); }
});

test('failed session creation can be retried, and disabled apps expose no tools or connections', async () => {
  const { client } = freshClient();
  const create = mock.method(client, 'create', async () => { throw new Error('temporary provider failure'); });
  await assert.rejects(sessionFor('owner'), /temporary provider failure/);
  create.mock.restore();
  await sessionFor('owner');
  setEnvOverride('COMPOSIO_API_KEY', null);
  await assert.rejects(sessionFor('owner'), /aren't set up/);
  assert.deepEqual(await connectionsDetail('owner'), []);
  assert.deepEqual(await catalog(), []);
});

test('provider execution failures are never automatically replayed', async () => {
  const { client } = freshClient();
  let calls = 0;
  mock.method(client, 'create', async () => ({ sessionId: 'expired', execute: async () => { calls++; throw Object.assign(new Error('gone'), { status: 410 }); } }));
  await assert.rejects(executeComposio('owner', 'SEND_EMAIL', {}), /gone/);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('owner'), undefined);
});

test('only the owner can save a shared key; all users receive a refresh without key disclosure', async () => {
  const { Hono } = await import('hono');
  const { configApi } = await import('../server/src/routes-config.js');
  const { hub } = await import('../server/src/lib/hub.js');
  const app = new Hono().route('/api', configApi);
  const events: string[] = [];
  const stops = ['owner', 'other'].map(id => hub.subscribe(id, event => { if (event.type === 'connections') events.push(id); }));
  const provider = mock.method(globalThis, 'fetch', async () => Response.json({ items: [] }));
  const save = (user: string) => app.request('/api/settings/keys/composio', { method: 'PUT', headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'test-shared-project-key' }) });
  assert.equal((await save('other')).status, 403);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal((await save('owner')).status, 200);
  assert.deepEqual(events.sort(), ['other', 'owner']);
  const response = await app.request('/api/settings/keys', { headers: { cookie: 'swarm_session=other' } });
  const status = await response.json() as any;
  assert.equal(status.canEdit, false);
  assert.equal(status.composio.set, true);
  assert.ok(!JSON.stringify(status).includes('test-shared-project-key'));
  const stored = db.prepare("SELECT value FROM server_settings WHERE key='composio'").get() as any;
  assert.ok(stored.value.startsWith('v1:'));
  assert.ok(!stored.value.includes('test-shared-project-key'));
  provider.mock.restore();
  stops.forEach(stop => stop());
});

test('OAuth callbacks only report success for a confirmed connection and refresh its session', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const app = new Hono().route('/api', api);
  const { client } = freshClient();
  mock.method(client.connectedAccounts, 'list', async ({ userIds }: any) => ({ items: userIds[0] === 'owner' ? [{ id: 'gmail-owner', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] : [], nextCursor: null }));
  await sessionFor('owner');
  const callback = (user: string, slug = 'gmail') => app.request(`/api/apps/callback?slug=${encodeURIComponent(slug)}&status=success`, { headers: { cookie: `swarm_session=${user}` } });
  assert.match(await (await callback('other')).text(), /"ok":false/);
  assert.match(await (await callback('invalid')).text(), /"ok":false/);
  const html = await (await callback('owner')).text();
  assert.match(html, /"ok":true/);
  assert.ok(html.includes('https://app.example.com'));
  assert.equal(db.prepare('SELECT 1 FROM composio_sessions WHERE user_id=?').get('owner'), undefined);
  assert.ok(!(await (await callback('owner', '</script><script>alert(1)</script>')).text()).includes('<script>alert(1)'));
});

test('key changes move event subscriptions to the new client and stop old deliveries', async () => {
  const { initTriggers, refreshTriggerSubscription } = await import('../server/src/triggers.js');
  const { client: oldClient } = freshClient();
  let oldDelivery!: (event: any) => void;
  mock.method(oldClient.triggers, 'subscribe', async (callback: any) => { oldDelivery = callback; });
  const oldStop = mock.method(oldClient.triggers, 'unsubscribe', async () => {});
  const delivered: string[] = [];
  await initTriggers((botId) => { delivered.push(botId); });
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('event-bot', 'owner', 'Events', Date.now(), Date.now());
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id) VALUES (?,?,?,?,?,?,?)').run('event-routine', 'event-bot', 'Email', 'Read new email', 'event:GMAIL_NEW_GMAIL_MESSAGE', Date.now(), 'event-trigger');
  await refreshTriggerSubscription();
  oldDelivery({ id: 'event-trigger', payload: {} });
  assert.deepEqual(delivered, ['event-bot']);
  const { client: nextClient } = freshClient();
  let nextDelivery!: (event: any) => void;
  const nextStart = mock.method(nextClient.triggers, 'subscribe', async (callback: any) => { nextDelivery = callback; });
  const nextStop = mock.method(nextClient.triggers, 'unsubscribe', async () => {});
  await refreshTriggerSubscription();
  assert.equal(oldStop.mock.callCount(), 1);
  assert.equal(nextStart.mock.callCount(), 1);
  oldDelivery({ id: 'event-trigger', payload: {} });
  assert.equal(delivered.length, 1);
  nextDelivery({ id: 'event-trigger', payload: {} });
  assert.equal(delivered.length, 2);
  setEnvOverride('COMPOSIO_API_KEY', null);
  await refreshTriggerSubscription();
  assert.equal(nextStop.mock.callCount(), 1);
  nextDelivery({ id: 'event-trigger', payload: {} });
  assert.equal(delivered.length, 2);
});
