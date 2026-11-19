// node --import tsx --test tests/cli-native-transport.test.mts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import { ToolCallbacks } from '../server/src/cli/tool-callback.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-transport-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'test.db'),
  FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'native-transport-test-only', INKBOX_TUNNEL: '0' });
const { db } = await import('../server/src/db.js');
const { createCliPairing } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliRequest, disconnectCli } = await import('../server/src/cli/bridge.js');
const server = createServer();
attachCliSocket(server);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const clients = new Set<WebSocket>();
const nativeTools = [{ name: 'read_app', parameters: { type: 'object' } }];
const params = { provider: 'claude', nativeTools };
const call = (id = 'generation:string:1', args: any = { nested: { a: 1, b: 2 } }) => ({ id, name: 'read_app', arguments: args });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'transport condition should settle');
}
let sequence = 0;
async function bridge(t: any, nativeMcp = true, existingUser?: string, noGenerationDeadline: boolean | 'omit' = true) {
  const userId = existingUser ?? `usr_native_transport_${sequence++}`;
  if (!existingUser) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, userId, Date.now());
  const token = createCliPairing(userId);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/cli-bridge`), frames: any[] = [];
  clients.add(ws); ws.on('error', () => {});
  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame);
    if (frame.method === 'status') ws.send(JSON.stringify({ id: frame.id, result: {
      claude: { installed: true, authenticated: true, subscription: true }, codex: { installed: true, authenticated: true, subscription: true },
    } }));
  });
  const hello = { type: 'hello', version: 1, token, nativeMcp, ...(noGenerationDeadline === 'omit' ? {} : { noGenerationDeadline }) };
  await once(ws, 'open'); ws.send(JSON.stringify(hello));
  await until(() => frames.some(frame => frame.type === 'welcome'));
  t.after(() => { disconnectCli(userId); ws.terminate(); });
  return { userId, ws, frames, hello, send: (value: unknown) => ws.send(JSON.stringify(value)),
    calls: () => frames.filter(frame => frame.method === 'generate'), replies: () => frames.filter(frame => frame.type === 'tool_result') };
}
after(async () => {
  for (const ws of clients) ws.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

test('old personal bridge fails native requests closed and still completes legacy requests', async t => {
  const b = await bridge(t, false);
  await assert.rejects(cliRequest(b.userId, 'generate', params, 1000, undefined, async () => ({ output: 'unexpected' })), /update.*native tools.*Settings/s);
  assert.equal(b.calls().length, 0);
  const legacy = cliRequest(b.userId, 'generate', {}, 1000);
  await until(() => b.calls().length === 1);
  b.send({ id: b.calls()[0].id, result: { text: 'legacy works' } });
  assert.deepEqual(await legacy, { text: 'legacy works' });
});

test('a bridge without deadline opt-out support must be updated before long-running agent work', async t => {
  const b = await bridge(t, true, undefined, false);
  await assert.rejects(cliRequest(b.userId, 'generate', { ...params, timeoutMs: 0 }, 0, undefined, async () => ({ output: 'unused' })), /update for long-running tasks/);
  assert.equal(b.calls().length, 0);
});

test('an omitted deadline capability preserves finite requests and upgrading the bridge enables unbounded work', { timeout: 15000 }, async t => {
  const legacy = await bridge(t, true, undefined, 'omit');
  assert.equal(Object.hasOwn(legacy.hello, 'noGenerationDeadline'), false, 'send the actual old-style hello');
  let executed = 0;
  const handler = async () => ({ output: `action-${++executed}` });
  await assert.rejects(cliRequest(legacy.userId, 'generate', { ...params, timeoutMs: 0 }, 0, undefined, handler), /update for long-running tasks/);
  assert.equal(legacy.calls().length, 0); assert.equal(executed, 0);

  const status = await cliRequest(legacy.userId, 'status', {}, 2000);
  assert.equal(status.claude.subscription, true, 'rejection must not poison the old connection');
  const catalog = cliRequest(legacy.userId, 'catalog', { provider: 'claude' }, 2000);
  await until(() => legacy.frames.some(frame => frame.method === 'catalog'));
  legacy.send({ id: legacy.frames.find(frame => frame.method === 'catalog').id, result: { models: ['legacy-model'] } });
  assert.deepEqual(await catalog, { models: ['legacy-model'] });

  const finite = cliRequest(legacy.userId, 'generate', { ...params, timeoutMs: 2000 }, 3000, undefined, handler);
  await until(() => legacy.calls().length === 1);
  const finiteId = legacy.calls()[0].id;
  legacy.send({ id: finiteId, type: 'tool_call', call: call() });
  await until(() => legacy.replies().length === 1);
  assert.equal(legacy.replies()[0].result.output, 'action-1');
  legacy.send({ id: finiteId, result: { text: 'finite request completed' } });
  assert.deepEqual(await finite, { text: 'finite request completed' });

  const oldClosed = once(legacy.ws, 'close');
  const upgraded = await bridge(t, true, legacy.userId);
  await oldClosed;
  assert.equal(upgraded.hello.noGenerationDeadline, true);
  const unbounded = cliRequest(upgraded.userId, 'generate', { ...params, timeoutMs: 0 }, 0, undefined, handler);
  await until(() => upgraded.calls().length === 1);
  const unboundedId = upgraded.calls()[0].id;
  assert.notEqual(unboundedId, finiteId);
  upgraded.send({ id: unboundedId, type: 'tool_call', call: call() });
  await until(() => upgraded.replies().length === 1);
  assert.equal(upgraded.replies()[0].result.output, 'action-2');
  upgraded.send({ id: unboundedId, result: { text: 'unbounded request completed' } });
  assert.deepEqual(await unbounded, { text: 'unbounded request completed' });
  assert.equal(executed, 2);
});

for (const ending of ['complete', 'cancel', 'disconnect'] as const) test(`unbounded bridge generation survives elapsed time and still supports ${ending}`, { timeout: 15000 }, async t => {
  const b = await bridge(t), controller = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const job = cliRequest(b.userId, 'generate', { ...params, timeoutMs: 0 }, 0, controller.signal, async () => ({ output: 'still working' }));
  void job.then(() => { settled = true; }, () => { settled = true; });
  // Network I/O remains real while only timeout clocks are advanced.
  while (!b.calls().length) await new Promise(resolve => setImmediate(resolve));
  const id = b.calls()[0].id;
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20 * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    b.send({ id, type: 'tool_call', call: call(`step-${i}`) });
    while (b.replies().length <= i) await new Promise(resolve => setImmediate(resolve));
    assert.equal(b.replies()[i].result.output, 'still working');
  }
  if (ending === 'complete') { b.send({ id, result: { text: 'finished' } }); assert.deepEqual(await job, { text: 'finished' }); }
  else {
    const rejected = assert.rejects(job, /cancelled|offline/);
    if (ending === 'cancel') controller.abort(); else b.ws.terminate();
    await rejected;
  }
  t.mock.timers.reset();
});

test('matching duplicate callbacks execute once; identical call IDs in other generations/accounts remain isolated', async t => {
  const a = await bridge(t), b = await bridge(t);
  const gates = [defer<any>(), defer<any>(), defer<any>()], counts = [0, 0, 0];
  const jobs = [a, a, b].map((bridge, i) => cliRequest(bridge.userId, 'generate', params, 2000, undefined, async input => {
    counts[i]++; assert.equal(input.id, call().id); return gates[i].promise;
  }));
  await until(() => a.calls().length === 2 && b.calls().length === 1);
  const ids = [a.calls()[0].id, a.calls()[1].id, b.calls()[0].id];
  b.send({ id: ids[0], type: 'tool_call', call: call('forged-owner') });
  [a, a, b].forEach((bridge, i) => bridge.send({ id: ids[i], type: 'tool_call', call: call() }));
  a.send({ id: ids[0], type: 'tool_call', call: call(undefined, { nested: { b: 2, a: 1 } }) });
  await until(() => counts.every(count => count === 1));
  gates.forEach((gate, i) => gate.resolve({ output: [{ type: 'input_text', text: `owner-${i}` }, { type: 'input_image', image_url: 'data:image/png;base64,aGk=' }] }));
  await until(() => a.replies().length === 3 && b.replies().length === 1);
  [a, a, b].forEach((bridge, i) => {
    const replies = bridge.replies().filter(frame => frame.id === ids[i]);
    assert.equal(replies.length, i === 0 ? 2 : 1);
    for (const reply of replies) { assert.equal(reply.callId, call().id); assert.equal(reply.result.output[0].text, `owner-${i}`); }
    bridge.send({ id: ids[i], result: { text: `done-${i}` } });
  });
  assert.deepEqual(await Promise.all(jobs), [{ text: 'done-0' }, { text: 'done-1' }, { text: 'done-2' }]);
  assert.deepEqual(counts, [1, 1, 1]);
});

test('conflicting ID cancels the generation without a second execution or late callback reply', async t => {
  const b = await bridge(t), gate = defer<any>(); let executed = 0;
  const job = cliRequest(b.userId, 'generate', params, 2000, undefined, async () => { executed++; return gate.promise; });
  const rejected = assert.rejects(job, /ID was reused/);
  await until(() => b.calls().length === 1); const id = b.calls()[0].id;
  b.send({ id, type: 'tool_call', call: call() });
  await until(() => executed === 1);
  b.send({ id, type: 'tool_call', call: call(undefined, { changed: true }) });
  await rejected; gate.resolve({ output: 'late' });
  await until(() => b.frames.some(frame => frame.method === 'cancel' && frame.id === id));
  await delay(20);
  assert.equal(executed, 1); assert.deepEqual(b.replies(), []);
});

for (const ending of ['cancel', 'deadline', 'replacement'] as const) test(`${ending} discards pending and later tool calls`, async t => {
  const b = await bridge(t), controller = new AbortController(), gate = defer<any>(); let executed = 0;
  const job = cliRequest(b.userId, 'generate', params, ending === 'deadline' ? 60 : 2000, controller.signal, async () => { executed++; return gate.promise; });
  const rejected = assert.rejects(job, /cancelled|timed out|offline/);
  await until(() => b.calls().length === 1); const id = b.calls()[0].id;
  b.send({ id, type: 'tool_call', call: call() }); await until(() => executed === 1);
  if (ending === 'cancel') controller.abort();
  if (ending === 'replacement') await bridge(t, true, b.userId);
  await rejected;
  if (b.ws.readyState === WebSocket.OPEN) b.send({ id, type: 'tool_call', call: call('late') });
  gate.resolve({ output: 'late' }); await delay(20);
  assert.equal(executed, 1); assert.deepEqual(b.replies(), []);
});

test('native requests require a handler; catalog and legacy requests cannot invoke a supplied handler', async t => {
  const b = await bridge(t); let executed = 0;
  await assert.rejects(cliRequest(b.userId, 'generate', params, 1000), /callback is unavailable/);
  assert.equal(b.calls().length, 0);
  for (const method of ['catalog', 'generate'] as const) {
    const job = cliRequest(b.userId, method, method === 'catalog' ? params : {}, 1000, undefined, async () => { executed++; return { output: 'forbidden' }; });
    const rejected = assert.rejects(job, /callback is unavailable/);
    await until(() => b.frames.some(frame => frame.method === method));
    const id = b.frames.findLast(frame => frame.method === method).id;
    b.send({ id, type: 'tool_call', call: call() }); await rejected;
  }
  assert.equal(executed, 0);
});

test('status requests cannot invoke a supplied native callback', async t => {
  const b = await bridge(t); let executed = 0;
  const job = cliRequest(b.userId, 'status', params, 1000, undefined, async () => { executed++; return { output: 'forbidden' }; });
  // The fixture answers status immediately. A later forged callback must not
  // revive the already completed request or acquire its optional handler.
  await job; const id = b.frames.findLast(frame => frame.method === 'status').id;
  b.send({ id, type: 'tool_call', call: call() }); await delay(10);
  assert.equal(executed, 0); assert.deepEqual(b.replies(), []);
});

test('stop result is forwarded intact and prevents later native execution', async t => {
  const b = await bridge(t); let executed = 0;
  const job = cliRequest(b.userId, 'generate', params, 1000, undefined, async () => { executed++; return { output: '', stop: true }; });
  const rejected = assert.rejects(job, /generation has stopped/);
  await until(() => b.calls().length === 1); const id = b.calls()[0].id;
  b.send({ id, type: 'tool_call', call: call() }); await until(() => b.replies().length === 1);
  assert.deepEqual(b.replies()[0].result, { output: '', stop: true });
  b.send({ id, type: 'tool_call', call: call('later') }); await rejected;
  assert.equal(executed, 1);
});

test('callback replay caches and payloads have bounded size and close rejects in-flight wrappers', async () => {
  let executed = 0;
  const callbacks = new ToolCallbacks(params, async () => { executed++; return { output: 'ok' }; });
  assert.throws(() => callbacks.run(call('large', { value: 'x'.repeat(1_000_000) })), /too large/);
  assert.throws(() => callbacks.run({ ...call(), name: 'not_permitted' }), /Invalid native/);
  for (let i = 0; i < 512; i++) await callbacks.run(call(`bounded-${i}`));
  assert.throws(() => callbacks.run(call('overflow')), /generation limit/);
  assert.equal(executed, 512); callbacks.close();
  const gate = defer<any>(), pending = new ToolCallbacks(params, () => gate.promise);
  const promise = pending.run(call()); const rejected = assert.rejects(promise, /no longer active/);
  await delay(0); pending.close(); await rejected; gate.resolve({ output: 'late' });
  const largeOutput = new ToolCallbacks(params, async () => ({ output: 'x'.repeat(8 * 1024 * 1024) }));
  await assert.rejects(largeOutput.run(call()), /generation limit/); largeOutput.close();
});

test('callbacks queued behind a stop or cancellation never execute', async () => {
  for (const ending of ['stop', 'cancel'] as const) {
    const gate = defer<any>(); let executed = 0;
    const callbacks = new ToolCallbacks(params, async () => { executed++; return gate.promise; });
    const first = callbacks.run(call('first')), second = callbacks.run(call('second'));
    const rejected = assert.rejects(second, /stopped|no longer active/);
    await until(() => executed === 1);
    if (ending === 'cancel') {
      const cancelled = assert.rejects(first, /no longer active/); callbacks.close(); await cancelled;
    }
    gate.resolve({ output: '', stop: true });
    if (ending === 'stop') await first;
    await rejected; assert.equal(executed, 1); callbacks.close();
  }
});
