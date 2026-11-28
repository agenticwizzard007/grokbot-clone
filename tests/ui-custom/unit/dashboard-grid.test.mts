import assert from 'node:assert/strict';
import test from 'node:test';
import { statRowSpans } from '../../../web/src/dashboards/grid.ts';

test('a lone phone stat fills the row before a full-width schedule', () => {
  assert.deepEqual(statRowSpans([{ type: 'stat' }, { type: 'routineSchedule' }], [2, 6], 6), [6, 6]);
});
test('three KPI tiles keep their equal columns', () => {
  assert.deepEqual(statRowSpans(Array(3).fill({ type: 'stat' }), [2, 2, 2], 6), [2, 2, 2]);
});
test('an odd final half-width stat fills the remaining row', () => {
  assert.deepEqual(statRowSpans(Array(3).fill({ type: 'stat' }), [6, 6, 6], 12), [6, 6, 12]);
});
test('a lone desktop KPI and its following schedule each finish their row', () => {
  assert.deepEqual(statRowSpans([{ type: 'stat' }, { type: 'routineSchedule' }], [4, 8], 12), [12, 12]);
});
test('row completion respects preceding cards without moving the widget order', () => {
  assert.deepEqual(statRowSpans([{ type: 'list' }, { type: 'stat' }, { type: 'note' }], [6, 4, 12], 12), [6, 6, 12]);
});
