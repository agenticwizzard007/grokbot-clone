import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryUiConfigService, LIMITS } from '../../../server/src/ui-config/index.ts';
import { serviceContract } from './service-contract.mts';
serviceContract('MemoryUiConfigService', options => new MemoryUiConfigService(options));
test('history is capped at 50 revisions expires at 90 days and is isolated', () => {
  let now = 1000; const s = new MemoryUiConfigService({ now: () => now });
  for (let i = 0; i < 60; i++) { now++; assert.ok(s.patch('QA-Temp-a', [{ op: 'replace', path: '/theme/mode', value: i % 2 ? 'dark' : 'light' }], i, 'user').ok); }
  const history = s.getHistory('QA-Temp-a'); assert.equal(history.length, 50); assert.equal(history[0].revision, 59); assert.equal(history.at(-1)!.revision, 10);
  history[0].doc.theme.mode = 'system'; assert.notEqual(s.getHistory('QA-Temp-a')[0].doc.theme.mode, 'system'); assert.deepEqual(s.getHistory('QA-Temp-b'), []);
  now += LIMITS.historyDays * 86400000; assert.deepEqual(s.getHistory('QA-Temp-a'), []); assert.equal(s.undo('QA-Temp-a', 1, 'user').ok, false);
});
test('feature and apply mode callbacks are evaluated for each user', () => {
  const s = new MemoryUiConfigService({ enabled: id => id === 'QA-Temp-a', agentApplyMode: id => id === 'QA-Temp-a' ? 'auto' : 'ask' });
  assert.equal(s.enabled('QA-Temp-a'), true); assert.equal(s.enabled('QA-Temp-b'), false); assert.equal(s.agentApplyMode('QA-Temp-a'), 'auto'); assert.equal(s.agentApplyMode('QA-Temp-b'), 'ask');
});
