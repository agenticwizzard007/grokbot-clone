import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { attachSupervisor, type SupervisorDriver } from '../server/src/runtime/supervisor.js';

const tenantId = 'usr_concurrency_test';
const policy = { tenantId, root: '/private/tenant', runnerImage: `runner@sha256:${'a'.repeat(64)}`, mcpImage: `mcp@sha256:${'b'.repeat(64)}`, network: 'tenant-egress' };
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(done => setTimeout(done, 5)); }
  throw new Error('Supervisor condition did not settle');
}

async function fixture(t: any) {
  const workers: any[] = [], removed: string[] = [], resets: string[] = [], clients: WebSocket[] = [];
  const removalHolds = new Map<string, ReturnType<typeof defer>>();
  const removalFailures = new Set<string>(), confirmedRemoved = new Set<string>();
  let resetHold: ReturnType<typeof defer> | undefined;
  const driver: SupervisorDriver = {
    start(args) {
      const child = new EventEmitter() as any;
      const worker = { name: args[args.indexOf('--name') + 1], args, child, messages: [] as any[], killed: false, reply: (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n') };
      child.stdout = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        for (const line of chunk.toString().trim().split('\n')) worker.messages.push(JSON.parse(line));
        if (worker.messages.length === 1) worker.reply({ type: 'ready' });
        callback();
      } });
      child.kill = () => { worker.killed = true; child.emit('close', 0); return true; };
      workers.push(worker);
      return child;
    },
    async remove(name) {
      removed.push(name);
      await removalHolds.get(name)?.promise;
      if (removalFailures.has(name)) throw new Error('Simulated container removal failed.');
      confirmedRemoved.add(name);
    },
    async resetProfile(dir) { resets.push(dir); await resetHold?.promise; },
  };
  const server = http.createServer();
  const supervisor = attachSupervisor(server, policy, driver);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    removalFailures.clear();
    for (const hold of removalHolds.values()) hold.resolve(); resetHold?.resolve();
    for (const ws of clients) ws.terminate();
    await supervisor.close(); await new Promise<void>(done => server.close(() => done()));
  });
  async function open(route = '/cli') {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${route}`), frames: any[] = [];
    clients.push(ws); ws.on('error', () => {});
    ws.on('message', data => frames.push(JSON.parse(data.toString())));
    const closed = new Promise<void>(done => ws.once('close', () => done()));
    await once(ws, 'open');
    return { ws, frames, closed };
  }
  async function connect(message: any = {}, route = '/cli') {
    const connection = await open(route);
    const { ws } = connection;
    ws.send(JSON.stringify({ tenantId, provider: 'codex', operation: 'generate', params: { provider: 'codex' }, ...message }));
    return connection;
  }
  return { connect, open, close: supervisor.close, workers, removed, removalHolds, removalFailures, confirmedRemoved, resets, holdReset: () => resetHold = defer() };
}

test('36 same-provider generations, status and catalog start together without a slot queue or provider lock', async t => {
  const f = await fixture(t);
  const calls = await Promise.all(Array.from({ length: 36 }, () => f.connect()));
  const status = await f.connect({ operation: 'status' });
  const catalog = await f.connect({ operation: 'catalog' });
  await until(() => f.workers.length === 38 && [...calls, status, catalog].every(c => c.frames.some(v => v.type === 'ready')));
  assert.equal(f.removed.length, 0, 'every worker starts while all previous workers are still running');
  for (const [i, worker] of f.workers.entries()) {
    assert.ok(worker.args.includes('--read-only'));
    assert.ok(worker.args.includes('--cap-drop=ALL'));
    assert.ok(worker.args.includes('type=bind,src=/private/tenant/subscriptions/codex,dst=/home/runner'));
    worker.reply({ type: 'result', result: { request: i } });
  }
  await Promise.all([...calls, status, catalog].map(c => c.closed));
  assert.equal(f.removed.length, 38);
  assert.ok([...calls, status, catalog].every(c => c.frames.filter(v => v.type === 'result').length === 1));
  assert.equal(new Set([...calls, status, catalog].map(c => c.frames.find(v => v.type === 'result').result.request)).size, 38);
});

test('cancelling one overlapping request does not stop its sibling requests', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), c = await f.connect({ provider: 'claude' });
  await until(() => f.workers.length === 3);
  a.ws.close(); await a.closed; await until(() => f.workers[0].killed);
  assert.equal(f.workers[1].killed, false); assert.equal(f.workers[2].killed, false);
  f.workers[1].reply({ type: 'result', result: { text: 'second' } });
  f.workers[2].reply({ type: 'result', result: { text: 'third' } });
  await Promise.all([b.closed, c.closed]);
  assert.equal(b.frames.at(-1).result.text, 'second'); assert.equal(c.frames.at(-1).result.text, 'third');
});

test('sign-in cancels its provider workers and waits for container removal before changing credentials', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), other = await f.connect({ provider: 'claude' });
  await until(() => f.workers.length === 3);
  for (const worker of f.workers.slice(0, 2)) f.removalHolds.set(worker.name, defer());
  const login = await f.connect({ operation: 'login' });
  await until(() => f.removed.length === 2);
  assert.equal(f.workers.length, 3, 'no login process before the old workers finish teardown');
  assert.equal(f.workers[2].killed, false, 'other provider continues');
  const blocked = await f.connect(); await blocked.closed;
  assert.equal(f.workers.length, 3, 'credential changes remain exclusive');
  for (const hold of f.removalHolds.values()) hold.resolve();
  await until(() => f.workers.length === 4 && login.frames.some(v => v.type === 'ready'));
  login.ws.send(JSON.stringify({ type: 'input', data: 'authorization code\r' }));
  await until(() => f.workers[3].messages.length === 2);
  assert.equal(f.workers[3].messages[1].data, 'authorization code\r');
  f.workers[3].reply({ type: 'result', result: { exitCode: 0 } }); await login.closed;
  const next = await f.connect(); await until(() => f.workers.length === 5);
  f.workers[4].reply({ type: 'result', result: {} }); f.workers[2].reply({ type: 'result', result: {} });
  await Promise.all([a.closed, b.closed, other.closed, next.closed]);
});

test('disconnect waits for all provider workers and keeps the profile exclusive through cancelled deletion', async t => {
  const f = await fixture(t);
  const generation = await f.connect(); await until(() => f.workers.length === 1);
  const hold = defer(); f.removalHolds.set(f.workers[0].name, hold);
  const reset = f.holdReset(), deletion = await f.connect({ operation: 'delete' });
  await until(() => f.removed.length === 1);
  assert.deepEqual(f.resets, []);
  hold.resolve(); await until(() => f.resets.length === 1);
  assert.deepEqual(f.resets, ['/private/tenant/subscriptions/codex']);
  deletion.ws.close(); await deletion.closed;
  const blocked = await f.connect(); await blocked.closed;
  assert.equal(f.workers.length, 1, 'profile cannot be reused while deletion is incomplete');
  reset.resolve(); await new Promise(done => setTimeout(done, 10));
  const next = await f.connect(); await until(() => f.workers.length === 2);
  f.workers[1].reply({ type: 'result', result: {} }); await Promise.all([generation.closed, next.closed]);
});

test('CLI concurrency does not bypass ownership or relax the independent MCP limit', async t => {
  const f = await fixture(t);
  const wrongOwner = await f.connect({ tenantId: 'usr_other_owner' }); await wrongOwner.closed;
  assert.equal(f.workers.length, 0);
  const mcp = { id: 'mcp_connection1', config: { command: 'node', args: [] } };
  const servers = await Promise.all(Array.from({ length: 20 }, () => f.connect(mcp, '/mcp')));
  await until(() => f.workers.length === 20);
  const excess = await f.connect(mcp, '/mcp'); await excess.closed;
  const calls = await Promise.all(Array.from({ length: 24 }, () => f.connect()));
  await until(() => f.workers.length === 44);
  assert.equal(f.removed.length, 0, 'CLI requests start immediately even when all MCP slots are occupied');
  for (const worker of f.workers.slice(20)) worker.reply({ type: 'result', result: {} });
  await Promise.all(calls.map(c => c.closed));
  for (const c of servers) c.ws.close(); await Promise.all(servers.map(c => c.closed));
});

test('failed container removal blocks login and profile deletion until a successful cleanup retry', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const generation = await f.connect();
  await until(() => f.workers.length === 1 && generation.frames.some(frame => frame.type === 'ready'));
  const oldName = f.workers[0].name;
  f.removalFailures.add(oldName);

  for (const operation of ['login', 'delete']) {
    const mutation = await f.connect({ operation });
    await mutation.closed;
    assert.ok(f.removed.includes(oldName), `${operation} attempts to stop the earlier container`);
    assert.equal(f.confirmedRemoved.has(oldName), false);
    assert.equal(f.workers.length, 1, 'a failed Docker cleanup cannot start a new login container');
    assert.deepEqual(f.resets, [], 'a failed Docker cleanup cannot reset live credentials');
    assert.ok(!mutation.frames.some(frame => frame.type === 'ready' || frame.type === 'result'), 'failed cleanup must not acknowledge a credential change');
  }

  const attempts = f.removed.filter(name => name === oldName).length;
  f.removalFailures.delete(oldName);
  const retry = await f.connect({ operation: 'delete' });
  await retry.closed;
  assert.ok(f.removed.filter(name => name === oldName).length > attempts, 'the old active registration is retained and retried');
  assert.equal(f.confirmedRemoved.has(oldName), true);
  assert.deepEqual(f.resets, ['/private/tenant/subscriptions/codex']);
  assert.deepEqual(retry.frames.at(-1), { type: 'result', result: { ok: true } });

  // Successful cleanup must release the writer for immediate follow-up work.
  const login = await f.connect({ operation: 'login' });
  await until(() => f.workers.length === 2 && login.frames.some(frame => frame.type === 'ready'));
  f.workers[1].reply({ type: 'result', result: { exitCode: 0 } });
  await login.closed;
  const next = await f.connect();
  await until(() => f.workers.length === 3 && next.frames.some(frame => frame.type === 'ready'));
  f.workers[2].reply({ type: 'result', result: {} });
  await Promise.all([generation.closed, next.closed]);
});

test('shutdown rejects arrivals and pending handshakes while awaiting held container teardown', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const generation = await f.connect();
  await until(() => f.workers.length === 1);
  const pendingHandshake = await f.open();
  const worker = f.workers[0], heldRemoval = defer();
  f.removalHolds.set(worker.name, heldRemoval);
  const closing = f.close();
  let finished = false;
  const observed = closing.then(() => { finished = true; });
  pendingHandshake.ws.send(JSON.stringify({ tenantId, provider: 'codex', operation: 'generate', params: { provider: 'codex' } }));
  await until(() => f.removed.includes(worker.name));
  await Promise.all([generation.closed, pendingHandshake.closed]);
  assert.equal(finished, false, 'shutdown must wait for confirmed container removal');
  assert.equal(worker.killed, false, 'the held teardown has not yet finished');
  await assert.rejects(f.connect(), 'new upgrades are refused during teardown');
  assert.equal(f.workers.length, 1, 'neither a new upgrade nor an accepted pending handshake may start another container');
  assert.strictEqual(f.close(), closing, 'repeated shutdown calls share the same pending cleanup');

  heldRemoval.resolve();
  await observed;
  assert.equal(f.confirmedRemoved.has(worker.name), true);
  assert.equal(worker.killed, true);
  assert.equal(f.removed.filter(name => name === worker.name).length, 1, 'overlapping close callbacks do not duplicate removal');
  await assert.rejects(f.connect(), 'completed shutdown continues refusing arrivals');
  assert.equal(f.workers.length, 1);
});

test('failed shutdown can retry container removal after the driver recovers without reopening admission', async t => {
  const f = await fixture(t);
  const generation = await f.connect();
  await until(() => f.workers.length === 1 && generation.frames.some(frame => frame.type === 'ready'));
  const name = f.workers[0].name;
  f.removalFailures.add(name);
  await assert.rejects(f.close(), /shutdown could not stop every container/);
  assert.equal(f.confirmedRemoved.has(name), false);
  await assert.rejects(f.connect());
  const attempts = f.removed.filter(candidate => candidate === name).length;

  f.removalFailures.delete(name);
  await f.close();
  assert.ok(f.removed.filter(candidate => candidate === name).length > attempts, 'a later shutdown retries the retained worker');
  assert.equal(f.confirmedRemoved.has(name), true);
  await assert.rejects(f.connect());
  assert.equal(f.workers.length, 1, 'retrying teardown never reopens workload admission');
});
