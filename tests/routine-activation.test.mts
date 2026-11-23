// P-07: local development API, temporary SQLite and mocked model/toolkit backends only.
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-activation-'));
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'activation-fixture-only', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: 'mock-toolkit', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async input => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Unmocked backend request refused.');
});
const { db } = await import('../server/src/db.js');
const { composio } = await import('../server/src/composio.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { initTriggers, refreshTriggerSubscription, createEventRoutine } = await import('../server/src/triggers.js');
const { initSubagents } = await import('../server/src/agent/subagents.js'); initSubagents();
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
const login = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'activation@example.test', name: 'Fixture' }) });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().find(value => value.startsWith('swarm_session='))!.split(';')[0];
const bot = (await (await app.request('/api/bots', { headers: { cookie } })).json()).bots[0];
let client = composio(), sequence = 0;
await initTriggers(() => {});
beforeEach(async () => {
  db.prepare('DELETE FROM routines').run();
  setEnvOverride('COMPOSIO_API_KEY', `mock-toolkit-${++sequence}`);
  client = composio();
  (client.triggers as any).pusherService.connection = { channel: { subscribed: true, bind() {}, unbind() {} } };
  mock.method(client.triggers, 'subscribe', async () => {});
  mock.method(client.triggers, 'unsubscribe', async () => {});
  mock.method(client.triggers, 'enable', async () => ({}));
  mock.method(client.triggers, 'disable', async () => ({}));
  await refreshTriggerSubscription();
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture(id: string, enabled = 0) {
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id,enabled) VALUES(?,?,?,'Local prompt','event:TEST_EVENT',?,?,?)")
    .run(id, bot.id, id, Date.now(), `trigger-${id}`, enabled);
}
const row = (id: string) => db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;
const toggle = (id: string, enabled: boolean) => app.request(`/api/routines/${id}`, {
  method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function listed(id: string) {
  const response = await app.request(`/api/bots/${bot.id}/routines`, { headers: { cookie } });
  return (await response.json()).routines.find((r: any) => r.id === id);
}

test('P-07: API enable and pause wait for provider success and expose pending state', async () => {
  fixture('delayed');
  for (const enabled of [true, false]) {
    const started = deferred(), release = deferred();
    const operation = mock.method(client.triggers, enabled ? 'enable' : 'disable', async () => {
      started.resolve(); await release.promise; return {};
    });
    let settled = false;
    const response = toggle('delayed', enabled).then(r => { settled = true; return r; });
    await started.promise;
    assert.equal(settled, false);
    assert.equal(row('delayed').enabled, enabled ? 0 : 1);
    assert.equal((await listed('delayed')).activationPending, true);
    release.resolve();
    assert.equal((await response).status, 200);
    assert.equal(row('delayed').enabled, enabled ? 1 : 0);
    assert.equal((await listed('delayed')).activationPending, false);
    operation.mock.restore();
  }
});

test('P-07: provider rejection is bounded, visible, and recoverable without false success', async () => {
  fixture('failure');
  const enable = mock.method(client.triggers, 'enable', async () => { throw Error('private-provider-detail'); });
  const failed = await toggle('failure', true);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-provider-detail/);
  assert.equal(enable.mock.callCount(), 3);
  assert.equal(row('failure').enabled, 0);
  assert.equal(row('failure').activation_target, 1);
  assert.match((await listed('failure')).activationError, /activation failed/);
  enable.mock.restore();
  assert.equal((await toggle('failure', true)).status, 200);
  assert.equal(row('failure').enabled, 1);
  assert.equal(row('failure').activation_error, null);
  const disable = mock.method(client.triggers, 'disable', async () => { throw Error('provider unavailable'); });
  assert.equal((await toggle('failure', false)).status, 502);
  assert.equal(disable.mock.callCount(), 3);
  assert.equal(row('failure').enabled, 1);
  assert.match((await listed('failure')).activationError, /pause failed/);
  disable.mock.restore();
  assert.equal((await toggle('failure', false)).status, 200);
  assert.equal(row('failure').enabled, 0);
});

test('P-07: initial subscription failure retries and cannot activate or create a routine', async () => {
  fixture('subscription');
  const subscribe = mock.method(client.triggers, 'subscribe', async () => { throw Error('subscription unavailable'); });
  const enable = mock.method(client.triggers, 'enable', async () => ({}));
  const create = mock.method(client.triggers, 'create', async () => ({ triggerId: 'new-trigger' }));
  assert.equal((await toggle('subscription', true)).status, 502);
  assert.equal(subscribe.mock.callCount(), 3);
  assert.equal(enable.mock.callCount(), 0);
  assert.equal(row('subscription').enabled, 0);
  await assert.rejects(createEventRoutine(bot.userId, bot.id, { name: 'New routine', prompt: 'Fixture', trigger_slug: 'TEST_EVENT' }));
  assert.equal(create.mock.callCount(), 0);
  subscribe.mock.restore();
  assert.equal((await toggle('subscription', true)).status, 200);
});

test('P-07: concurrent routines share subscription readiness and same-routine changes stay ordered', async () => {
  fixture('first'); fixture('second');
  const started = deferred(), release = deferred();
  const subscribe = mock.method(client.triggers, 'subscribe', async () => { started.resolve(); await release.promise; });
  const first = toggle('first', true);
  await started.promise;
  const second = toggle('second', true), pause = toggle('first', false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(row('first').enabled, 0); assert.equal(row('second').enabled, 0);
  release.resolve();
  assert.deepEqual((await Promise.all([first, second, pause])).map(r => r.status), [200, 200, 200]);
  assert.equal(subscribe.mock.callCount(), 1);
  assert.equal(row('first').enabled, 0); assert.equal(row('second').enabled, 1);
});

test('P-07: transient failures recover within the retry budget and missing triggers fail clearly', async () => {
  fixture('transient'); fixture('missing');
  let attempts = 0;
  mock.method(client.triggers, 'enable', async () => { if (++attempts < 3) throw Error('temporary'); return {}; });
  assert.equal((await toggle('transient', true)).status, 200);
  assert.equal(attempts, 3);
  db.prepare('UPDATE routines SET trigger_id=NULL WHERE id=?').run('missing');
  assert.equal((await toggle('missing', true)).status, 502);
  assert.equal(row('missing').enabled, 0);
});

test('P-07: failed creation keeps a disabled recovery record', async () => {
  mock.method(client.triggers, 'create', async () => ({ triggerId: 'created-trigger' }));
  mock.method(client.triggers, 'enable', async () => { throw Error('temporary'); });
  await assert.rejects(createEventRoutine(bot.userId, bot.id, { name: 'Saved fixture', prompt: 'Fixture', trigger_slug: 'TEST_EVENT' }), /activation failed/);
  const saved = db.prepare('SELECT * FROM routines WHERE trigger_id=?').get('created-trigger') as any;
  assert.equal(saved.enabled, 0); assert.equal(saved.activation_target, 1); assert.ok(saved.activation_error);
});

test('P-07: restart reconciles active, disabled, interrupted and failed changes', () => {
  fixture('active', 1); fixture('paused'); fixture('interrupted'); fixture('failed'); fixture('pause-interrupted', 1);
  db.prepare('UPDATE routines SET activation_target=1 WHERE id IN (?,?)').run('interrupted', 'failed');
  db.prepare('UPDATE routines SET activation_target=0 WHERE id=?').run('pause-interrupted');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    globalThis.fetch = async () => { throw Error('Network refused.'); };
    const {composio} = await import('./server/src/composio.ts');
    const triggers = composio().triggers;
    triggers.pusherService.connection = { channel: { subscribed: true, bind() {}, unbind() {} } };
    triggers.subscribe = async () => {};
    triggers.enable = async id => { if(id === 'trigger-failed') throw Error('unavailable'); };
    triggers.disable = async id => { console.log('DISABLED',id); };
    const {initTriggers} = await import('./server/src/triggers.ts');
    await initTriggers(() => {});
    const {db} = await import('./server/src/db.ts'); db.close();
  `], { env: process.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  for (const id of ['active', 'interrupted']) { assert.equal(row(id).enabled, 1); assert.equal(row(id).activation_target, null); }
  for (const id of ['paused', 'pause-interrupted']) { assert.equal(row(id).enabled, 0); assert.match(child.stdout, new RegExp(`DISABLED trigger-${id}`)); }
  assert.equal(row('failed').enabled, 0); assert.ok(row('failed').activation_error);
});

test('P-07: tenant gateway rejection is awaited, bounded and recoverable', () => {
  const tenant = 'usr_activation_fixture';
  const manifest = path.join(root, 'tenant-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ tenantId: tenant, volumeId: 'fixture-volume' }));
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'tenant', DEV_LOGIN: '1', SESSION_SECRET: 'tenant-activation-fixture',
    SWARM_TENANT_ID: tenant, SWARM_VOLUME_ID: 'fixture-volume', TENANT_MANIFEST_FILE: manifest,
    TENANT_DATA_KEY_FILE: path.join(root, 'unused-key'), DB_PATH: path.join(root, 'tenant.db'),
    FILES_DIR: path.join(root, 'tenant-files'), COMPUTER_PROVIDER: 'local',
    COMPOSIO_GATEWAY_URL: 'https://gateway.test', RUNTIME_TOKEN_FILE: '/run/swarm/activation-fixture',
  };
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    const readFile = fs.readFile;
    fs.readFile = async (...args) => args[0] === '/run/swarm/activation-fixture' ? 'mock-runtime-token' : readFile(...args);
    let fail = true;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://gateway.test/rpc');
      const request = JSON.parse(init.body); requests.push(request.operation);
      return fail ? Response.json({}, {status:503}) : Response.json({ok:true});
    };
    const {db} = await import('./server/src/db.ts');
    const {setEventRoutineEnabled,initTriggers} = await import('./server/src/triggers.ts');
    const {scheduleRoutine,unscheduleRoutine} = await import('./server/src/routines.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('${tenant}','fixture@example.test','Fixture',1);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('bot','${tenant}','Fixture',1,1);
    db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id,enabled) VALUES('rt','bot','Fixture','Fixture','event:TEST',1,'trigger',0)").run();
    const row = () => db.prepare("SELECT * FROM routines WHERE id='rt'").get();
    await assert.rejects(scheduleRoutine({id:'rt',schedule:'event:TEST'}), /activation failed/);
    assert.deepEqual(requests, ['trigger-enable','trigger-enable','trigger-enable']);
    assert.equal(row().enabled,0); assert.ok(row().activation_error);
    fail = false; await setEventRoutineEnabled('rt',true);
    assert.equal(row().enabled,1); assert.equal(row().activation_error,null);
    fail = true; await assert.rejects(unscheduleRoutine('rt'), /pause failed/);
    assert.equal(row().enabled,1); assert.equal(row().activation_target,0);
    fail = false; await initTriggers(() => {});
    assert.equal(row().enabled,0); assert.equal(row().activation_target,null);
    assert.equal(requests.at(-1),'trigger-disable');
    db.close();
  `], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
});

test('P-07: SDK setup completion waits for channel authorization and later errors clear enabled state', async () => {
  fixture('channel');
  const callbacks = new Map<string, () => void>();
  let reportError!: () => void;
  const channel = { subscribed: false, bind: (event: string, callback: () => void) => callbacks.set(event, callback),
    unbind: (event: string) => callbacks.delete(event) };
  (client.triggers as any).pusherService.connection = { channel };
  mock.method(client.triggers, 'subscribe', async (_callback: any, _filters: any, onError: () => void) => { reportError = onError; });
  let settled = false;
  const response = toggle('channel', true).then(r => { settled = true; return r; });
  while (!callbacks.has('pusher:subscription_succeeded')) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);
  assert.equal(row('channel').enabled, 0);
  channel.subscribed = true;
  callbacks.get('pusher:subscription_succeeded')!();
  assert.equal((await response).status, 200);
  assert.equal(row('channel').enabled, 1);
  assert.equal(callbacks.size, 0);
  reportError();
  assert.equal(row('channel').enabled, 0);
  assert.match(row('channel').activation_error, /could not connect/);
  assert.equal((await toggle('channel', true)).status, 200);
});

test('P-07: unsupported SDK readiness fails closed', async () => {
  fixture('unsupported');
  (client.triggers as any).pusherService.connection = undefined;
  assert.equal((await toggle('unsupported', true)).status, 502);
  assert.equal(row('unsupported').enabled, 0);
});

test('P-07: channel authorization has a bounded timeout and removes readiness listeners', async t => {
  const { waitForTriggerSubscription } = await import('../server/src/trigger-subscription.js');
  const callbacks = new Map<string, () => void>();
  (client.triggers as any).pusherService.connection = { channel: { subscribed: false,
    bind: (event: string, callback: () => void) => callbacks.set(event, callback), unbind: (event: string) => callbacks.delete(event) } };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(waitForTriggerSubscription(client), /subscription failed/);
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(callbacks.size, 0);
});

test('P-07: pending activation still reserves the existing routine cap', async () => {
  const { routineLimits } = await import('../server/src/routine-limits.js');
  const previousLimit = routineLimits.maxPerBot;
  routineLimits.maxPerBot = 1;
  fixture('reserved'); fixture('over-cap');
  const started = deferred(), release = deferred();
  mock.method(client.triggers, 'enable', async () => { started.resolve(); await release.promise; return {}; });
  const first = toggle('reserved', true);
  try {
    await started.promise;
    assert.equal(row('reserved').enabled, 0);
    assert.equal((await toggle('over-cap', true)).status, 429);
    assert.equal(row('over-cap').activation_target, null);
  } finally { release.resolve(); routineLimits.maxPerBot = previousLimit; }
  assert.equal((await first).status, 200);
});
