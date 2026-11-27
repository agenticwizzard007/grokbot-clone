import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupReceipts, receiptLoopSummary } from '../../web/src/handoffs/groupReceipts.ts';
import type { Loop } from '../../web/src/handoffs/loops/api.ts';

type Item = { seq: number; kind: string; loopId?: string; iteration?: number };
const receipt = (seq: number, loopId?: string, iteration = 1): Item => ({ seq, kind: 'handoff', loopId, iteration });
const group = (items: readonly Item[]) => groupReceipts(items, item => item.kind === 'handoff' ? item : undefined);

test('consecutive receipts keep their order and identity inside one loop group', () => {
  const rows = [receipt(3, 'a', 1), receipt(5, 'a', 1), receipt(6, 'a', 2), receipt(8)];
  Object.freeze(rows); rows.forEach(Object.freeze);
  assert.deepEqual(group(rows), [{ kind: 'loop', loopId: 'a', members: rows.slice(0, 3) }, { kind: 'item', item: rows[3] }]);
});
test('non-loop handoffs and intervening messages, dividers and exchanges break groups', () => {
  for (const middle of [receipt(2), { seq: 2, kind: 'message' }, { seq: 2, kind: 'divider' }, { seq: 2, kind: 'exchange', loopId: 'a' }]) {
    const rows = [receipt(1, 'a'), middle, receipt(3, 'a')];
    assert.deepEqual(group(rows), [{ kind: 'loop', loopId: 'a', members: [rows[0]] }, { kind: 'item', item: middle }, { kind: 'loop', loopId: 'a', members: [rows[2]] }]);
  }
});
test('two different loops never merge, including a later return to the first', () => {
  const rows = [receipt(1, 'a'), receipt(2, 'b'), receipt(3, 'a')];
  assert.deepEqual(group(rows).map(item => item.kind === 'loop' && item.loopId), ['a', 'b', 'a']);
});
test('a single non-loop handoff stays a normal row', () => {
  const row = receipt(1); assert.deepEqual(group([row]), [{ kind: 'item', item: row }]);
});
test('empty input produces no groups', () => assert.deepEqual(group([]), []));
test('running loop updates pass count live without changing the stable group start', () => {
  const rows = [receipt(1, 'a'), receipt(2, 'a')];
  const loop = { status: 'running', iteration: 1, spec: { limits: { maxIterations: 4 } } } as Loop;
  assert.deepEqual(receiptLoopSummary(rows, loop), { chip: 'Loop, pass 1 of 4', status: 'Running' });
  const updated = [...rows, receipt(3, 'a', 2)];
  assert.equal(group(updated).length, 1);
  assert.deepEqual(receiptLoopSummary(updated, { ...loop, iteration: 2 }), { chip: 'Loop, pass 2 of 4', status: 'Running' });
  assert.deepEqual(receiptLoopSummary(updated, { ...loop, iteration: 3, status: 'succeeded' }), { chip: 'Loop, 3 passes', status: 'Completed' });
});
test('pass counts do not double-count sent and received rows or infer a terminal status', () => {
  const rows = [receipt(1, 'a', 1), receipt(2, 'a', 1)];
  assert.deepEqual(receiptLoopSummary(rows), { chip: 'Loop, 1 pass', status: undefined });
});
test('terminal group status comes from the loop, not a completed member', () => {
  for (const [status, label] of Object.entries({ succeeded: 'Completed', cancelled: 'Stopped', capped: 'Capped', stalled: 'Stopped', failed: 'Failed' })) {
    assert.equal(receiptLoopSummary([], { status, iteration: 3 } as Loop).status, label);
  }
});
