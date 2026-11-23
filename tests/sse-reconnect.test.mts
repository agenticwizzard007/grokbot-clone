import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Bot, Row } from '../server/src/types.js';
import { useStore } from '../web/src/store.js';
import { api } from '../web/src/lib/api.js';
import { startEvents } from '../web/src/lib/events.js';
import { currentToast } from '../web/src/lib/toast.js';

const globals = globalThis as Record<string, any>;
const original = Object.fromEntries(['window', 'document', 'EventSource', 'location'].map(key => [key, globals[key]]));
const user = { id: 'sse-owner', name: 'SSE fixture', email: 'sse@example.test', avatarUrl: null };
const row = (botId: string, seq: number, updatedSeq = seq): Row => ({ botId, generation: 1, seq, updatedSeq,
  kind: 'message', body: { type: 'message', role: 'assistant', text: `Fixture ${updatedSeq}` }, createdAt: seq });
let sources: FakeSource[] = [];
class FakeSource {
  closed = false;
  onopen!: () => void;
  onmessage!: (event: { data: string }) => void;
  onerror!: () => Promise<void>;
  constructor(readonly url: string, readonly options: unknown) { sources.push(this); }
  close() { this.closed = true; }
}
function setup(t: TestContext) {
  sources = [];
  globals.EventSource = FakeSource;
  globals.window = new EventTarget();
  globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globals.location = { search: '', pathname: '/' };
  const bots = ['selected', 'cached'].map(id => ({ id, generation: 1 } as Bot));
  useStore.setState({ ...useStore.getInitialState(), user, authChecked: true, bots, botsLoaded: true, selectedBotId: 'selected',
    transcripts: Object.fromEntries(bots.map(({ id }) => [id, { generation: 1, bySeq: { 1: row(id, 1) }, loaded: true, olderCursor: null }])),
  }, true);
  t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(String(input), '/api/auth/me', 'only the local session fixture may be fetched');
    return Response.json({ user });
  });
  t.mock.method(api, 'bots', async () => ({ bots, live: [] }));
  t.mock.method(api, 'computer', async () => ({ computer: null } as any));
  t.mock.method(api, 'routines', async () => ({ routines: [] }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}
afterEach(() => {
  Object.assign(globals, original);
  useStore.setState(useStore.getInitialState(), true);
});
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

test('silent reconnect resyncs a full P-01 burst, cached chats and invalidations without losing newer streamed rows', async t => {
  setup(t);
  const counts = { selected: 5001, cached: 650 };
  const rows = Object.fromEntries(Object.entries(counts).map(([id, count]) => [id,
    Array.from({ length: count }, (_, i) => row(id, i + 1, i === 0 ? 9000 : i + 1)),
  ]));
  const requests: { id: string; before?: number }[] = [];
  t.mock.method(api, 'rows', async (id: string, before?: number) => {
    requests.push({ id, before });
    return { generation: 1, rows: rows[id].filter(row => before === undefined || row.seq < before).slice(-200) };
  });
  const invalidations: string[] = [];
  window.addEventListener('swarm:event', event => invalidations.push((event as CustomEvent).detail.type));
  const stop = startEvents();
  try {
    const first = sources[0];
    assert.equal(first.url, '/api/events');
    assert.deepEqual(first.options, { withCredentials: true });
    first.onopen();
    assert.equal(requests.length, 0);
    await first.onerror();
    assert.equal(first.closed, true);
    assert.equal(useStore.getState().sseConnected, false);
    assert.equal(currentToast(), null);
    t.mock.timers.tick(999);
    assert.equal(sources.length, 1);
    t.mock.timers.tick(1);
    const next = sources[1];
    next.onopen();
    next.onmessage({ data: JSON.stringify({ type: 'rows', botId: 'selected', generation: 1, rows: [row('selected', 5001, 10_000)] }) });
    await settle();
    const state = useStore.getState();
    assert.equal(state.sseConnected, true);
    for (const [id, count] of Object.entries(counts)) {
      assert.deepEqual(Object.keys(state.transcripts[id].bySeq).map(Number), Array.from({ length: count }, (_, i) => i + 1));
      assert.equal(state.transcripts[id].bySeq[1].updatedSeq, 9000, 'updates to cached rows are recovered');
      assert.equal(state.transcripts[id].olderCursor, null);
    }
    assert.equal(state.transcripts.selected.bySeq[5001].updatedSeq, 10_000);
    assert.equal(requests.filter(request => request.id === 'selected').length, 26);
    assert.equal(state.connectionsVersion, 1);
    for (const type of ['tasks', 'memories', 'setup', 'messaging', 'synopses', 'native']) assert.ok(invalidations.includes(type), type);
    first.onmessage({ data: JSON.stringify({ type: 'cleared', botId: 'selected', generation: 2 }) });
    assert.equal(useStore.getState().transcripts.selected.generation, 1, 'a replaced source cannot mutate the store');
    assert.equal(currentToast(), null);
  } finally { stop(); }
});

test('reconnect backoff is bounded, background failures stay silent and stop cancels retries', async t => {
  setup(t);
  t.mock.method(api, 'rows', async () => { throw new Error('Offline fixture'); });
  t.mock.method(api, 'bots', async () => { throw new Error('Offline fixture'); });
  const stop = startEvents();
  sources[0].onopen();
  try {
    for (const delay of [1000, 2000, 4000, 8000, 15_000, 15_000]) {
      const length = sources.length;
      await sources.at(-1)!.onerror();
      t.mock.timers.tick(delay - 1);
      assert.equal(sources.length, length);
      t.mock.timers.tick(1);
      assert.equal(sources.length, length + 1);
    }
    sources.at(-1)!.onopen();
    await settle();
    assert.equal(useStore.getState().botsError, null);
    for (const transcript of Object.values(useStore.getState().transcripts)) assert.ok(!transcript.error);
    assert.equal(currentToast(), null);
    await sources.at(-1)!.onerror();
    const length = sources.length;
    stop(); t.mock.timers.tick(60_000);
    assert.equal(sources.length, length);
  } finally { stop(); }
});

test('data pings keep the watchdog quiet and a silent stream reconnects with resync', async t => {
  setup(t);
  const reads = t.mock.method(api, 'rows', async (id: string) => ({ generation: 1, rows: [row(id, 1)] }));
  const stop = startEvents();
  try {
    sources[0].onopen();
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(10_000);
      sources[0].onmessage({ data: '{"type":"ping"}' });
    }
    assert.equal(sources.length, 1);
    t.mock.timers.tick(45_000);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].closed, true);
    sources[1].onopen();
    await settle();
    assert.equal(reads.mock.callCount(), 2);
    assert.equal(currentToast(), null);
  } finally { stop(); }
});

test('resync pages cannot restore a cleared conversation or a departed account', async t => {
  for (const change of ['clear', 'account', 'deleted', 'generation']) {
    setup(t);
    const page = Promise.withResolvers<{ generation: number; rows: Row[] }>();
    const reads = t.mock.method(api, 'rows', async (_id: string, before?: number) => before === undefined
      ? { generation: 1, rows: Array.from({ length: 200 }, (_, i) => row('selected', i + 400)) } : page.promise);
    const pending = useStore.getState().loadRows('selected', { resync: true });
    await settle();
    if (change === 'clear') useStore.getState().handleEvent({ type: 'cleared', botId: 'selected', generation: 2 });
    if (change === 'account') useStore.setState({ user: { ...user, id: 'next-account' }, transcripts: {} });
    if (change === 'deleted') useStore.setState({ bots: [], transcripts: {} });
    page.resolve({ generation: change === 'generation' ? 2 : 1, rows: [row('selected', 2)] });
    await pending;
    assert.equal(useStore.getState().transcripts.selected?.bySeq[2], undefined);
    reads.mock.restore(); t.mock.timers.reset();
  }
});

test('an initial stream failure still resyncs snapshots on the first successful open', async t => {
  setup(t);
  const reads = t.mock.method(api, 'rows', async (id: string) => ({ generation: 1, rows: [row(id, 1), row(id, 2)] }));
  const stop = startEvents();
  try {
    await sources[0].onerror();
    t.mock.timers.tick(1000);
    sources[1].onopen();
    await settle();
    assert.equal(reads.mock.callCount(), 2);
    assert.ok(useStore.getState().transcripts.selected.bySeq[2]);
    assert.equal(currentToast(), null);
  } finally { stop(); }
});
