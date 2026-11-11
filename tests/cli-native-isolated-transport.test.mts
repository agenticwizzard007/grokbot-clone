// node --import tsx --test tests/cli-native-isolated-transport.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, mock, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-isolated-'));
const tenantUserId = 'usr_native_transport_tenant', socketPath = path.join(temp, 'runner.sock');
Object.assign(process.env, { SWARM_ROLE: 'tenant', SWARM_TENANT_ID: tenantUserId, SWARM_RUNNER_SOCKET: '/run/swarm/native-transport-test.sock' });
// Keep the production socket allowlist intact while testing a real Unix socket
// without requiring root to create /run/swarm on a development machine.
const originalConnect = net.connect;
const privateDials: string[] = [];
mock.method(net, 'connect', (options: any, ...args: any[]) => {
  if (options.host === 'localhost') {
    assert.equal(options.path, process.env.SWARM_RUNNER_SOCKET, 'the subscription transport must dial its private Unix socket');
    privateDials.push(options.path);
    return originalConnect({ ...options, path: socketPath }, ...args);
  }
  return originalConnect(options, ...args);
});
const { isolatedRunner } = await import('../server/src/runtime/subscription-client.js');
const nativeTools = [{ name: 'read_app', parameters: { type: 'object' } }];
const params = { provider: 'codex', nativeTools, timeoutMs: 2000 };
const options = { tenantUserId, env: {}, codexPath: '', claudePath: '' };
const call = (id = 'same:string:1', args = {}) => ({ id, name: 'read_app', arguments: args });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'isolated transport condition should settle');
}
const server = createServer(), wss = new WebSocketServer({ server });
const sessions: { ws: WebSocket; route: string | undefined; frames: any[]; closed: boolean }[] = [];
wss.on('connection', (ws, request) => {
  const session = { ws, route: request.url, frames: [] as any[], closed: false }; sessions.push(session);
  ws.on('error', () => {}); ws.on('close', () => { session.closed = true; });
  ws.on('message', raw => {
    session.frames.push(JSON.parse(raw.toString()));
    if (session.frames.length === 1) ws.send(JSON.stringify({ type: 'ready' }));
  });
});
server.listen(socketPath); await once(server, 'listening');
const send = (index: number, value: unknown) => sessions[index].ws.send(JSON.stringify(value));
after(async () => {
  for (const session of sessions) session.ws.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  mock.restoreAll(); fs.rmSync(temp, { recursive: true, force: true });
});

test('isolated callback capability validates tenant identity and requires a native handler before connecting', async () => {
  const start = sessions.length;
  await assert.rejects(isolatedRunner.runGeneration(params, options), /callback is unavailable/);
  await assert.rejects(isolatedRunner.runGeneration(params, { ...options, tenantUserId: 'usr_foreign_transport', onToolCall: async () => ({ output: '' }) }), /Tenant identity mismatch/);
  assert.equal(sessions.length, start);
});

test('private socket scopes matching IDs to a generation, deduplicates and forwards structured image output', async () => {
  const start = sessions.length, gates = [defer<any>(), defer<any>()], counts = [0, 0];
  const jobs = gates.map((gate, i) => isolatedRunner.runGeneration(params, { ...options, onToolCall: async () => { counts[i]++; return gate.promise; } }));
  await until(() => sessions.length === start + 2 && sessions.slice(start).every(session => session.frames.length > 0));
  for (let i = 0; i < 2; i++) {
    assert.equal(sessions[start + i].route, '/cli');
    assert.equal(sessions[start + i].frames[0].tenantId, tenantUserId);
    assert.equal(sessions[start + i].frames[0].operation, 'generate');
    assert.equal('onToolCall' in sessions[start + i].frames[0], false);
    send(start + i, { type: 'tool_call', call: call() });
  }
  assert.ok(privateDials.length >= 2);
  send(start, { type: 'tool_call', call: call() });
  await until(() => counts.every(count => count === 1));
  gates.forEach((gate, i) => gate.resolve({ output: [{ type: 'input_text', text: `private-${i}` }, { type: 'input_image', image_url: 'data:image/png;base64,aGk=' }] }));
  await until(() => sessions[start].frames.length === 3 && sessions[start + 1].frames.length === 2);
  for (let i = 0; i < 2; i++) {
    const replies = sessions[start + i].frames.slice(1);
    assert.equal(replies.length, i === 0 ? 2 : 1);
    for (const reply of replies) { assert.equal(reply.type, 'tool_result'); assert.equal(reply.id, call().id); assert.equal(reply.result.output[0].text, `private-${i}`); }
    send(start + i, { type: 'result', result: { text: `done-${i}` } });
  }
  assert.deepEqual(await Promise.all(jobs), [{ text: 'done-0' }, { text: 'done-1' }]);
  assert.deepEqual(counts, [1, 1]);
});

for (const ending of ['cancel', 'deadline', 'disconnect', 'conflict'] as const) test(`private socket ${ending} closes callback wrappers and discards late output`, async () => {
  const index = sessions.length, controller = new AbortController(), gate = defer<any>(); let executed = 0;
  const job = isolatedRunner.runGeneration({ ...params, timeoutMs: ending === 'deadline' ? 100 : 2000 }, { ...options, signal: controller.signal,
    onToolCall: async () => { executed++; return gate.promise; } });
  const rejected = assert.rejects(job, /cancelled|timed out|disconnected|Invalid runner response/);
  await until(() => sessions[index]?.frames.length > 0);
  send(index, { type: 'tool_call', call: call() }); await until(() => executed === 1);
  if (ending === 'cancel') controller.abort();
  if (ending === 'disconnect') sessions[index].ws.terminate();
  if (ending === 'conflict') send(index, { type: 'tool_call', call: call(undefined, { changed: true }) });
  await rejected; gate.resolve({ output: 'late output' });
  await until(() => sessions[index].closed); await delay(10);
  assert.equal(executed, 1); assert.equal(sessions[index].frames.length, 1);
});

test('isolated catalog never executes a supplied native callback', async () => {
  const index = sessions.length; let executed = 0;
  const job = isolatedRunner.readCatalog(params, { ...options, onToolCall: async () => { executed++; return { output: 'forbidden' }; } });
  const rejected = assert.rejects(job, /Invalid runner response/);
  await until(() => sessions[index]?.frames.length > 0); send(index, { type: 'tool_call', call: call() });
  await rejected; assert.equal(executed, 0);
});

test('isolated status rejects tool callbacks even when a handler was supplied', async () => {
  const index = sessions.length; let executed = 0;
  const job = isolatedRunner.checkProviders({ ...options, onToolCall: async () => { executed++; return { output: 'forbidden' }; } });
  const rejected = assert.rejects(job, /Invalid runner response/);
  await until(() => sessions[index + 1]?.frames.length > 0);
  send(index, { type: 'tool_call', call: call() });
  send(index + 1, { type: 'result', result: { installed: true, authenticated: true, subscription: true } });
  await rejected; assert.equal(executed, 0);
});

test('isolated callback failures return protocol errors; stop boundaries block another callback', async () => {
  let index = sessions.length;
  const failed = isolatedRunner.runGeneration(params, { ...options, onToolCall: async () => { throw new Error('action refused'); } });
  await until(() => sessions[index]?.frames.length > 0); send(index, { type: 'tool_call', call: call() });
  await until(() => sessions[index].frames.length === 2);
  assert.deepEqual(sessions[index].frames[1], { type: 'tool_result', id: call().id, error: 'action refused' });
  send(index, { type: 'result', result: { text: 'handled' } }); await failed;
  index = sessions.length; let executed = 0;
  const stopped = isolatedRunner.runGeneration(params, { ...options, onToolCall: async () => { executed++; return { output: '', stop: true }; } });
  const rejected = assert.rejects(stopped, /Invalid runner response/);
  await until(() => sessions[index]?.frames.length > 0); send(index, { type: 'tool_call', call: call() });
  await until(() => sessions[index].frames.length === 2); assert.equal(sessions[index].frames[1].result.stop, true);
  send(index, { type: 'tool_call', call: call('later') }); await rejected; assert.equal(executed, 1);
});

// Test the actual worker entrypoint with only its companion runner substituted.
// Executable paths are still resolved from the installed, fixed package names.
fs.mkdirSync(path.join(temp, 'infra/tenant-host'), { recursive: true }); fs.mkdirSync(path.join(temp, 'companion'));
fs.copyFileSync(new URL('../infra/tenant-host/worker.mjs', import.meta.url), path.join(temp, 'infra/tenant-host/worker.mjs'));
fs.symlinkSync(path.resolve('node_modules'), path.join(temp, 'node_modules'), 'dir');
fs.writeFileSync(path.join(temp, 'companion/cli-bridge.mjs'), `
export async function runGeneration(params, options) {
  const call = { id: 'worker:string:1', name: 'read_app', arguments: { value: 1 } };
  try {
    const pending = options.onToolCall(call);
    if (params.conflict) await options.onToolCall({ ...call, arguments: { value: 2 } });
    const [a, b] = await Promise.all([pending, options.onToolCall(call)]);
    return { text: JSON.stringify({ a, b }), stopped: a.stop === true };
  } catch (error) { return { cancelled: options.signal.aborted, error: error.message }; }
}
`);
function worker(t: any, extra = {}) {
  const child = spawn(process.execPath, [path.join(temp, 'infra/tenant-host/worker.mjs'), 'cli'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames: any[] = [], errors: string[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => frames.push(JSON.parse(line))); child.stderr.on('data', data => errors.push(data.toString()));
  const done = once(child, 'exit');
  t.after(() => { child.kill('SIGKILL'); lines.close(); });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  send({ operation: 'generate', provider: 'codex', params: { ...params, ...extra } });
  return { child, frames, errors, send, done };
}

test('worker sends one tool_call for duplicate callbacks, ignores unknown/duplicate results and preserves stop', async t => {
  const w = worker(t);
  await until(() => w.frames.some(frame => frame.type === 'tool_call'));
  assert.equal(w.frames.filter(frame => frame.type === 'tool_call').length, 1);
  const id = w.frames.find(frame => frame.type === 'tool_call').call.id;
  w.send({ type: 'tool_result', id: 'foreign', result: { output: 'foreign' } });
  w.send({ type: 'tool_result', id, result: { output: 'first', stop: true } });
  w.send({ type: 'tool_result', id, result: { output: 'duplicate' } });
  await w.done;
  const result = w.frames.find(frame => frame.type === 'result').result;
  assert.equal(result.stopped, true);
  assert.deepEqual(JSON.parse(result.text), { a: { output: 'first', stop: true }, b: { output: 'first', stop: true } });
  assert.deepEqual(w.errors, []);
});

for (const ending of ['cancel', 'deadline', 'error'] as const) test(`worker ${ending} settles outstanding callback promises`, async t => {
  const w = worker(t, { timeoutMs: ending === 'deadline' ? 80 : 2000 });
  await until(() => w.frames.some(frame => frame.type === 'tool_call'));
  const id = w.frames.find(frame => frame.type === 'tool_call').call.id;
  if (ending === 'cancel') w.send({ type: 'cancel' });
  if (ending === 'error') w.send({ type: 'tool_result', id, error: 'application refused' });
  await w.done;
  const result = w.frames.find(frame => frame.type === 'result').result;
  assert.equal(result.cancelled, ending !== 'error');
  assert.match(result.error, /generation ended|application refused/);
  assert.deepEqual(w.errors, []);
});
