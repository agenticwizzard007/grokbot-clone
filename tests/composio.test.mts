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
const { composioCredentials, composioHeaders } = await import('../server/src/composio-auth.js');
const { composio, sessionFor, invalidateComposioSession, connectionsDetail, connectedToolkits, disconnect, catalog, executeComposio } = await import('../server/src/composio.js');
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
db.prepare("INSERT INTO account_roles VALUES('owner','admin')").run();
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

test('Google startup errors return to sign-in instead of an internal server error page', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const app = new Hono().route('/api', api);
  const { client } = freshClient();
  mock.method(client, 'create', async () => { throw new Error('provider unavailable'); });
  const r = await app.request('/api/auth/google/start');
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')!).searchParams.get('login'), 'google_unavailable');
});

test('platform credentials reject personal MCP keys and require explicit user-key scope', () => {
  assert.throws(() => composioCredentials('ck_personal'), /personal Composio MCP key/);
  assert.throws(() => composioCredentials('uak_developer'), /COMPOSIO_ORG_ID/);
  setEnvOverride('COMPOSIO_ORG_ID', 'org-test');
  try {
    assert.throws(() => composioCredentials('uak_developer'), /COMPOSIO_PROJECT_ID/);
    setEnvOverride('COMPOSIO_PROJECT_ID', 'project-test');
    assert.deepEqual(composioHeaders('uak_developer'), { 'x-user-api-key': 'uak_developer', 'x-org-id': 'org-test', 'x-project-id': 'project-test' });
    assert.deepEqual(composioCredentials('project-key'), { apiKey: 'project-key', userApiKey: null, orgApiKey: null });
    assert.deepEqual(composioHeaders('project-key'), { 'x-api-key': 'project-key' });
  } finally {
    setEnvOverride('COMPOSIO_ORG_ID', null);
    setEnvOverride('COMPOSIO_PROJECT_ID', null);
  }
});

test('changing user-key project scope replaces both saved sessions and catalog requests', async () => {
  setEnvOverride('COMPOSIO_API_KEY', 'uak_developer');
  setEnvOverride('COMPOSIO_ORG_ID', 'org-test');
  setEnvOverride('COMPOSIO_PROJECT_ID', 'project-one');
  const requested: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    if (new URL(url).hostname !== 'backend.composio.dev') return backgroundFetch(url);
    assert.equal(init.headers['x-user-api-key'], 'uak_developer');
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.headers['x-org-id'], 'org-test');
    requested.push(init.headers['x-project-id']);
    return Response.json({ items: [] });
  });
  try {
    const first = composio();
    mock.method(first, 'create', async () => ({ sessionId: 'project-one-session' }));
    await sessionFor('owner');
    await catalog();
    setEnvOverride('COMPOSIO_PROJECT_ID', 'project-two');
    const second = composio();
    assert.notEqual(first, second);
    mock.method(second, 'use', async () => { throw new Error('Must not reuse a session from another project'); });
    mock.method(second, 'create', async () => ({ sessionId: 'project-two-session' }));
    assert.equal((await sessionFor('owner')).sessionId, 'project-two-session');
    await catalog();
    assert.deepEqual(requested, ['project-one', 'project-two']);
  } finally {
    fetchMock.mock.restore();
    setEnvOverride('COMPOSIO_API_KEY', null);
    setEnvOverride('COMPOSIO_ORG_ID', null);
    setEnvOverride('COMPOSIO_PROJECT_ID', null);
  }
});

test('catalog API exposes every app across pages, preserves filters and bounds malformed pagination', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const app = new Hono().route('/api', api);
  const { client } = freshClient();
  mock.method(client.connectedAccounts, 'list', async ({ userIds }: any) => ({ items: userIds[0] === 'owner' ? [{ id: 'last', toolkit: { slug: 'app1722' }, status: 'ACTIVE' }] : [], nextCursor: null }));
  const items = Array.from({ length: 1723 }, (_, i) => ({ slug: `app${i}`, name: `App ${i}`, meta: { categories: [{ name: i % 2 ? 'Code' : 'Productivity' }] } }));
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    if (new URL(url).hostname !== 'backend.composio.dev') return backgroundFetch(url);
    const offset = Number(new URL(url).searchParams.get('cursor') ?? 0);
    return Response.json({ items: items.slice(offset, offset + 500), next_cursor: offset + 500 < items.length ? String(offset + 500) : null });
  });
  const page = async (query: string, user = 'owner') => {
    const r = await app.request(`/api/apps?${query}`, { headers: { cookie: `swarm_session=${user}` } });
    assert.equal(r.status, 200);
    return await r.json() as any;
  };
  try {
    const first = await page('');
    assert.equal(first.total, 1723);
    assert.equal(first.apps.length, 60);
    assert.equal(first.nextOffset, 60);
    assert.equal(first.connectedApps[0].slug, 'app1722');
    const seen = new Set<string>();
    let offset: number | null = 0;
    do {
      const r = await page(`offset=${offset}&limit=200`);
      for (const item of r.apps) { assert.ok(!seen.has(item.slug)); seen.add(item.slug); }
      offset = r.nextOffset;
    } while (offset !== null);
    assert.equal(seen.size, 1723);
    const filtered = await page('search=App%201&category=code&limit=3&offset=3');
    assert.equal(filtered.apps.length, 3);
    assert.ok(filtered.apps.every((a: any) => a.name.startsWith('App 1') && a.categories.includes('Code')));
    assert.equal(filtered.nextOffset, 6);
    for (const bad of ['-1', 'NaN', 'Infinity', '1.5', '1e9', '9007199254740992']) {
      const r = await page(`offset=${bad}&limit=${bad}`);
      assert.equal(r.apps.length, 60);
      assert.equal(r.apps[0].slug, 'app0');
    }
    assert.equal((await page('limit=9999')).apps.length, 200);
    assert.equal((await page('limit=0')).apps.length, 1);
    const end = await page('offset=9999');
    assert.deepEqual(end.apps, []);
    assert.equal(end.nextOffset, null);
    assert.deepEqual((await page('', 'other')).connectedApps, []);
  } finally { fetchMock.mock.restore(); }
});

test('popular connections precede pagination and grouped filters include everyday apps', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const { APP_CATEGORIES } = await import('../server/src/app-catalog.js');
  const app = new Hono().route('/api', api);
  const { client } = freshClient();
  mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'gmail-account', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }], nextCursor: null }));
  const popular = APP_CATEGORIES.flatMap(group => group.slugs);
  assert.equal(popular.length, 40);
  assert.equal(new Set(popular).size, 40);
  const categories: Record<string, string> = { gmail: 'email', slack: 'team chat', googlecalendar: 'scheduling & booking', googledrive: 'file management & storage' };
  const items = [
    ...Array.from({ length: 80 }, (_, i) => ({ slug: `other${i}`, name: `Other ${i}`, meta: { categories: [{ name: 'email' }] } })),
    ...[...popular].reverse().map(slug => ({ slug, name: slug, meta: { categories: [{ name: categories[slug] ?? 'other' }] } })),
  ];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => {
    if (new URL(url).hostname !== 'backend.composio.dev') return backgroundFetch(url);
    return Response.json({ items });
  });
  const page = async (query = '') => {
    const response = await app.request(`/api/apps?${query}`, { headers: { cookie: 'swarm_session=owner' } });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  try {
    const first = await page();
    assert.deepEqual(first.apps.slice(0, 40).map((item: any) => item.slug), popular);
    assert.equal(first.apps[0].connected, true);
    assert.deepEqual(first.connectedApps.map((item: any) => item.slug), ['gmail']);
    assert.equal(first.total, 120);
    assert.equal(first.nextOffset, 60);
    const second = await page('offset=60');
    assert.deepEqual([...first.apps, ...second.apps].slice(40).map((item: any) => item.slug), Array.from({ length: 80 }, (_, i) => `other${i}`));
    assert.equal(second.nextOffset, null);
    const communication = await page('category=communication');
    assert.ok(communication.apps.some((item: any) => item.slug === 'gmail'));
    assert.ok(communication.apps.some((item: any) => item.slug === 'slack'));
    assert.ok(communication.apps.some((item: any) => item.slug === 'other0'), 'category browsing includes non-featured apps');
    assert.ok(!communication.apps.some((item: any) => item.slug === 'googlecalendar'));
    const productivity = await page('category=productivity&search=google');
    assert.deepEqual(productivity.apps.map((item: any) => item.slug), ['googlecalendar', 'googledrive', 'googledocs', 'googlesheets']);
    assert.deepEqual((await page('category=team%20chat')).apps.map((item: any) => item.slug), ['slack'], 'provider categories remain available');
  } finally { fetchMock.mock.restore(); }
});

test('one project gives each user a separate session and deduplicates concurrent first use', async () => {
  const { created } = freshClient();
  const [one, same, other] = await Promise.all([sessionFor('owner'), sessionFor('owner'), sessionFor('other')]);
  assert.equal(one, same);
  assert.notEqual(one.sessionId, other.sessionId);
  assert.deepEqual(created.sort(), ['other', 'owner']);
  await assert.rejects(executeComposio('other', 'READ', {}), /Unsupported/);
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

test('prompt connection caching shares requests, isolates users and invalidates on connection changes', async () => {
  const { client } = freshClient();
  let active = 'gmail';
  const list = mock.method(client.connectedAccounts, 'list', async ({ userIds }: any) => ({
    items: [{ id: userIds[0], toolkit: { slug: userIds[0] === 'owner' ? active : 'slack' }, status: 'ACTIVE' }], nextCursor: null,
  }));
  const [a, b] = await Promise.all([connectedToolkits('owner', true), connectedToolkits('owner', true)]);
  assert.equal(list.mock.callCount(), 1);
  a.clear();
  assert.deepEqual([...b], ['gmail']);
  assert.deepEqual([...await connectedToolkits('other', true)], ['slack']);
  active = 'calendar';
  assert.deepEqual([...await connectedToolkits('owner', true)], ['gmail']);
  // Management/authorization reads must not use the prompt's cached view.
  assert.deepEqual([...await connectedToolkits('owner')], ['calendar']);
  invalidateComposioSession('owner');
  assert.deepEqual([...await connectedToolkits('owner', true)], ['calendar']);
});

test('prompt connection cache expires and failed reads can retry', async () => {
  const { client } = freshClient();
  let fail = true;
  const list = mock.method(client.connectedAccounts, 'list', async () => {
    if (fail) throw new Error('offline');
    return { items: [], nextCursor: null };
  });
  await assert.rejects(connectedToolkits('owner', true), /offline/);
  fail = false;
  await connectedToolkits('owner', true);
  const future = Date.now() + 31_000;
  const clock = mock.method(Date, 'now', () => future);
  try { await connectedToolkits('owner', true); } finally { clock.mock.restore(); }
  assert.equal(list.mock.callCount(), 3);
});

test('agents receive only the ownership-enforcing app adapter', async () => {
  const { composioTools } = await import('../server/src/composio.js');
  freshClient();
  assert.deepEqual((await composioTools('owner')).map(t=>t.name), ['SWARM_APPS_SEARCH','SWARM_APPS_EXECUTE']);
  for (const tool of ['COMPOSIO_REMOTE_WORKBENCH','COMPOSIO_PROXY_EXECUTE','SEND_EMAIL']) await assert.rejects(executeComposio('owner',tool,{}),/Unsupported/);
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
  mock.method(client.connectedAccounts, 'list', async()=>({items:[{id:'gmail-owner',toolkit:{slug:'gmail'},status:'ACTIVE'}]}));
  mock.method(client.tools, 'getRawComposioToolBySlug', async()=>({toolkit:{slug:'gmail'},version:'20260101_00'}));
  let calls=0;
  mock.method(client.tools,'execute',async(_slug,args)=>{calls++;assert.equal(args.userId,'owner');assert.equal(args.connectedAccountId,'gmail-owner');throw new Error('gone');});
  const args={connectionId:'gmail-owner',revision:1,tool_slug:'GMAIL_SEND_EMAIL',arguments:{}};
  await assert.rejects(executeComposio('other','SWARM_APPS_EXECUTE',{...args,connectionId:'foreign'}),/not found/);
  await assert.rejects(executeComposio('owner','SWARM_APPS_EXECUTE',args),/gone/);
  assert.equal(calls,1);
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
  // Event bursts within a minute are combined into one run (routine-limits.ts): let a minute pass.
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now() - 61_000, 'event-routine');
  await new Promise((r) => setTimeout(r, 20));
  nextDelivery({ id: 'event-trigger', payload: {} });
  assert.equal(delivered.length, 2);
  setEnvOverride('COMPOSIO_API_KEY', null);
  await refreshTriggerSubscription();
  assert.equal(nextStop.mock.callCount(), 1);
  nextDelivery({ id: 'event-trigger', payload: {} });
  assert.equal(delivered.length, 2);
});

test('native app connection callbacks retain the initiating account across browser cookie jars and reject tampering', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../server/src/routes.js');
  const app = new Hono().route('/api', api);
  const { client } = freshClient();
  let callback = '';
  mock.method(client, 'create', async () => ({ sessionId: 'native-connection-session', authorize: async (_slug: string, options: any) => {
    callback = options.callbackUrl;
    return { id: 'native-gmail', redirectUrl: 'https://connect.example.com/authorize' };
  } }));
  const checked: string[] = [];
  mock.method(client.connectedAccounts, 'list', async ({ userIds }: any) => {
    checked.push(userIds[0]);
    return { items: userIds[0] === 'owner' ? [{ id: 'native-gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] : [], nextCursor: null };
  });
  const start = await app.request('/api/apps/gmail/connect', { method: 'POST', headers: { cookie: 'swarm_session=owner', 'content-type': 'application/json', 'user-agent': 'SwarmNative/1.0' }, body: '{}' });
  assert.equal(start.status, 200);
  const target = new URL(callback);
  assert.equal(target.searchParams.get('native'), '1');
  assert.equal(target.searchParams.get('u'), 'owner');
  const visit = (url: URL) => app.request(url.pathname + url.search, { headers: { cookie: 'swarm_session=other' } });
  assert.match(await (await visit(target)).text(), /App connected/);
  assert.equal(checked.at(-1), 'owner', 'the browser account cannot replace the signed initiating account');
  const previous = checked.length;
  for (const [key, value] of [['u', 'other'], ['slug', 'slack'], ['bot', 'another-bot'], ['seq', '10'], ['expires', '1'], ['sig', 'wrong']]) {
    const changed = new URL(target);
    changed.searchParams.set(key, value);
    assert.match(await (await visit(changed)).text(), /Connection not confirmed/);
  }
  assert.equal(checked.length, previous, 'invalid callbacks do not query or modify connections');
});
