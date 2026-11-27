import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { DEFAULT_CONFIG, previewPatch } from '../../../server/src/ui-config/index.js';
const manager = await tsImport('../../../web/src/dashboards/manager/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const agent = await tsImport('../../../web/src/dashboards/agent/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const { createdDashboard } = await tsImport('../../../web/src/dashboards/manager/preview.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const apply = (doc, ops) => { const result = previewPatch(doc, ops, { ctx: {} }); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
test('create and duplicate allocate new identities without mutating the original', () => {
  const first = apply(DEFAULT_CONFIG, manager.createDashboard('Operations'));
  const second = apply(first, manager.duplicateDashboard(first.dashboards[0], 'Sales pipeline'));
  assert.equal(first.dashboards.length, 1); assert.equal(second.dashboards.length, 2);
  assert.notEqual(first.dashboards[0].id, second.dashboards[1].id);
});
test('rename and reorder reject stale indexes and preserve dashboard identities', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('Operations'));
  doc = apply(doc, manager.createDashboard('Sales pipeline'));
  const id = doc.dashboards[0].id, ops = manager.renameDashboard(doc, id, 'Launch');
  const moved = apply(doc, manager.moveDashboard(doc, id, 1));
  assert.equal(moved.dashboards[1].id, id);
  assert.equal(previewPatch(moved, ops, { ctx: {} }).ok, false);
  assert.equal(apply(doc, ops).dashboards[0].name, 'Launch');
  assert.deepEqual(manager.moveDashboard(doc, id, -1), []);
});
test('delete clears home, pins, phone tabs and shortcut references atomically', () => {
  let doc = apply(DEFAULT_CONFIG, manager.createDashboard('Operations'));
  const id = doc.dashboards[0].id;
  doc.layout.home = { kind: 'dashboard', dashboardId: id }; doc.layout.pinned = [{ type: 'dashboard', id }]; doc.layout.phoneTabs = ['bots', `dashboard:${id}`, 'settings'];
  const result = apply(doc, manager.deleteDashboard(doc, id));
  assert.equal(result.dashboards.length, 0); assert.deepEqual(result.layout.home, { kind: 'default' }); assert.equal(result.layout.pinned.length, 0); assert.equal(result.layout.phoneTabs.length, 3);
});
test('agent update age never presents an old answer as freshly updated', () => {
  assert.equal(agent.updatedCaption(null), ''); assert.equal(agent.updatedCaption(0, 300000), 'Updated 5 min ago'); assert.equal(agent.updatedCaption(0, 3600000), 'Updated 1 hour ago'); assert.equal(agent.updatedCaption(0, 86400000), 'Updated 1 day ago');
});
test('action navigation rejects external URLs and malformed routes', () => {
  assert.deepEqual(agent.openActionScreen({ type: 'open', route: '#dashboards' }), { kind: 'dashboards' });
  for (const route of ['https://example.test', 'javascript:alert(1)', '//example.test', '#missing']) assert.equal(agent.openActionScreen({ type: 'open', route }), null);
  assert.equal(agent.widgetRoute('run', 'd_12345678', 'w_12345678'), '/api/ui/widgets/d_12345678/w_12345678/run');
});
test('preview links resolve the newly created dashboard using server id mapping', () => {
  assert.equal(createdDashboard({ idMap: { '$new1': 'd_12345678' }, result: { dashboards: [{ id: 'd_abcdefgh', name: 'Operations' }, { id: 'd_12345678', name: 'Sales pipeline' }] } }).name, 'Sales pipeline');
  assert.equal(createdDashboard(null), undefined);
});
