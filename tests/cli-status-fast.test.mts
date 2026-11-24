import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusReader } from '../server/src/cli/status-cache.js';
import { checkProviders } from '../companion/cli-bridge.mjs';
import { cliApi, getCachedCliStatus } from '../web/src/lib/cliApi.js';
import { useStore } from '../web/src/store.js';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('server status has a 3s deadline, aborts the probe and offers unavailable status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let signal: AbortSignal | undefined, finished = false;
  const read = createStatusReader(() => ({ connected: false }), async (_, next) => { signal = next; await new Promise(() => {}); });
  const result = read('alice').then(value => { finished = true; return value; });
  await settle(); t.mock.timers.tick(2999); await settle(); assert.equal(finished, false);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(await result, { connected: false, statusUnavailable: true });
  assert.equal(signal?.aborted, true);
});

test('server shows the last status immediately, deduplicates revalidation and isolates accounts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const snapshots = new Map<string, { connected: boolean; value: string }>();
  let calls = 0, release: (() => void) | undefined;
  const read = createStatusReader(key => snapshots.get(key) ?? { connected: false, value: 'unknown' }, async key => {
    calls++;
    if (calls > 1) await new Promise<void>(resolve => { release = resolve; });
    snapshots.set(key, { connected: true, value: `checked-${calls}` });
  });
  assert.equal((await read('alice')).value, 'checked-1');
  assert.equal((await read('alice')).value, 'checked-1'); assert.equal(calls, 1);
  t.mock.timers.tick(5000);
  assert.equal((await read('alice')).value, 'checked-1');
  assert.equal((await read('alice')).value, 'checked-1'); assert.equal(calls, 2);
  release!(); await settle(); assert.equal((await read('alice')).value, 'checked-2');
  const other = read('bob'); await settle(); release!(); await other;
  assert.equal((await read('bob')).value, 'checked-3');
  assert.equal((await read('alice')).value, 'checked-2');
});

test('slow official CLI status probes run in parallel and finish within about 3s', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fast-cli-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'slow-cli'), audit = join(dir, 'starts');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(audit)}, Date.now() + '\\n'); setInterval(() => {}, 1000);`, { mode: 0o700 });
  const start = performance.now();
  const status = await checkProviders({ codexPath: cli, claudePath: cli });
  assert.ok(performance.now() - start < 3300, 'both CLI probes share the bounded status wait');
  const times = (await readFile(audit, 'utf8')).trim().split('\n').map(Number);
  assert.equal(times.length, 2); assert.ok(Math.abs(times[0] - times[1]) < 500);
  for (const provider of ['claude', 'codex']) {
    assert.equal(status[provider].authenticated, false);
    assert.match(status[provider].error, /timed out/i);
  }
});

test('client immediately exposes cached status and clears it on account changes', async t => {
  const originalUser = useStore.getState().user;
  t.after(() => useStore.setState({ user: originalUser }));
  useStore.setState({ user: { id: 'alice' } as any });
  const status = { connected: true, selected: 'claude', providers: {
    claude: { installed: true, authenticated: true, subscription: true },
    codex: { installed: false, authenticated: false, subscription: false },
  } };
  t.mock.method(globalThis, 'fetch', async () => Response.json(status));
  await cliApi.status(); assert.deepEqual(getCachedCliStatus(), status);
  useStore.setState({ user: { id: 'bob' } as any });
  assert.equal(getCachedCliStatus(), null);
});

test('client status cannot stay checking when the transport hangs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalUser = useStore.getState().user;
  t.after(() => useStore.setState({ user: originalUser }));
  useStore.setState({ user: { id: 'alice' } as any });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_, options) => { signal = options?.signal; return new Promise(() => {}); });
  const result = assert.rejects(cliApi.status(), /Status unavailable/);
  t.mock.timers.tick(3500); await result;
  assert.equal(signal?.aborted, true);
});

test('explicit refresh preserves probe errors and the prior cached snapshot', async () => {
  const read = createStatusReader(() => ({ connected: true, selected: 'claude' }), async () => { throw Error('Invalid authentication status'); });
  await assert.rejects(read('alice', true), /Invalid authentication status/);
  assert.deepEqual(await read('alice'), { connected: true, selected: 'claude', statusUnavailable: true });
});
