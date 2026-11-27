import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { adaptFromRequirements, patchRequirements, requirementsProfileSchema, selectLens, type RequirementsProfile } from '../../server/src/ui-config/adapt.js';
import { ADAPT_LENSES } from '../../server/src/ui-config/adapt-lenses.js';
import { LENS_IDS, FOCUS_IDS } from '../../server/src/ui-config/adapt-keywords.js';
import { DEFAULT_CONFIG, uiConfigSchema } from '../../server/src/ui-config/schema.js';
import { checkAccessibility } from '../../server/src/ui-config/contrast.js';
import { previewPatch } from '../../server/src/ui-config/patch.js';
const profile = (extra: Partial<RequirementsProfile> = {}): RequirementsProfile => ({ version: 1, role: 'Sales', goals: ['Outreach and pipeline'], workflows: [{ name: 'Follow ups', cadence: 'weekly' }], focus: ['tasks', 'routines', 'bots'], updatedAt: 1, revision: 1, updatedBy: 'user', managedPaths: [], ...extra });
const ok = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { assert.equal(value.ok, true, JSON.stringify(value)); return value as any; };

test('seven frozen v1 recipes have four to eight valid widgets and suggestions only', () => {
  for (const lens of Object.values(ADAPT_LENSES)) {
    assert.equal(lens.version, 1); assert.ok(Object.isFrozen(lens)); assert.ok(Object.isFrozen(lens.home.widgets));
    assert.ok(lens.home.widgets.length >= 4 && lens.home.widgets.length <= 8);
    assert.equal(lens.bots.length, 3); assert.equal(lens.templates.length, 2); assert.ok(lens.promoted.length <= 5);
    const adapted = ok(adaptFromRequirements(profile({ lens: lens.id }), DEFAULT_CONFIG));
    assert.ok(uiConfigSchema.safeParse(adapted.result).success); assert.deepEqual(checkAccessibility(adapted.result), []);
    assert.equal(adapted.result.dashboards[0].name, lens.label);
    const routes: Record<string, string> = { allBots: 'bots', tasks: 'tasks', routines: 'all/routines', usage: 'settings/usage', files: 'reports' };
    assert.deepEqual(lens.shortcuts.map(shortcut => shortcut.route), lens.promoted.slice(0, 2).map(id => routes[id]));
    assert.ok(!/[\u2013\u2014]/u.test(JSON.stringify(lens)));
  }
});

test('explicit lens wins, keyword weights are fixed, ties and weak matches ask one question', () => {
  assert.equal(selectLens(profile()).lens, 'sales');
  assert.equal(selectLens(profile({ role: 'Operations manager', goals: ['daily report and usage'], focus: ['routines', 'usage'], workflows: [] })).lens, 'operations');
  assert.equal(selectLens(profile({ role: 'Support team', goals: ['Response queue'], focus: ['tasks', 'chat', 'team'], workflows: [] })).lens, 'support');
  assert.equal(selectLens(profile({ lens: 'creator' })).lens, 'creator');
  const low = selectLens(profile({ role: 'General', goals: [], focus: [], workflows: [] }));
  assert.equal(low.lens, 'general'); assert.ok(low.question);
  const tied = selectLens(profile({ role: 'General', goals: [], focus: ['tasks'], workflows: [] }));
  assert.equal(tied.lens, 'general'); assert.ok(tied.question);
  assert.equal(selectLens(profile()).scores.sales, 13);
});

test('2,000 seeded profiles produce deterministic valid accessible patches without mutation', () => {
  let seed = 982451653; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const before = JSON.stringify(DEFAULT_CONFIG); let maximum = 0;
  for (let i = 0; i < 2000; i++) {
    const lens = LENS_IDS[Math.floor(random() * LENS_IDS.length)];
    const input = profile({ role: lens, lens: random() > .5 ? lens : undefined, focus: FOCUS_IDS.filter(() => random() > .5), goals: Array.from({ length: Math.floor(random() * 7) }, () => `${lens} work`), workflows: Array.from({ length: Math.floor(random() * 9) }, () => ({ name: `${lens} review`, cadence: 'daily' })) });
    if (input.lens === undefined) delete input.lens;
    const raw = JSON.stringify(input), start = performance.now();
    const first = ok(adaptFromRequirements(input, DEFAULT_CONFIG)); maximum = Math.max(maximum, performance.now() - start);
    assert.deepEqual(first.patch, ok(adaptFromRequirements(input, DEFAULT_CONFIG)).patch);
    const applied = ok(previewPatch(DEFAULT_CONFIG, first.patch, { ctx: {} }));
    assert.ok(uiConfigSchema.safeParse(applied.result).success); assert.deepEqual(checkAccessibility(applied.result), []);
    assert.ok(first.patch.every(op => /^\/(?:dashboards\/|layout\/(?:home|sidebar\/order|phoneTabs)$)/.test(op.path)), 'Adaptation only manages dashboard and navigation paths');
    for (const key of Object.keys(DEFAULT_CONFIG).filter(key => !['layout', 'dashboards'].includes(key))) assert.deepEqual(applied.result[key], DEFAULT_CONFIG[key]);
    assert.equal(JSON.stringify(input), raw);
  }
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  console.log(`Fuzz: 2000/2000 valid, deterministic and accessible; maximum observed ${maximum.toFixed(2)} ms`);
});

test('hand edits before and after adaptation survive and are reported as kept', () => {
  const first = ok(adaptFromRequirements(profile(), DEFAULT_CONFIG));
  const manual = structuredClone(first.result);
  manual.layout.home = { kind: 'tasks' };
  manual.dashboards[0].widgets[0].title = 'My own count';
  const second = ok(adaptFromRequirements(profile({ lens: 'operations' }), manual, first.state));
  assert.deepEqual(second.result.layout.home, { kind: 'tasks' });
  assert.equal(second.result.dashboards[0].widgets[0].title, 'My own count');
  assert.ok(second.kept.some(item => item.path === '/layout/home' && item.message.includes('kept as you set it')));
  assert.ok(!second.managedPaths.includes('/layout/home'));
  const third = ok(adaptFromRequirements(profile({ lens: 'support' }), second.result, second.state));
  assert.deepEqual(third.result.layout.home, { kind: 'tasks' });
  assert.equal(third.result.dashboards[0].widgets[0].title, 'My own count');
  const existing = structuredClone(DEFAULT_CONFIG); existing.layout.phoneTabs = ['search', 'bots', 'settings'];
  assert.deepEqual(ok(adaptFromRequirements(profile(), existing)).result.layout.phoneTabs, existing.layout.phoneTabs);
});

test('deleted and reordered managed dashboards are not replaced by index', () => {
  const first = ok(adaptFromRequirements(profile(), DEFAULT_CONFIG));
  const moved = structuredClone(first.result);
  moved.dashboards.unshift({ id: 'd_fixture1', name: 'Personal', icon: 'home', widgets: [] });
  const next = ok(adaptFromRequirements(profile({ lens: 'support' }), moved, first.state));
  assert.equal(next.result.dashboards[0].name, 'Personal'); assert.equal(next.result.dashboards[1].name, 'Support queue');
  const removed = structuredClone(first.result); removed.dashboards = []; removed.layout.home = { kind: 'default' }; removed.layout.phoneTabs = [...DEFAULT_CONFIG.layout.phoneTabs];
  const kept = ok(adaptFromRequirements(profile({ lens: 'operations' }), removed, first.state));
  assert.equal(kept.result.dashboards.length, 0); assert.ok(kept.kept.some(k => k.label === 'Home dashboard'));
});

test('no profile means no patch and no default changes', () => {
  const result = ok(adaptFromRequirements(null, DEFAULT_CONFIG)); assert.deepEqual(result.patch, []); assert.deepEqual(result.result, DEFAULT_CONFIG);
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


test('All sections cannot be hidden by a patch, while default arrangements stay valid', () => {
  assert.ok(uiConfigSchema.safeParse(DEFAULT_CONFIG).success);
  for (const lens of LENS_IDS) {
    const adapted = ok(adaptFromRequirements(profile({ lens }), DEFAULT_CONFIG));
    const result = previewPatch(adapted.result, [{ op: 'add', path: '/layout/sidebar/hidden/-', value: 'all' }], { ctx: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(error => error.code === 'required_item' && error.message.includes('All sections')));
  }
});


test('every lens promotes registered phone routes with immutable access to All sections', () => {
  for (const lens of LENS_IDS) {
    const result = ok(adaptFromRequirements(profile({ lens }), DEFAULT_CONFIG)).result;
    assert.ok(result.layout.phoneTabs.includes('more'));
    assert.ok(result.layout.phoneTabs.includes('settings'));
    const removed = previewPatch(result, [{ op: 'replace', path: '/layout/phoneTabs', value: result.layout.phoneTabs.filter(tab => tab !== 'more') }], { ctx: {} });
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.errors[0].code, 'required_item');
    const reset = ok(previewPatch(result, [{ op: 'replace', path: '/layout', value: DEFAULT_CONFIG.layout }], { ctx: {} }));
    assert.deepEqual(reset.result.layout, DEFAULT_CONFIG.layout);
  }
  assert.equal(ok(adaptFromRequirements(profile({ lens: 'operations' }), DEFAULT_CONFIG)).result.layout.phoneTabs[0], 'routines');
});
