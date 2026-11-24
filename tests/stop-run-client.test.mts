import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useStore } from '../web/src/store.js';
const id = 'bot-stop';
const state = (runId: string, revision: number, isRunning = true) => ({ botId: id, runId, revision, isRunning, activity: null, awaiting: null, startedAt: null });
const row = (runId: string, seq: number, text: string) => ({ botId: id, generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: seq,
  body: { type: 'message' as const, role: 'assistant' as const, text, jobId: runId } });
afterEach(() => useStore.setState({ live: {}, transcripts: {} }));
test('client drops cancelled text, tool, bot and live events after stop-then-send', () => {
  const apply = useStore.getState().handleEvent;
  apply({ type: 'live', state: state('old', 1) });
  apply({ type: 'rows', runId: 'old', runBotId: id, botId: id, generation: 1, rows: [row('old', 1, 'Partial bees')] });
  apply({ type: 'live', state: state('old', 2, false) });
  apply({ type: 'rows', runId: 'old', runBotId: id, botId: id, generation: 1, rows: [row('old', 2, 'Late bees')] });
  apply({ type: 'live', state: state('new', 3) });
  const before = useStore.getState();
  for (const event of [
    { type: 'rows', botId: id, generation: 1, rows: [row('old', 3, 'Late bees and tool output')] },
    { type: 'bot', bot: { id, name: 'late overwrite' } },
    { type: 'tasks', botId: id },
    { type: 'live', state: state('old', 2, false) },
    { type: 'live', state: state('old', 1) },
  ]) apply({ ...event, runId: 'old', runBotId: id } as any);
  assert.equal(useStore.getState(), before);
  apply({ type: 'rows', runId: 'new', runBotId: id, botId: id, generation: 1, rows: [row('new', 4, 'Tea only')] });
  const replies = Object.values(useStore.getState().transcripts[id].bySeq);
  assert.deepEqual(replies.map(r => r.body.text), ['Partial bees', 'Tea only']);
  assert.notEqual(replies[0].body.jobId, replies[1].body.jobId);
});
test('client keeps legitimate historical rows when reconnecting after cancellation', () => {
  useStore.setState({ live: { [id]: state('new', 9) } });
  useStore.getState().upsertRows(id, 1, [row('old', 1, 'Partial bees'), row('new', 4, 'Tea only')]);
  assert.equal(Object.keys(useStore.getState().transcripts[id].bySeq).length, 2);
});
