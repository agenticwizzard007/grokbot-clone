import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import type { PlanUsageSummary } from '../server/src/plan-usage-types.js';
const { planUsageDisplay } = await tsImport('../web/src/lib/planUsageDisplay.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const plan: PlanUsageSummary['plan'] = { name: 'API credits', billing: 'api', provider: null,
  periodStart: 0, periodEnd: Date.parse('2026-11-30T20:00:00Z'), resetsAt: Date.parse('2026-11-30T20:00:00Z'),
  usedCents: 5, limitCents: 20, percentUsed: 25, unit: 'usd', estimatedCents: 3, unpricedRequests: 1 };

test('meter amount reconciles mixed ledger fixtures per event to the cent', () => {
  const { events } = JSON.parse(fs.readFileSync(new URL('./fixtures/usage-summary.json', import.meta.url), 'utf8'));
  const usedCents = events.filter((event: any) => event.keyKind === 'native').reduce((sum: number, event: any) => sum + (event.cost === null ? 0 : Math.round(event.cost * 100)), 0);
  assert.equal(usedCents, plan.usedCents);
  const display = planUsageDisplay({ ...plan, usedCents });
  assert.equal(display.amount, '$0.05 of $0.20');
  assert.equal(display.status, '25% used');
});
test('warning and critical display clamp without losing the raw over-limit figure', () => {
  assert.equal(planUsageDisplay({ ...plan, percentUsed: 79 }).level, 'normal');
  assert.equal(planUsageDisplay({ ...plan, percentUsed: 80 }).warning, 'Near limit');
  const over = { ...plan, usedCents: 25, percentUsed: 125 };
  const display = planUsageDisplay(over);
  assert.equal(display.amount, '$0.25 of $0.20');
  assert.equal(display.percent, 100);
  assert.equal(display.status, '100% used');
  assert.equal(display.warning, 'Limit reached');
  assert.equal(over.percentUsed, 125);
});
test('no dollar allowance shows the exact spend and no invented percentage', () => {
  const display = planUsageDisplay({ ...plan, limitCents: null, percentUsed: null });
  assert.equal(display.amount, '$0.05');
  assert.equal(display.status, 'No limit');
  assert.equal(display.percent, null);
});
test('an unknown CLI quota is distinct from an unlimited API plan', () => {
  for (const percentUsed of [null, NaN, Infinity]) {
    const display = planUsageDisplay({ ...plan, billing: 'plan', unit: 'percent', limitCents: null, percentUsed });
    assert.equal(display.amount, 'Quota unavailable');
    assert.equal(display.percent, null);
    assert.notEqual(display.status, 'No limit');
  }
});
test('reset date follows the account calendar at its exact period boundary', () => {
  assert.equal(planUsageDisplay(plan, 'Asia/Dubai').reset, 'Resets Dec 1');
  assert.equal(planUsageDisplay(plan, 'UTC').reset, 'Resets Nov 30');
  assert.equal(planUsageDisplay(plan, 'invalid').reset, 'Resets Nov 30');
  assert.equal(planUsageDisplay({ ...plan, resetsAt: null }).reset, 'Reset unavailable');
});
