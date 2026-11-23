import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Bot, Row } from '../shared/types.js';
import { api } from '../web/src/lib/api.js';
import { useStore } from '../web/src/store.js';

const globals = globalThis as Record<string, unknown>;
const originalLocation = globals.location;
const user = { id: 'fixture-owner', email: 'fixture@example.test', name: 'QA account', avatarUrl: null };
const bot = { id: 'fixture-bot', generation: 1 } as Bot;
const row = { botId: bot.id, generation: 1, seq: 1, updatedSeq: 1, kind: 'message',
  body: { type: 'message', role: 'assistant', text: 'Saved fixture message' }, createdAt: 1000 } as Row;
const state = () => useStore.getState();
const transcript = () => state().transcripts[bot.id];
function setup() {
  useStore.setState({ ...useStore.getInitialState(), user, bots: [bot], selectedBotId: bot.id }, true);
}
afterEach(() => { useStore.setState(useStore.getInitialState(), true); globals.location = originalLocation; });

test('P-10: initial roster failure, pending retry, and empty success are distinct', async t => {
  setup();
  useStore.setState({ bots: [] });
  t.mock.method(api, 'bots', async () => { throw new Error('private fixture diagnostic'); });
  await state().loadBots();
  assert.equal(state().botsLoaded, false);
  assert.equal(state().botsLoading, false);
  assert.match(state().botsError!, /Couldn't load your Bots/);
  assert.doesNotMatch(state().botsError!, /private/);
  const pending = Promise.withResolvers<{ bots: Bot[]; live: [] }>();
  t.mock.method(api, 'bots', () => pending.promise);
  const retry = state().loadBots();
  assert.equal(state().botsLoading, true);
  assert.ok(state().botsError);
  // The roster's URL handling runs in the browser.
  globals.location = { search: '', pathname: '/' };
  pending.resolve({ bots: [], live: [] });
  await retry;
  assert.equal(state().botsError, null);
  assert.equal(state().botsLoading, false);
  assert.equal(state().botsLoaded, true);
  assert.equal(state().selectedBotId, null);
});

test('P-10: failed roster refresh retains Bots and selection', async t => {
  setup();
  useStore.setState({ botsLoaded: true });
  t.mock.method(api, 'bots', async () => { throw new Error('offline'); });
  await state().loadBots();
  assert.deepEqual(state().bots, [bot]);
  assert.equal(state().selectedBotId, bot.id);
  assert.equal(state().botsLoaded, true);
  assert.ok(state().botsError);
});

test('P-10: first transcript failure retries to empty success without losing streamed rows', async t => {
  setup();
  t.mock.method(api, 'rows', async () => { throw new Error('offline'); });
  await state().loadRows(bot.id);
  assert.equal(transcript().loaded, false);
  assert.equal(transcript().loading, false);
  assert.ok(transcript().error);
  const pending = Promise.withResolvers<{ generation: number; rows: Row[] }>();
  t.mock.method(api, 'rows', () => pending.promise);
  const retry = state().loadRows(bot.id);
  assert.equal(transcript().loading, true);
  assert.ok(transcript().error);
  state().upsertRows(bot.id, 1, [row]);
  pending.resolve({ generation: 1, rows: [] });
  await retry;
  assert.equal(transcript().loaded, true);
  assert.equal(transcript().loading, false);
  assert.equal(transcript().error, null);
  assert.deepEqual(transcript().bySeq[1], row);
});

test('P-10: failed transcript refresh retains history and is scoped to its Bot', async t => {
  setup();
  t.mock.method(api, 'rows', async () => ({ generation: 1, rows: [row] }));
  await state().loadRows(bot.id);
  t.mock.method(api, 'rows', async () => { throw new Error('offline'); });
  await state().loadRows(bot.id);
  assert.deepEqual(transcript().bySeq[1], row);
  assert.equal(transcript().loaded, true);
  assert.ok(transcript().error);
  useStore.setState({ bots: [bot, { ...bot, id: 'other-bot' }], selectedBotId: 'other-bot' });
  assert.equal(state().transcripts['other-bot'], undefined);
});

for (const outcome of ['success', 'failure']) {
  for (const resource of ['roster', 'transcript']) {
    test(`P-10: late ${resource} ${outcome} cannot affect a departed and reopened account`, async t => {
      setup();
      const pending = Promise.withResolvers<any>();
      t.mock.method(api, resource === 'roster' ? 'bots' : 'rows', () => pending.promise);
      const load = resource === 'roster' ? state().loadBots() : state().loadRows(bot.id);
      useStore.setState({ user: null });
      useStore.setState({ user, bots: [bot] });
      if (outcome === 'success') pending.resolve(resource === 'roster' ? { bots: [], live: [] } : { generation: 1, rows: [row] });
      else pending.reject(new Error('late failure'));
      await load;
      assert.deepEqual(state().bots, [bot]);
      assert.equal(state().botsLoading, false);
      assert.equal(state().botsError, null);
      assert.equal(transcript(), undefined);
    });
  }
  test(`P-10: late transcript ${outcome} cannot overwrite a cleared conversation`, async t => {
    setup();
    const pending = Promise.withResolvers<{ generation: number; rows: Row[] }>();
    t.mock.method(api, 'rows', () => pending.promise);
    const load = state().loadRows(bot.id);
    state().handleEvent({ type: 'cleared', botId: bot.id, generation: 2 });
    if (outcome === 'success') pending.resolve({ generation: 1, rows: [row] });
    else pending.reject(new Error('late failure'));
    await load;
    assert.deepEqual(transcript(), { generation: 2, bySeq: {}, loaded: true });
  });
}

test('P-10: latest requests win when overlapping reads finish out of order', async t => {
  setup();
  const old = Promise.withResolvers<{ generation: number; rows: Row[] }>();
  let calls = 0;
  t.mock.method(api, 'rows', () => ++calls === 1 ? old.promise : Promise.resolve({ generation: 1, rows: [row] }));
  const first = state().loadRows(bot.id);
  await state().loadRows(bot.id);
  old.reject(new Error('late failure'));
  await first;
  assert.equal(transcript().error, null);
  assert.equal(transcript().loading, false);
  assert.deepEqual(transcript().bySeq[1], row);
});

test('P-10: retry can confirm an empty transcript', async t => {
  setup();
  t.mock.method(api, 'rows', async () => { throw new Error('offline'); });
  await state().loadRows(bot.id);
  t.mock.method(api, 'rows', async () => ({ generation: 1, rows: [] }));
  await state().loadRows(bot.id);
  assert.equal(transcript().loaded, true);
  assert.equal(transcript().error, null);
  assert.equal(transcript().loading, false);
  assert.deepEqual(transcript().bySeq, {});
});

test('P-10: an initial snapshot can complete the newer generation that streamed during the read', async t => {
  setup();
  const pending = Promise.withResolvers<{ generation: number; rows: Row[] }>();
  t.mock.method(api, 'rows', () => pending.promise);
  const load = state().loadRows(bot.id);
  const nextRow = { ...row, generation: 2 };
  state().upsertRows(bot.id, 2, [nextRow]);
  pending.resolve({ generation: 2, rows: [] });
  await load;
  assert.equal(transcript().loaded, true);
  assert.equal(transcript().loading, false);
  assert.equal(transcript().error, null);
  assert.deepEqual(transcript().bySeq[1], nextRow);
});
