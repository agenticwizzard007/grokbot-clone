import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { useModels } from '../web/src/lib/models.js';
import { useStore } from '../web/src/store.js';
const account = (id: string | null) => useStore.setState({ user: id ? { id } as any : null, sseConnected: false });
const catalog = { provider: 'codex-cli', billing: 'plan', models: [{ id: 'codex/default', short: 'Codex CLI default' }], favourites: [], defaultModel: 'codex/default', usage: { available: false, checkedAt: 1, windows: [] } };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
afterEach(() => account(null));

test('model loading waits for account restoration and recovers from an initial auth race', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  account(null); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json({ error: 'Session restoring' }, { status: 401 }) : Response.json(catalog));
  await useModels.getState().load(); assert.equal(calls, 0);
  account('restored'); await useModels.getState().load();
  assert.equal(useModels.getState().status, 'loading'); assert.equal(useModels.getState().error, null);
  t.mock.timers.tick(1000); await settle();
  assert.equal(useModels.getState().status, 'ready'); assert.equal(useModels.getState().defaultModel, 'codex/default');
});

test('aborted model reads retry automatically and retain previously loaded metadata', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  account('abort'); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { if (++calls === 2) throw new DOMException('aborted', 'AbortError'); return Response.json(catalog); });
  await useModels.getState().load(); await useModels.getState().load(true);
  assert.equal(useModels.getState().status, 'loading'); assert.equal(useModels.getState().defaultModel, 'codex/default');
  t.mock.timers.tick(1000); await settle();
  assert.equal(useModels.getState().status, 'ready'); assert.equal(calls, 3);
});

test('cold stale catalogs retry with backoff until metadata is ready without a picker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  account('cold'); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls < 6 ? { ...catalog, models: [], stale: true } : catalog));
  await useModels.getState().load();
  for (const delay of [1000, 2000, 4000, 8000, 8000]) {
    assert.equal(useModels.getState().status, 'loading'); assert.equal(useModels.getState().error, null);
    t.mock.timers.tick(delay - 1); await settle(); const before = calls;
    t.mock.timers.tick(1); await settle(); assert.equal(calls, before + 1);
  }
  assert.equal(useModels.getState().status, 'ready'); assert.equal(calls, 6);
});

test('account switches discard late catalogs and reconnect retries immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  account('old'); let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve; }));
  const old = useModels.getState().load(); account('new');
  release(Response.json(catalog)); await old;
  assert.equal(useModels.getState().provider, null);
  t.mock.method(globalThis, 'fetch', async () => Response.json(catalog));
  useStore.setState({ sseConnected: true }); await settle();
  assert.equal(useModels.getState().status, 'ready');
});


test('transport failures back off to thirty seconds after the initial retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  account('offline'); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Fixture offline'); });
  await useModels.getState().load();
  for (const delay of [1000, 2000, 4000, 8000, 30_000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1); await settle(); assert.equal(calls, before);
    t.mock.timers.tick(1); await settle(); assert.equal(calls, before + 1);
    assert.equal(useModels.getState().status, 'loading'); assert.equal(useModels.getState().error, null);
  }
});
