import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { nativeToolHandler, nativeToolSession, withNativeTools } from '../server/src/cli/native-tools.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const call = (id = 'call-1') => ({ id, name: 'SWARM_APPS_SEARCH', arguments: { toolkit: 'github', query: 'verify' } });

test('transport callbacks retain the Bot owner and selected computer across foreign async contexts', async () => {
  const scope = new AsyncLocalStorage<{ userId: string; computerId: string }>();
  const ready = deferred(), finish = deferred();
  let callback!: ReturnType<typeof nativeToolHandler>;
  const turn = scope.run({ userId: 'alice', computerId: 'alice-server' }, () => withNativeTools('alice', async () => {
    assert.deepEqual(scope.getStore(), { userId: 'alice', computerId: 'alice-server' });
    return { output: 'correct server' };
  }, async () => { callback = nativeToolHandler('alice'); ready.resolve(); await finish.promise; }));
  await ready.promise;
  try {
    const reply = await scope.run({ userId: 'bob', computerId: 'bob-server' }, () => callback!(call()));
    assert.equal(reply.output, 'correct server');
  } finally { finish.resolve(); await turn; }
});

test('native tools are scoped to the owner and serialize within a Bot while other Bots continue', async () => {
  const first = deferred(), release = deferred(), order: string[] = [];
  const bot = withNativeTools('alice', async value => {
    order.push(value.id);
    if (value.id === 'call-1') { first.resolve(); await release.promise; }
    return { output: value.id };
  }, async () => {
    assert.equal(nativeToolHandler('bob'), undefined);
    const handler = nativeToolHandler('alice')!;
    return Promise.all([handler(call('call-1')), handler(call('call-2'))]);
  });
  await first.promise;
  await withNativeTools('alice', async () => { order.push('independent-bot'); return { output: 'done' }; }, async () => nativeToolHandler('alice')!(call()));
  assert.deepEqual(order, ['call-1', 'independent-bot']);
  release.resolve();
  assert.deepEqual(await bot, [{ output: 'call-1' }, { output: 'call-2' }]);
  assert.deepEqual(order, ['call-1', 'independent-bot', 'call-2']);
  assert.equal(nativeToolHandler('alice'), undefined);
});

test('duplicate IDs share one execution and conflicting IDs, unknown tools and bad arguments fail closed', async () => {
  const ready = deferred(), release = deferred();
  let executed = 0;
  const session = nativeToolSession(['SWARM_APPS_SEARCH'], async () => { executed++; ready.resolve(); await release.promise; return { output: 'verified' }; });
  const first = session.call(call());
  await ready.promise;
  const duplicate = session.call(call());
  for (const value of [
    { ...call(), arguments: { toolkit: 'notion' } },
    { ...call('other'), name: 'shell' },
    { ...call('other'), arguments: [] },
    { ...call('other'), arguments: null },
    { ...call('other'), arguments: { value: 'x'.repeat(1_000_001) } },
    { ...call(), id: '' },
  ]) await assert.rejects(session.call(value as any));
  assert.equal(executed, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, duplicate]), [{ output: 'verified' }, { output: 'verified' }]);
  session.close();
  await session.drain();
  await assert.rejects(session.call(call('late')), /ended/);
});

test('a failed tool is never replayed under the same native request ID', async () => {
  let executed = 0;
  const session = nativeToolSession(['SWARM_APPS_SEARCH'], async () => { executed++; throw new Error('uncertain outcome'); });
  await assert.rejects(session.call(call()), /uncertain/);
  await assert.rejects(session.call(call()), /uncertain/);
  await session.drain();
  assert.equal(executed, 1);
});

test('native tool input is captured before it enters an asynchronous queue', async () => {
  const ready = deferred(), release = deferred();
  await withNativeTools('alice', async value => {
    if (value.id === 'first') { ready.resolve(); await release.promise; }
    return { output: value.arguments };
  }, async () => {
    const session = nativeToolSession(['SWARM_APPS_SEARCH'], nativeToolHandler('alice')!);
    const first = session.call(call('first')); await ready.promise;
    const value = call('second'), second = session.call(value);
    value.arguments.toolkit = 'changed-after-admission';
    release.resolve(); await first;
    assert.deepEqual(await second, { output: { toolkit: 'github', query: 'verify' } });
  });
});

test('stopping a native session fences later actions and retains the first stopped result', async () => {
  let executed = 0;
  const session = nativeToolSession(['SWARM_APPS_SEARCH'], async () => { executed++; return { output: 'Approval required', stop: true }; });
  assert.deepEqual(await session.call(call()), { output: 'Approval required', stop: true });
  assert.equal(session.stopped, true);
  assert.equal((await session.call(call('later'))).stop, true);
  assert.deepEqual(await session.call(call()), { output: 'Approval required', stop: true });
  assert.equal(executed, 1);
});

test('a model failure drains the executing tool before releasing the Bot and rejects queued work', async () => {
  const ready = deferred(), release = deferred(), failModel = deferred();
  let finished = false, executed = 0;
  let pending: Promise<unknown>[] = [];
  const turn = withNativeTools('alice', async () => {
    executed++; ready.resolve(); await release.promise; return { output: 'write outcome recorded' };
  }, async () => {
    const handler = nativeToolHandler('alice')!;
    pending = [handler(call('first')), handler(call('second'))];
    void Promise.allSettled(pending);
    await failModel.promise;
    throw new Error('model disconnected');
  }).finally(() => { finished = true; });
  const rejected = assert.rejects(turn, /model disconnected/);
  await ready.promise;
  failModel.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release.resolve(); await rejected;
  assert.equal(executed, 1);
  const results = await Promise.allSettled(pending);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
});

test('aborted generation signals reject new native calls without dispatch', async () => {
  const controller = new AbortController(); controller.abort();
  const session = nativeToolSession(['SWARM_APPS_SEARCH'], async () => { throw new Error('must not dispatch'); }, controller.signal);
  await assert.rejects(session.call(call()), /session has ended/);
});

test('a completed or disconnected generation cancels queued tools while draining the executing action', async () => {
  const ready = deferred(), release = deferred();
  let executed = 0;
  await withNativeTools('alice', async () => {
    executed++; ready.resolve(); await release.promise; return { output: 'outcome recorded' };
  }, async () => {
    const session = nativeToolSession(['SWARM_APPS_SEARCH'], nativeToolHandler('alice')!);
    const first = session.call(call('first')); await ready.promise;
    const queued = session.call(call('second'));
    const rejected = assert.rejects(queued, /session has ended/);
    session.close();
    let drained = false;
    const draining = session.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve();
    assert.deepEqual(await first, { output: 'outcome recorded' });
    await rejected; await draining;
    assert.equal(executed, 1);
  });
});
