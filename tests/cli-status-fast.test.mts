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

test('server returns Checking in 200ms and aborts a hung background probe after 15s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let signal: AbortSignal | undefined;
  const read = createStatusReader(() => ({ connected: false }), async (_, next) => { signal = next; await new Promise(() => {}); });
  const result = read('alice');
  await settle(); t.mock.timers.tick(200); await settle();
  assert.deepEqual(await result, { connected: false, statusChecking: true });
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(14800); await settle();
  assert.deepEqual(await read('alice'), { connected: false, statusUnavailable: true });
  assert.equal(signal?.aborted, true);
});

test('slow successful background status becomes connected without a false timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let connected = false;
  const read = createStatusReader(() => ({ connected }), async () => { await new Promise(resolve => setTimeout(resolve, 6000)); connected = true; });
  const result = read('alice'); await settle(); t.mock.timers.tick(200); await settle();
  assert.equal((await result).statusChecking, true);
  t.mock.timers.tick(5800); await settle();
  assert.deepEqual(await read('alice'), { connected: true });
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

test('hung official CLI status probes run in parallel and terminate within 13s', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fast-cli-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'slow-cli'), audit = join(dir, 'starts');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(audit)}, Date.now() + '\\n'); setInterval(() => {}, 1000);`, { mode: 0o700 });
  const start = performance.now();
  const status = await checkProviders({ codexPath: cli, claudePath: cli });
  assert.ok(performance.now() - start < 13_500, 'both CLI probes share the bounded status wait');
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

for (const signedIn of [true, false]) test(`slow official CLI probes report ${signedIn ? 'connected' : 'not connected'} after 4s without timeout`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'slow-success-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'cli');
  await writeFile(cli, `#!${process.execPath}\nsetTimeout(() => {
    console.log(process.argv.includes('--json') ? JSON.stringify({loggedIn:${signedIn},authMethod:'claude.ai',subscriptionType:'pro'}) : ${JSON.stringify(signedIn ? 'Logged in using ChatGPT' : 'Not logged in')});
    process.exit(${signedIn ? 0 : 1});
  }, 4000);`, { mode: 0o700 });
  const start = performance.now(), status = await checkProviders({ codexPath: cli, claudePath: cli });
  assert.ok(performance.now() - start >= 4000);
  for (const provider of Object.values(status) as any[]) {
    assert.equal(provider.authenticated, signedIn); assert.equal(provider.subscription, signedIn); assert.equal(provider.error, undefined);
  }
});
