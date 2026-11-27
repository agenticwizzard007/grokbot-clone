import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { DEFAULT_CONFIG, previewPatch, type UiConfig, type PatchOp } from '../../server/src/ui-config/index.js';
import { WIDGETS } from '../../server/src/ui-config/registry-widgets.js';
import { buildUiPatch } from '../../server/src/agent/ui-tools.js';
import { suggestDashboardFromRequirements } from '../../server/src/ui-config/adapt.js';
const { defaultWidget, widgetLabel } = await tsImport('../../web/src/dashboards/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const manager = await tsImport('../../web/src/dashboards/manager/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const apply = (doc: UiConfig, patch: PatchOp[]) => { const result = previewPatch(doc, patch, { ctx: {} }); assert.ok(result.ok, JSON.stringify(result)); return result.result; };
const build = (name, args, doc) => buildUiPatch(name, args, doc, { accentPair: () => ({ light: '#3043AB', dark: '#B5C1FF' }) }).patch;

test('create_dashboard gives repeated defaults unique server names', () => {
  let doc = structuredClone(DEFAULT_CONFIG);
  for (let i = 0; i < 4; i++) doc = apply(doc, build('create_dashboard', { name: 'My week' }, doc));
  assert.deepEqual(doc.dashboards.map(d => d.name), ['My week', 'My week 2', 'My week 3', 'My week 4']);
});
test('duplicate_dashboard never repeats a name or changes its source', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('My week'));
  for (let i = 0; i < 3; i++) doc = apply(doc, build('duplicate_dashboard', { dashboardId: doc.dashboards[0].id }, doc));
  assert.equal(new Set(doc.dashboards.map(d => d.name)).size, 4); assert.equal(doc.dashboards[0].name, 'My week');
});
test('manager creation and suggestions share uniqueness, including case and length', () => {
  const long = 'Weekly launch planning and customer calls'.slice(0, 40);
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard(long));
  doc = apply(doc, manager.createDashboard(long.toUpperCase()));
  assert.notEqual(doc.dashboards[0].name.toLowerCase(), doc.dashboards[1].name.toLowerCase());
  assert.ok(doc.dashboards.every(d => d.name.length <= 40));
  const proposal = suggestDashboardFromRequirements({ version: 1, role: 'My week', goals: [], workflows: [], focus: [], updatedAt: 0, revision: 0, updatedBy: 'user', managedPaths: [] });
  assert.ok(proposal.ok); doc = apply(doc, proposal.patch); doc = apply(doc, proposal.patch);
  assert.deepEqual(doc.dashboards.slice(2).map(d => d.name), ['My week', 'My week 2']);
});
test('one patch resolves multiple collisions deterministically without rewriting existing names', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('My week'));
  const old = structuredClone(doc.dashboards[0]);
  doc = apply(doc, [{ op: 'add', path: '/dashboards/-', value: { ...old, id: '$new1' } }, { op: 'add', path: '/dashboards/-', value: { ...old, id: '$new2' } }]);
  assert.deepEqual(doc.dashboards[0], old); assert.deepEqual(doc.dashboards.map(d => d.name), ['My week', 'My week 2', 'My week 3']);
});
const generic = new Set(WIDGETS.flatMap(w => [w.id.toLowerCase(), w.label.toLowerCase()]));
for (const type of WIDGETS) for (const source of type.sources.length ? type.sources : [undefined]) test(`${type.id}/${source ?? 'static'}: rendered title describes its data or prompt`, () => {
  const base = defaultWidget(type.id);
  const widget = { ...base, ...(source ? { source: { id: source, params: {} } } : {}) };
  for (const title of [undefined, '', type.label, type.id]) {
    const label = widgetLabel({ ...widget, title });
    assert.ok(label.trim()); assert.ok(!generic.has(label.toLowerCase()), `Generic title: ${label}`);
  }
  assert.ok(base.title && !generic.has(base.title.toLowerCase()), `Library title: ${base.title}`);
});
test('server tools persist contextual titles and agent prompt titles', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('My week'));
  for (const type of WIDGETS) {
    doc = apply(doc, build('add_widget', { dashboardId: doc.dashboards[0].id, type: type.id }, doc));
    const widget = doc.dashboards[0].widgets.at(-1)!;
    assert.ok(widget.title && !generic.has(widget.title.toLowerCase()), `${type.id}: missing contextual title`);
  }
  doc = apply(doc, build('add_agent_widget', { dashboardId: doc.dashboards[0].id, prompt: 'Show my tasks that have been open for more than 2 days', display: 'list', schedule: 'manual' }, doc));
  assert.match(doc.dashboards[0].widgets.at(-1)!.title!, /tasks|open/i);
});
test('normalization never accepts invalid input or rewrites unrelated legacy data', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('My week'));
  doc.dashboards[0].widgets = [{ ...defaultWidget('table'), id: 'w_12345678', title: 'Table' }];
  assert.deepEqual(apply(doc, [{ op: 'replace', path: '/theme/mode', value: 'dark' }]).dashboards, doc.dashboards);
  assert.equal(previewPatch(doc, [{ op: 'add', path: '/dashboards/0/widgets/-', value: { ...defaultWidget('list'), id: '$new1', title: '<script>' } }], { ctx: {} }).ok, false);
});
