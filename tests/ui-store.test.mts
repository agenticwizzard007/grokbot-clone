import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Bot } from '../shared/types.js';
import { useStore } from '../web/src/store.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; useStore.setState({ user: null, bots: [], live: {}, selectedBotId: null }); });

test('a roster refresh from a departed account cannot publish bots or change selection', async () => {
  const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null });
  const bobBot = { id: 'bob-bot', generation: 1 } as Bot;
  useStore.setState({ user: user('alice') });
  let release!: () => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ bots: [{ id: 'alice-bot', generation: 1 }], live: [] });
  };
  const pending = useStore.getState().loadBots();
  useStore.setState({ user: user('bob'), bots: [bobBot], selectedBotId: bobBot.id });
  release();
  await pending;
  assert.deepEqual(useStore.getState().bots, [bobBot]);
  assert.equal(useStore.getState().selectedBotId, bobBot.id);
  assert.equal(calls, 1, 'a dropped roster cannot trigger transcript/routine reads');
  useStore.setState({ user: null });
  await useStore.getState().loadBots();
  assert.equal(calls, 1, 'signed-out refresh does not dispatch');
});
