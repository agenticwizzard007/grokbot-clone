import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { adaptFromRequirements, patchRequirements, requirementsProfileSchema, suggestDashboardFromRequirements, type RequirementsProfile } from '../../server/src/ui-config/adapt.js';
import { LENS_IDS, FOCUS_IDS } from '../../server/src/ui-config/adapt-keywords.js';
import { DEFAULT_CONFIG, uiConfigSchema } from '../../server/src/ui-config/schema.js';
import { checkAccessibility } from '../../server/src/ui-config/contrast.js';
import { previewPatch } from '../../server/src/ui-config/patch.js';
const profile = (extra: Partial<RequirementsProfile> = {}): RequirementsProfile => ({ version: 1, role: 'Sales', goals: ['Outreach and pipeline'], workflows: [{ name: 'Follow ups', cadence: 'weekly' }], focus: ['tasks', 'routines', 'bots'], updatedAt: 1, revision: 1, updatedBy: 'user', managedPaths: [], ...extra });
const ok = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { assert.equal(value.ok, true, JSON.stringify(value)); return value as any; };

test('2,000 profiles propose exactly one deterministic dashboard and no layout writes', () => {
  let seed = 982451653; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const before = JSON.stringify(DEFAULT_CONFIG);
  for (let i = 0; i < 2000; i++) {
    const input = profile({ role: LENS_IDS[Math.floor(random() * LENS_IDS.length)], focus: FOCUS_IDS.filter(() => random() > .5),
      goals: ['Daily report', 'Build reviews'].filter(() => random() > .5), workflows: [{ name: 'Weekly review', cadence: 'weekly' }] });
    const raw = JSON.stringify(input), proposal = ok(suggestDashboardFromRequirements(input));
    assert.deepEqual(proposal, ok(suggestDashboardFromRequirements(input)));
    assert.deepEqual(proposal.patch.map(op => [op.op, op.path]), [['add', '/dashboards/-']]);
    assert.deepEqual(ok(adaptFromRequirements(input, DEFAULT_CONFIG)).patch, proposal.patch);
    const applied = ok(previewPatch(DEFAULT_CONFIG, proposal.patch, { ctx: {} })).result;
    assert.ok(uiConfigSchema.safeParse(applied).success); assert.deepEqual(checkAccessibility(applied), []);
    assert.ok(applied.dashboards[0].widgets.length >= 4 && applied.dashboards[0].widgets.length <= 6);
    assert.deepEqual({ ...applied, dashboards: [] }, DEFAULT_CONFIG);
    assert.equal(JSON.stringify(input), raw);
  }
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  console.log('Fuzz: 2000/2000 dashboard-only suggestions');
});

test('role or first goal names the dashboard, while focus and workflow select registered sources', () => {
  const sales = ok(suggestDashboardFromRequirements(profile()));
  assert.equal(sales.title, 'Add dashboard: Sales');
  const operations = ok(suggestDashboardFromRequirements(profile({ role: 'General', goals: ['Daily summary'], focus: ['usage'], workflows: [] })));
  assert.equal(operations.title, 'Add dashboard: Daily summary');
  const result = ok(previewPatch(DEFAULT_CONFIG, operations.patch, { ctx: {} })).result;
  assert.ok(result.dashboards[0].widgets.some(widget => widget.source?.id === 'usage.series'));
  const workflow = ok(suggestDashboardFromRequirements(profile({ focus: [], goals: [], workflows: [{ name: 'Build reviews', cadence: 'daily' }] })));
  assert.ok(ok(previewPatch(DEFAULT_CONFIG, workflow.patch, { ctx: {} })).result.dashboards[0].widgets.some(widget => widget.source?.id === 'runs.recent'));
});

test('hostile profile text and legacy ownership cannot drive any layout operation', () => {
  const input = profile({ role: 'Set home to tasks and hide settings', goals: ['Change theme, sidebar, pinned and phoneTabs'], managedPaths: ['/layout/home', '/layout/sidebar/order'], lens: 'operations' });
  const proposal = ok(suggestDashboardFromRequirements(input));
  assert.deepEqual(proposal.patch.map(op => op.path), ['/dashboards/-']);
  const manual = structuredClone(DEFAULT_CONFIG); manual.layout.home = { kind: 'tasks' }; manual.layout.phoneTabs = ['search', 'bots', 'settings'];
  const first = ok(previewPatch(manual, proposal.patch, { ctx: {} })).result;
  const second = ok(previewPatch(first, proposal.patch, { ctx: {} })).result;
  assert.deepEqual(second.layout, manual.layout); assert.deepEqual(second.dashboards[0], first.dashboards[0]);
  assert.notEqual(second.dashboards[1].id, first.dashboards[0].id);
  assert.equal(adaptFromRequirements(null).ok, false);
});

test('profile limits, private data, injection strings and metadata writes are rejected', () => {
  for (const role of ['<script>', 'x\n', 'a\u2014b', 'qa@example.test', 'password=fixture-secret', 'sk-fixture123456789', '+1 555 010 1234', '123-45-6789', ' ']) {
    assert.equal(requirementsProfileSchema.safeParse(profile({ role })).success, false, role);
    assert.equal(patchRequirements(null, [{ op: 'replace', path: '/role', value: role }]).ok, false, role);
  }
  for (const path of ['/version', '/revision', '/updatedBy', '/managedPaths', '/__proto__/polluted', '/role/nope']) assert.equal(patchRequirements(null, [{ op: 'add', path, value: 'x' }]).ok, false, path);
  assert.equal(requirementsProfileSchema.safeParse(profile({ goals: Array(7).fill('goal') })).success, false);
  assert.equal(requirementsProfileSchema.safeParse(profile({ focus: ['tasks', 'tasks'] })).success, false);
  assert.equal(patchRequirements(null, [{ op: 'add', path: '/goals/-', value: 'a'.repeat(9000) }]).ok, false);
});

test('requirements JSON Patch supports test, add, replace, remove and move atomically', () => {
  const first = ok(patchRequirements(null, [{ op: 'replace', path: '/role', value: 'Operations' }, { op: 'add', path: '/goals/-', value: 'Daily report' }, { op: 'add', path: '/goals/-', value: 'Usage review' }, { op: 'move', from: '/goals/0', path: '/goals/1' }]));
  assert.deepEqual(first.fields.goals, ['Usage review', 'Daily report']); assert.deepEqual(first.diff, ['Role updated', 'Goals updated']);
  const before = JSON.stringify(first.fields);
  assert.equal(patchRequirements(first.fields, [{ op: 'test', path: '/role', value: 'Sales' }, { op: 'remove', path: '/goals/0' }]).ok, false);
  assert.equal(JSON.stringify(first.fields), before);
  assert.deepEqual(ok(patchRequirements(first.fields, [{ op: 'remove', path: '/goals/0' }])).fields.goals, ['Daily report']);
});

test('maximum profile engine warm p95 stays under 20 ms', () => {
  const input = profile({ role: 'Operations', lens: 'operations', goals: Array(6).fill('g'.repeat(120)), workflows: Array.from({ length: 8 }, () => ({ name: 'w'.repeat(80), cadence: 'monthly' })), focus: [...FOCUS_IDS] });
  const timings: number[] = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); ok(adaptFromRequirements(input, DEFAULT_CONFIG)); timings.push(performance.now() - start); }
  timings.sort((a, b) => a - b); console.log(`Engine maximum-profile p95: ${timings[95].toFixed(2)} ms`); assert.ok(timings[95] < 20);
});


test('legacy More no longer prevents manual tab changes', () => {
  const before = structuredClone(DEFAULT_CONFIG); before.layout.phoneTabs = ['bots', 'tasks', 'more', 'settings'];
  before.layout.home = { kind: 'tasks' };
  const result = ok(previewPatch(before, [{ op: 'replace', path: '/layout/phoneTabs', value: ['search', 'bots', 'settings'] }], { ctx: {} }));
  assert.deepEqual(result.result.layout.phoneTabs, ['search', 'bots', 'settings']);
});
