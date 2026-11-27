import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFixture } from './agent-fixture.mjs';
import { proposeChatWidgetEdit } from './e2e/suggest-dashboard-ui.mjs';
import { adaptFromRequirements } from '../../server/src/ui-config/adapt.js';
import { DEFAULT_CONFIG } from '../../server/src/ui-config/schema.js';

test('requirements dashboards support persistent widget edits through chat and the mock provider', { timeout: 120_000 }, async t => {
  const fixture = await agentFixture(); t.after(() => fixture.close());
  const proposal = adaptFromRequirements({ version: 1, role: 'Sales', goals: ['Follow ups and pipeline'],
    workflows: [{ name: 'Pipeline review', cadence: 'weekly' }], focus: ['tasks', 'routines', 'bots'],
    updatedAt: 1, revision: 1, updatedBy: 'user', managedPaths: [] }, DEFAULT_CONFIG);
  assert.ok(proposal.ok, JSON.stringify(proposal));
  const preview = await fixture.request('POST', '/ui/patches/preview', { patch: proposal.patch, intent: 'Add dashboard: Sales' }, 0);
  assert.equal(preview.status, 200, JSON.stringify(preview));
  const applied = await fixture.request('POST', `/ui/previews/${preview.body.previewId}/apply`, {}, 0);
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const dashboardId = applied.body.doc.dashboards[0].id;
  const firstList = applied.body.doc.dashboards[0].widgets.find(widget => widget.type === 'list');
  let addedId: string;
  const applyChat = async (tool: string, args: unknown, message: string) => {
    const proposed = await proposeChatWidgetEdit(fixture, tool, args, message);
    const saved = await fixture.request('POST', `/ui/previews/${proposed.previewId}/apply`, {}, proposed.beforeRevision);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const reread = await fixture.request('GET', '/ui/config');
    assert.deepEqual(reread.body.doc, saved.body.doc, 'Applied edits persist in the service');
    assert.ok(reread.body.doc.dashboards.every(dashboard => dashboard.id === dashboardId));
    assert.ok(reread.body.doc.dashboards[0].widgets.some(widget => widget.source?.id === 'tasks.list'));
    return reread.body.doc.dashboards[0];
  };
  await t.test('registered widgets read seeded data and return honest empty results', async () => {
    const result = await fixture.request('POST', '/ui/data', { requests: [
      { key: 'tasks', source: 'tasks.list', params: { limit: 10 } },
      { key: 'routines', source: 'routines.upcoming', params: { days: 7 } },
    ] });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.results.tasks.ok, true); assert.equal(result.body.results.tasks.count, 2);
    assert.equal(result.body.results.routines.ok, true); assert.equal(result.body.results.routines.count, 0);
    assert.deepEqual(result.body.results.routines.rows, []);
  });
  await t.test('resize an existing widget by chat', async () => {
    const dashboard = await applyChat('update_widget', { dashboardId, widgetId: firstList.id, set: { span: 12 } }, 'Make the follow ups widget full width.');
    assert.equal(dashboard.widgets.find(widget => widget.id === firstList.id).span, 12);
  });
  await t.test('add a data widget by chat', async () => {
    const dashboard = await applyChat('add_widget', { dashboardId, type: 'stat', title: 'Working tasks',
      source: { id: 'tasks.counts', params: {} }, options: { field: 'working' }, span: 6, rows: 1 }, 'Add a count of working tasks.');
    assert.equal(dashboard.widgets.length, 6);
    const added = dashboard.widgets.find(widget => widget.title === 'Working tasks'); assert.ok(added); addedId = added.id;
  });
  await t.test('reorder a widget by chat', async () => {
    const dashboard = await applyChat('move_widget', { dashboardId, widgetId: addedId, after: 'start' }, 'Move the working task count first.');
    assert.equal(dashboard.widgets[0].id, addedId);
  });
  await t.test('remove a widget by chat', async () => {
    const dashboard = await applyChat('remove_widget', { dashboardId, widgetId: addedId }, 'Remove the working task count.');
    assert.equal(dashboard.widgets.length, 5); assert.ok(!dashboard.widgets.some(widget => widget.id === addedId));
    assert.equal(dashboard.widgets.find(widget => widget.id === firstList.id).span, 12);
  });
});
