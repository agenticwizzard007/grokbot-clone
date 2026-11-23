import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Bot, Row } from '../server/src/types.js';
import { api } from '../web/src/lib/api.js';
import { useStore } from '../web/src/store.js';

const id = 'history-fixture';
const user = { id: 'history-owner', name: 'QA account', email: 'history@example.test', avatarUrl: null };
const row = (seq: number, updatedSeq = seq): Row => ({ botId: id, generation: 1, seq, updatedSeq,
  kind: 'message', body: { type: 'message', role: 'assistant', text: `Fixture message ${seq}` }, createdAt: seq * 1000 });
function setup(count = 260) {
  useStore.setState({ ...useStore.getInitialState(), user, bots: [{ id, generation: 1 } as Bot] }, true);
  return Array.from({ length: count }, (_, i) => row(i + 1));
}
const transcript = () => useStore.getState().transcripts[id];
afterEach(() => useStore.setState(useStore.getInitialState(), true));

test('C-01: earlier pages merge all 260 rows and remain complete after a latest-window refresh', async t => {
  const rows = setup();
  const calls: (number | undefined)[] = [];
  t.mock.method(api, 'rows', async (_id: string, before?: number) => {
    calls.push(before);
    return { generation: 1, rows: rows.filter(r => before === undefined || r.seq < before).slice(-200) };
  });
  await useStore.getState().loadRows(id);
  assert.equal(Object.keys(transcript().bySeq).length, 200);
  assert.equal(transcript().olderCursor, 61);
  await useStore.getState().loadOlderRows(id);
  assert.equal(Object.keys(transcript().bySeq).length, 260);
  assert.equal(transcript().bySeq[1].seq, 1);
  assert.equal(transcript().olderCursor, null);
  await useStore.getState().loadRows(id);
  await useStore.getState().loadOlderRows(id);
  assert.equal(Object.keys(transcript().bySeq).length, 260);
  assert.equal(transcript().olderCursor, null);
  assert.deepEqual(calls, [undefined, 61, undefined]);
});

test('C-01: search loads an unopened 660-row conversation through every page', async t => {
  const rows = setup(660), calls: (number | undefined)[] = [];
  t.mock.method(api, 'rows', async (_id: string, before?: number) => {
    calls.push(before);
    return { generation: 1, rows: rows.filter(r => before === undefined || r.seq < before).slice(-200) };
  });
  assert.equal(await useStore.getState().ensureRowLoaded(id, 1, 1), true);
  assert.deepEqual(calls, [undefined, 461, 261, 61]);
  assert.equal(Object.keys(transcript().bySeq).length, 660);
  assert.equal(await useStore.getState().ensureRowLoaded(id, 1, 660), true);
  assert.equal(await useStore.getState().ensureRowLoaded(id, 1, 700), false);
  assert.equal(await useStore.getState().ensureRowLoaded(id, 0, 1), false);
  assert.equal(calls.length, 4, 'cached and unavailable results do not refetch');
});

test('C-01: concurrent paging shares its request and preserves newer SSE revisions', async t => {
  const rows = setup();
  const response = Promise.withResolvers<{ generation: number; rows: Row[] }>();
  const fetchRows = t.mock.method(api, 'rows', async (_id: string, before?: number) => before === undefined
    ? { generation: 1, rows: rows.slice(-200) } : response.promise);
  await useStore.getState().loadRows(id);
  const first = useStore.getState().loadOlderRows(id);
  const search = useStore.getState().ensureRowLoaded(id, 1, 1);
  const duplicate = useStore.getState().loadOlderRows(id);
  useStore.getState().upsertRows(id, 1, [row(1, 900), row(261, 901)]);
  assert.equal(transcript().olderCursor, 61, 'SSE does not move the fetched page boundary');
  response.resolve({ generation: 1, rows: rows.slice(0, 60) });
  await Promise.all([first, duplicate]);
  assert.equal(await search, true);
  assert.equal(fetchRows.mock.callCount(), 2);
  assert.equal(transcript().bySeq[1].updatedSeq, 900);
  assert.equal(transcript().bySeq[261].updatedSeq, 901);
  assert.equal(transcript().loadingOlder, false);
});

test('C-01: a failed page can be retried and an exact full window ends with an empty page', async t => {
  const rows = setup(200);
  let fail = true;
  t.mock.method(api, 'rows', async (_id: string, before?: number) => {
    if (before === undefined) return { generation: 1, rows };
    if (fail) throw new Error('offline fixture');
    return { generation: 1, rows: [] };
  });
  await useStore.getState().loadRows(id);
  await assert.rejects(useStore.getState().loadOlderRows(id), /offline/);
  assert.equal(transcript().loadingOlder, false);
  assert.ok(transcript().olderError);
  assert.equal(transcript().olderCursor, 1);
  fail = false;
  await useStore.getState().loadOlderRows(id);
  assert.equal(transcript().olderCursor, null);
  assert.equal(transcript().olderError, null);
  assert.equal(Object.keys(transcript().bySeq).length, 200);
});

test('C-01: delayed pages cannot restore cleared history or a departed account', async t => {
  for (const change of ['clear', 'account', 'deleted', 'server-generation']) {
    const rows = setup();
    const response = Promise.withResolvers<{ generation: number; rows: Row[] }>();
    const fetchRows = t.mock.method(api, 'rows', async (_id: string, before?: number) => before === undefined
      ? { generation: 1, rows: rows.slice(-200) } : response.promise);
    await useStore.getState().loadRows(id);
    const pending = useStore.getState().ensureRowLoaded(id, 1, 1);
    if (change === 'clear') useStore.getState().handleEvent({ type: 'cleared', botId: id, generation: 2 });
    if (change === 'account') useStore.setState({ user: { ...user, id: 'next-owner' }, transcripts: {} });
    if (change === 'deleted') useStore.setState({ bots: [], transcripts: {} });
    response.resolve({ generation: change === 'server-generation' ? 2 : 1, rows: rows.slice(0, 60) });
    assert.equal(await pending, false);
    assert.equal(transcript()?.bySeq[1], undefined);
    if (change === 'clear') assert.equal(transcript().generation, 2);
    fetchRows.mock.restore();
  }
});
