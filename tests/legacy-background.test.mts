import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-legacy-background-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'), CLI_PROFILES_DIR: path.join(root, 'cli'), SESSION_SECRET: 'legacy-background-tests-only', COMPUTER_PROVIDER: 'cloudvm', VM_DRIVER: 'fake', COMPOSIO_API_KEY: '', SWARM_NO_SCHEDULER: '1', SERVER_URL: 'https://swarm.test' });
const { db } = await import('../server/src/db.js');
await import('../server/src/routes.js'); await import('../server/src/routes-config.js'); await import('../server/src/mcp/oauth.js');
const { initRooms } = await import('../server/src/agent/rooms.js'); initRooms();
const { initSubagents } = await import('../server/src/agent/subagents.js'); initSubagents();
const { holdLegacyDatabase, legacyWritableRows } = await import('../server/src/platform/legacy-database-fence.js');
const { withLegacyWork, drainLegacyBackground } = await import('../server/src/security/legacy-work.js');
const { drainLegacyProcess } = await import('../server/src/platform/legacy-process-drain.js');
const { stopLegacyCloud } = await import('../server/src/platform/legacy-cloud-drain.js');
const cloud = await import('../server/src/computers/cloudvm.js');
const provisioning = await import('../server/src/provisioning.js');
const inbox = await import('../server/src/messaging/inbox.js');
const bridge = await import('../server/src/messaging/bridge.js');
const { upsertLink } = await import('../server/src/messaging/store.js');
const local = await import('../server/src/computers/local.js');
const { attachComputerSockets } = await import('../server/src/computers/index.js');
const { setLocalAccess } = await import('../server/src/computers/local-access.js');
const cli = await import('../server/src/cli/bridge.js');
const { createCliPairing, authenticateCli } = await import('../server/src/cli/store.js');
const { startLoginSession } = await import('../server/src/cli/login.js');
const { profilePath } = await import('../server/src/cli/hosted.js');
const { onSessionRevoked } = await import('../server/src/security/session-lifecycle.js');
const { userFromToken, sessionHash } = await import('../server/src/lib/auth.js');
let sequence = 0;
function account() {
  const n = ++sequence, id = `usr_migrate_${String(n).padStart(8, '0')}`, phone = `1555000${String(n).padStart(4, '0')}`;
  db.prepare('INSERT INTO users(id,email,name,phone,created_at) VALUES(?,?,?,?,?)').run(id, `${id}@example.test`, id, phone, Date.now());
  return { id, phone };
}
function hold(id: string) { return holdLegacyDatabase(db, id, `migration:${id}:operation`, '1'); }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(fn: () => boolean) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Test condition not reached.'); }
function vm(owner: string, ext = `ext-${owner}`, status = 'stopped') {
  const vmId = `vm-${owner}`;
  db.prepare('INSERT INTO vms(vm_id,user_id,driver,ext_id,status,memory_mb,cpus,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(vmId, owner, 'fake', ext, status, 256, 1, Date.now(), Date.now());
  return vmId;
}
const event = (phone: string, id: string) => JSON.stringify({ event_type: 'imessage.received', data: { message: { id, remote_number: phone, content: 'hello' } } });
function addInbox(phone: string, id: string, status = 'pending', old = false) {
  db.prepare('INSERT INTO messaging_inbox(id,source,payload,status,next_at,created_at) VALUES(?,?,?,?,?,?)').run(id, 'inkbox', event(phone, id), status, Date.now(), old ? 1 : Date.now());
}
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('a hold during VM discovery prevents a late create and drains the lookup', async t => {
  const owner = account(), pending = deferred<any[]>(); let creates = 0;
  t.mock.method(cloud.driver, 'list', () => pending.promise);
  t.mock.method(cloud.driver, 'create', async () => { creates++; return { id: 'unwanted' }; });
  const creating = cloud.ensureVm(owner.id), rejected = assert.rejects(creating, /being migrated/);
  hold(owner.id);
  await assert.rejects(drainLegacyBackground(owner.id, 5), /not stopped/);
  pending.resolve([]); await rejected;
  assert.equal(creates, 0); await drainLegacyBackground(owner.id, 1000);
  assert.throws(() => cloud.ensureVm(owner.id), /being migrated/);
});

test('a create issued before a hold remains tracked and its late VM is retained for reconciliation', async t => {
  const owner = account(), pending = deferred<{ id: string }>(); let entered = false, destroys = 0;
  t.mock.method(cloud.driver, 'list', async () => []);
  t.mock.method(cloud.driver, 'create', async () => { entered = true; return pending.promise; });
  const creating = cloud.ensureVm(owner.id), rejected = assert.rejects(creating, /migration_hold/);
  await until(() => entered); hold(owner.id);
  await assert.rejects(drainLegacyBackground(owner.id, 5), /not stopped/);
  pending.resolve({ id: 'late-created' }); await rejected;
  const row = cloud.vmFor(owner.id)!;
  assert.equal(row.ext_id, null);
  t.mock.method(cloud.driver, 'list', async () => [{ id: 'late-created', vmId: row.vm_id, userId: owner.id, state: 'started' }]);
  t.mock.method(cloud.driver, 'destroy', async () => { destroys++; });
  await provisioning.reconcile(); assert.equal(destroys, 0);
  await drainLegacyBackground(owner.id, 1000);
});

test('provisioning skips held queued jobs without starving another account', async t => {
  const a = account(), b = account(); vm(a.id); vm(b.id);
  provisioning.enqueueVmJob('resize', { userId: a.id }); provisioning.enqueueVmJob('resize', { userId: b.id });
  hold(a.id); const resized: string[] = [];
  t.mock.method(cloud.driver, 'resize', async (id: string) => { resized.push(id); });
  provisioning.tick();
  await until(() => (db.prepare('SELECT status FROM provision_jobs WHERE user_id=?').get(b.id) as any).status === 'done');
  assert.deepEqual(resized, [`ext-${b.id}`]);
  assert.deepEqual(db.prepare('SELECT status,attempts FROM provision_jobs WHERE user_id=?').get(a.id), { status: 'pending', attempts: 0 });
  await assert.rejects(cloud.resizeVm(a.id), /being migrated/);
  await assert.rejects(cloud.suspendVm(a.id), /being migrated/);
  await assert.rejects(cloud.destroyVm(`vm-${a.id}`), /being migrated/);
});

test('inbox preserves held pending/history rows while handling and cleaning another owner', async () => {
  const a = account(), b = account(), handled: string[] = [];
  for (const owner of [a, b]) { addInbox(owner.phone, `pending-${owner.id}`); addInbox(owner.phone, `old-${owner.id}`, 'done', true); }
  hold(a.id);
  inbox.registerInboxHandler('inkbox', async p => { handled.push(p.data.message.remote_number); });
  await inbox.kick();
  assert.deepEqual(handled, [b.phone]);
  assert.equal((db.prepare('SELECT status FROM messaging_inbox WHERE id=?').get(`pending-${a.id}`) as any).status, 'pending');
  assert.ok(db.prepare('SELECT 1 FROM messaging_inbox WHERE id=?').get(`old-${a.id}`));
  assert.equal(db.prepare('SELECT 1 FROM messaging_inbox WHERE id=?').get(`old-${b.id}`), undefined);
});

test('in-flight inbox work is included in drain and a hold prevents replay/bookkeeping', async () => {
  const owner = account(), pending = deferred<void>(); let entered = false;
  addInbox(owner.phone, `running-${owner.id}`);
  inbox.registerInboxHandler('inkbox', async () => { entered = true; await pending.promise; });
  const processing = inbox.kick(); await until(() => entered); hold(owner.id);
  await assert.rejects(drainLegacyBackground(owner.id, 5), /not stopped/);
  pending.resolve(); await processing; await drainLegacyBackground(owner.id, 1000);
  assert.deepEqual(db.prepare('SELECT status,attempts FROM messaging_inbox WHERE id=?').get(`running-${owner.id}`), { status: 'pending', attempts: 0 });
});

test('queued outbound messages recheck holds after waiting and do not block another owner', async () => {
  const a = account(), b = account(), pending = deferred<string>(); const sent: string[] = [];
  for (const owner of [a, b]) upsertLink(owner.id, 'imessage', 'inkbox', { status: 'connected', phone: owner.phone });
  bridge.registerAdapter({ transport: 'inkbox', ready: () => true, format: s => s, maxChars: () => 1000, send: async (link, msg) => { sent.push(`${link.userId}:${msg.text}`); return link.userId === a.id ? pending.promise : 'sent-b'; } });
  const first = bridge.deliver(a.id, { text: 'first' }, { kind: 'system' });
  await until(() => sent.length === 1);
  const queued = bridge.deliver(a.id, { text: 'queued' }, { kind: 'system' }); hold(a.id);
  await bridge.deliver(b.id, { text: 'other' }, { kind: 'system' });
  await assert.rejects(drainLegacyBackground(a.id, 5), /not stopped/);
  pending.resolve('sent-a'); await Promise.all([first, queued]); await drainLegacyBackground(a.id, 1000);
  assert.deepEqual(sent, [`${a.id}:first`, `${b.id}:other`]);
});

test('shared housekeeping skips indirect held sessions and removes other expired rows', () => {
  const a = account(), b = account();
  for (const owner of [a, b]) {
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(`session-${owner.id}`, owner.id, 1, 2);
    db.prepare('INSERT INTO google_oidc_attempts(id,nonce,verifier,link_session,expires_at) VALUES(?,?,?,?,?)').run(`attempt-${owner.id}`, 'nonce', 'verifier', `session-${owner.id}`, 1);
  }
  hold(a.id);
  db.prepare(`DELETE FROM google_oidc_attempts WHERE expires_at<? AND ${legacyWritableRows(db, 'google_oidc_attempts')}`).run(Date.now());
  assert.ok(db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=?').get(`attempt-${a.id}`));
  assert.equal(db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=?').get(`attempt-${b.id}`), undefined);
});

test('process drain closes only owner streams, rejects reconnects and preserves credentials', async t => {
  const a = account(), b = account(), sockets: WebSocket[] = [];
  const server = http.createServer(); attachComputerSockets(server); cli.attachCliSocket(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const ws of sockets) ws.terminate(); await new Promise<void>(r => server.close(() => r())); });
  const origin = `ws://127.0.0.1:${(server.address() as any).port}`;
  const connect = async (route: string, token: string, extra = {}) => {
    const ws = new WebSocket(origin + route); sockets.push(ws); await once(ws, 'open');
    const result = new Promise<any>(r => { ws.once('message', data => r(JSON.parse(String(data)))); ws.once('close', code => r({ code })); });
    ws.send(JSON.stringify({ type: 'hello', token, name: 'test', platform: 'linux', mode: 'multi', version: 1, ...extra }));
    return { ws, result: await result };
  };
  const aToken = local.createPairing(a.id), bToken = local.createPairing(b.id), cliToken = createCliPairing(a.id);
  setLocalAccess(a.id, true); const macToken = local.nativeLocal.createPairing(a.id);
  for (const [route, token, extra] of [
    ['/api/companion', aToken, {}], ['/api/companion', bToken, {}],
    ['/api/companion/local', macToken, { platform: 'darwin-arm64', mode: 'desktop', desktop: true }],
    ['/api/cli-bridge', cliToken, {}],
  ] as const) assert.equal((await connect(route, token, extra)).result.type, 'welcome');
  // Respond to the initial bridge status request so it cannot outlive this test.
  // Drain actively cancels any pending request without touching the credential files.
  const secret = path.join(profilePath(a.id), '.codex', 'auth.json'); fs.mkdirSync(path.dirname(secret), { recursive: true }); fs.writeFileSync(secret, 'private-test-credential');
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(sessionHash(a.id), a.id, Date.now(), Date.now() + 60000);
  let revoked = 0; const unsubscribe = onSessionRevoked(sessionHash(a.id), () => { revoked++; }); t.after(unsubscribe);
  const receipt = hold(a.id);
  const drained = await drainLegacyProcess(receipt, 1000);
  assert.equal(drained.boundary, 'current-process-only'); assert.ok(!('filesFrozen' in drained)); assert.ok(!('writersStopped' in drained));
  assert.equal(revoked, 1); assert.equal(userFromToken(a.id), null);
  assert.equal(local.companionConnected(a.id), false); assert.equal(local.nativeLocal.companionConnected(a.id), false); assert.equal(local.companionConnected(b.id), true);
  assert.equal(authenticateCli(cliToken), null); assert.equal(fs.readFileSync(secret, 'utf8'), 'private-test-credential');
  assert.equal((await connect('/api/companion', aToken)).result.code, 4401);
  assert.equal((await connect('/api/cli-bridge', cliToken)).result.code, 4401);
  await assert.rejects(startLoginSession(a.id, 'codex', 80, 24), /being migrated/);
});

test('process drain times out held work and rejects a superseded fence without claiming quiescence', async () => {
  const owner = account(), pending = deferred<void>();
  const active = withLegacyWork(owner.id, () => pending.promise), receipt = hold(owner.id);
  await assert.rejects(drainLegacyProcess(receipt, 10), /timed out|not stopped/);
  pending.resolve(); await active;
  holdLegacyDatabase(db, owner.id, receipt.operation, '2');
  await assert.rejects(drainLegacyProcess(receipt), /fence changed/);
  assert.throws(() => withLegacyWork(owner.id, () => {}), /being migrated/);
});

test('cloud drain stops an exact owned desktop, observes stopped state and preserves database and disk references', async t => {
  const owner = account(), id = vm(owner.id, 'owned-machine', 'suspended'), receipt = hold(owner.id);
  let stopped = false, stops = 0;
  const info = () => ({ id: 'owned-machine', vmId: id, userId: owner.id, state: stopped ? 'stopped' : 'suspended' });
  t.mock.method(cloud.driver, 'list', async () => [info()]);
  t.mock.method(cloud.driver, 'get', async () => info());
  t.mock.method(cloud.driver, 'stop', async () => { stops++; stopped = true; });
  const result = await stopLegacyCloud(receipt, async () => {}, 1000);
  assert.equal(result.state, 'stopped'); assert.equal(result.boundary, 'legacy-desktop-only');
  assert.equal(stops, 1); assert.ok(!('filesFrozen' in result));
  assert.equal(cloud.vmFor(owner.id)?.status, 'suspended'); // source database remains frozen
});

test('cloud drain rejects foreign metadata and unresolved creation before any stop', async t => {
  const owner = account(), id = vm(owner.id), receipt = hold(owner.id); let stops = 0;
  t.mock.method(cloud.driver, 'list', async () => [{ id: 'ext-' + owner.id, vmId: id, userId: 'foreign', state: 'started' }]);
  t.mock.method(cloud.driver, 'stop', async () => { stops++; });
  await assert.rejects(stopLegacyCloud(receipt, async () => {}, 1000), /ownership/);
  const late = account(); vm(late.id, 'pending-machine', 'creating');
  await assert.rejects(stopLegacyCloud(hold(late.id), async () => {}, 1000), /reconciliation/);
  assert.equal(stops, 0);
});

test('cloud drain treats an accepted stop with a still-suspended VM as unproven', async t => {
  const owner = account(), id = vm(owner.id, 'suspended-machine', 'suspended'), receipt = hold(owner.id); let stops = 0;
  const info = { id: 'suspended-machine', vmId: id, userId: owner.id, state: 'suspended' };
  t.mock.method(cloud.driver, 'list', async () => [info]); t.mock.method(cloud.driver, 'get', async () => info);
  t.mock.method(cloud.driver, 'stop', async () => { stops++; });
  await assert.rejects(stopLegacyCloud(receipt, async () => {}, 150), /timed out|not been observed/);
  assert.equal(stops, 1);
});

test('cloud drain rechecks authorization after inventory waits and never issues a revoked stop', async t => {
  const owner = account(), id = vm(owner.id, 'revoked-machine', 'running'), receipt = hold(owner.id), inventory = deferred<any[]>();
  let entered = false, revoked = false, stops = 0;
  t.mock.method(cloud.driver, 'list', async () => { entered = true; return inventory.promise; });
  t.mock.method(cloud.driver, 'stop', async () => { stops++; });
  const stopping = stopLegacyCloud(receipt, async () => { if (revoked) throw new Error('lease revoked'); }, 1000);
  const rejected = assert.rejects(stopping, /lease revoked/);
  await until(() => entered); revoked = true;
  inventory.resolve([{ id: 'revoked-machine', vmId: id, userId: owner.id, state: 'started' }]); await rejected;
  assert.equal(stops, 0);
});
