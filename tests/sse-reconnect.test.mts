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
    transcripts: Object.fromEntries(bots.map(({ id }) => [id, { generation: 1, bySeq: { 1: row(id, 1) }, loaded: true, olderCursor: null, revision: 1 }])),
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
    return { generation: 1, revision: 9000, rows: rows[id].filter(row => before === undefined || row.seq < before).slice(-30), olderCursor: null };
  });
  const changes: { id: string; after: number }[] = [];
  t.mock.method(api, 'rowChanges', async (id: string, after: number, through: number, minSeq: number) => {
    changes.push({ id, after });
    const page = rows[id].filter(row => row.updatedSeq > after && row.updatedSeq <= through && row.seq >= minSeq)
      .sort((a, b) => a.updatedSeq - b.updatedSeq).slice(0, 200);
    return { generation: 1, rows: page, nextRev: page.length === 200 ? page.at(-1)!.updatedSeq : null };
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
    assert.equal(requests.filter(request => request.id === 'selected').length, 1, 'only one latest page');
    assert.equal(changes.filter(request => request.id === 'selected').length, 26, 'bounded gap recovery');
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
    const page = Promise.withResolvers<{ generation: number; rows: Row[]; nextRev: number | null }>();
    const reads = t.mock.method(api, 'rows', async (_id: string, before?: number) => before === undefined
      ? { generation: 1, revision: 599, rows: Array.from({ length: 30 }, (_, i) => row('selected', i + 570)) } : page.promise);
    const changes = t.mock.method(api, 'rowChanges', () => page.promise);
    const pending = useStore.getState().loadRows('selected', { resync: true });
    await settle();
    if (change === 'clear') useStore.getState().handleEvent({ type: 'cleared', botId: 'selected', generation: 2 });
    if (change === 'account') useStore.setState({ user: { ...user, id: 'next-account' }, transcripts: {} });
    if (change === 'deleted') useStore.setState({ bots: [], transcripts: {} });
    page.resolve({ generation: change === 'generation' ? 2 : 1, rows: [row('selected', 2)], nextRev: null });
    await pending;
    assert.equal(useStore.getState().transcripts.selected?.bySeq[2], undefined);
    reads.mock.restore(); changes.mock.restore(); t.mock.timers.reset();
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

test('latest rows publish before held revision recovery and unchanged history is not refetched', async t => {
  setup(t);
  const pending = Promise.withResolvers<{ generation: number; rows: Row[]; nextRev: number | null }>();
  const latest = t.mock.method(api, 'rows', async () => ({ generation: 1, revision: 800, rows: [row('selected', 800)], olderCursor: 800 }));
  const changes = t.mock.method(api, 'rowChanges', () => pending.promise);
  const load = useStore.getState().loadRows('selected', { resync: true });
  await settle();
  const visible = useStore.getState().transcripts.selected;
  assert.ok(visible.loaded && !visible.loading);
  assert.ok(visible.bySeq[800], 'latest message is ready while gap recovery is held');
  assert.equal(visible.revision, 1, 'a pending recovery cannot advance the complete watermark');
  pending.resolve({ generation: 1, rows: [row('selected', 1, 800)], nextRev: null });
  await load;
  assert.equal(useStore.getState().transcripts.selected.bySeq[1].updatedSeq, 800);
  assert.equal(useStore.getState().transcripts.selected.revision, 800);
  await useStore.getState().loadRows('selected', { resync: true });
  assert.equal(latest.mock.callCount(), 2);
  assert.equal(changes.mock.callCount(), 1, 'unchanged snapshot needs no history recovery');
});

test('failed revision recovery retains its watermark and a later reconnect retries', async t => {
  setup(t);
  t.mock.method(api, 'rows', async () => ({ generation: 1, revision: 800, rows: [row('selected', 800)] }));
  let fail = true;
  const cursors: number[] = [];
  t.mock.method(api, 'rowChanges', async (_id: string, after: number) => {
    cursors.push(after);
    if (fail) throw new Error('Offline fixture');
    return { generation: 1, rows: [row('selected', 1, 799)], nextRev: null };
  });
  await useStore.getState().loadRows('selected', { resync: true });
  assert.equal(useStore.getState().transcripts.selected.revision, 1);
  assert.ok(useStore.getState().transcripts.selected.bySeq[800]);
  fail = false;
  await useStore.getState().loadRows('selected', { resync: true });
  assert.deepEqual(cursors, [1, 1]);
  assert.equal(useStore.getState().transcripts.selected.bySeq[1].updatedSeq, 799);
  assert.equal(useStore.getState().transcripts.selected.revision, 800);
});

test('an empty cached conversation keeps an older cursor after a large missed burst', async t => {
  setup(t);
  useStore.setState({ transcripts: { selected: { generation: 1, loaded: true, bySeq: {}, olderCursor: null, revision: 0 } } });
  t.mock.method(api, 'rows', async () => ({ generation: 1, revision: 720,
    rows: Array.from({ length: 24 }, (_, i) => row('selected', i + 697)), olderCursor: 697 }));
  const reads = t.mock.method(api, 'rowChanges', async (_id: string, _after: number, _through: number, floor: number) => {
    assert.equal(floor, 697, 'no previous visible history needs a gap fill');
    return { generation: 1, rows: [], nextRev: null };
  });
  await useStore.getState().loadRows('selected', { resync: true });
  assert.equal(Object.keys(useStore.getState().transcripts.selected.bySeq).length, 24);
  assert.equal(useStore.getState().transcripts.selected.olderCursor, 697);
  assert.equal(reads.mock.callCount(), 1);
});

test('streams reset just after hello still back off and a healthy heartbeat restores normal retries', async t => {
  setup(t);
  t.mock.method(api, 'rows', async () => ({ generation: 1, rows: [] }));
  const stop = startEvents();
  try {
    for (const delay of [1000, 2000, 4000]) {
      const source = sources.at(-1)!;
      source.onopen(); source.onmessage({ data: '{"type":"hello","serverTime":0}' });
      await source.onerror();
      const length = sources.length;
      t.mock.timers.tick(delay - 1); assert.equal(sources.length, length);
      t.mock.timers.tick(1); assert.equal(sources.length, length + 1);
    }
    const healthy = sources.at(-1)!;
    healthy.onopen();
    t.mock.timers.tick(10_000); healthy.onmessage({ data: '{"type":"ping"}' });
    await healthy.onerror();
    const length = sources.length;
    t.mock.timers.tick(999); assert.equal(sources.length, length);
    t.mock.timers.tick(1); assert.equal(sources.length, length + 1);
    await settle();
  } finally { stop(); }
});

test('duplicate stream errors schedule one quiet reconnect while session validation is pending', async t => {
  setup(t);
  let resolve!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(r => { resolve = r; }));
  const warn = t.mock.method(console, 'warn', () => {}), error = t.mock.method(console, 'error', () => {});
  const stop = startEvents();
  try {
    const source = sources[0]; source.onopen();
    const first = source.onerror(), second = source.onerror();
    resolve(Response.json({ user })); await Promise.all([first, second]);
    t.mock.timers.tick(1000);
    assert.equal(sources.length, 2);
    t.mock.timers.tick(1000);
    assert.equal(sources.length, 2);
    assert.equal(warn.mock.callCount(), 0); assert.equal(error.mock.callCount(), 0);
  } finally { stop(); }
});
