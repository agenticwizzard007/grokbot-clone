import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, agentWidgetOptionsSchema, agentWidgetResultSchema, dashboardSchema, previewPatch, WIDGET_TYPES, SOURCES } from '../../server/src/ui-config/index.js';
import { buildUiPatch, UI_SCHEMAS, createUiTools } from '../../server/src/agent/ui-tools.js';
import { MemoryUiConfigService } from '../../server/src/ui-config/memory-service.js';
const widget = { id: 'w_00000001', type: 'agent', span: 12, rows: 3, options: { prompt: 'Summarize open tasks', display: 'list', schedule: 'manual' } };
const dashboard = { id: 'd_00000001', name: 'Fixture dashboard', icon: 'layout-dashboard', widgets: [widget] };
const deps = { accentPair: () => ({ light: '#0F766E', dark: '#2DD4BF' }) };

test('agent options are strict, defaulted, plain text and secret scanned', () => {
  assert.ok(WIDGET_TYPES.includes('agent'));
  assert.deepEqual(agentWidgetOptionsSchema.parse({ prompt: 'Read tasks' }), { prompt: 'Read tasks', display: 'text', schedule: 'manual' });
  for (const prompt of ['', ' ', 'x'.repeat(401), '<b>Read</b>', 'bad\u2014copy', 'api_key=fixture-secret', 'sk-fixturesecret123']) assert.equal(agentWidgetOptionsSchema.safeParse({ prompt }).success, false);
  for (const options of [{ ...widget.options, sql: 'SELECT' }, { ...widget.options, schedule: 'minutely' }, { ...widget.options, display: 'html' }]) assert.equal(agentWidgetOptionsSchema.safeParse(options).success, false);
});
test('result union rejects HTML, unknown keys, secrets, long text and more than ten rows', () => {
  for (const doc of [{ kind: 'text', text: '<script>' }, { kind: 'text', text: 'x'.repeat(1201) }, { kind: 'text', text: 'password=fixture' }, { kind: 'stat', value: '1', label: 'Tasks', url: 'https://example.test' }, { kind: 'list', rows: Array.from({ length: 11 }, () => ({ title: 'Task' })) }]) assert.equal(agentWidgetResultSchema.safeParse(doc).success, false);
  for (const doc of [{ kind: 'text', text: 'Read a task' }, { kind: 'stat', value: '2', label: 'Tasks' }, { kind: 'list', rows: [{ title: 'Task', action: { type: 'send', botId: 'bot-fixture', text: 'Help with this' } }] }]) assert.ok(agentWidgetResultSchema.safeParse(doc).success);
});
test('dashboard max twelve agents and shared patch ownership', () => {
  assert.ok(dashboardSchema.safeParse(dashboard).success);
  assert.equal(dashboardSchema.safeParse({ ...dashboard, widgets: Array.from({ length: 13 }, (_, n) => ({ ...widget, id: `w_${String(n).padStart(8, '0')}` })) }).success, false);
  const patch: any = [{ op: 'add', path: '/dashboards/-', value: { ...dashboard, widgets: [{ ...widget, options: { ...widget.options, botId: 'foreign' } }] } }];
  const result = previewPatch(DEFAULT_CONFIG, patch, { ctx: { botIds: ['own'] } });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.errors[0].code, 'not_found');
});
test('all eight templates validate and only create a dashboard', () => {
  for (const template of ['blank', 'overview', 'tasks', 'usage', 'bot', 'needs_you', 'handoffs', 'pipeline']) {
    const built = buildUiPatch('create_dashboard', { template, name: 'Fixture', botId: 'own' }, DEFAULT_CONFIG, deps);
    const result = previewPatch(DEFAULT_CONFIG, built.patch, { ctx: { botIds: ['own'] } });
    assert.ok(result.ok, JSON.stringify(result)); if (result.ok) assert.deepEqual(result.result.layout, DEFAULT_CONFIG.layout);
  }
});
test('new source metadata has strict params, small fields and ten-row caps', () => {
  for (const id of ['handoffs.list','loops.list','outputs.recent','connectors.status','email.recent','calendar.upcoming','crm.deals']) {
    const source = SOURCES.find(s => s.id === id)!; assert.equal(source.maxRows, 10);
    assert.equal(source.paramsSchema.safeParse({ limit: 11 }).success, false);
    assert.equal(source.paramsSchema.safeParse({ userId: 'foreign' }).success, false);
    assert.doesNotMatch(source.fields.join(','), /secret|password|body|instructions/);
  }
});
test('dashboard management tools preview duplicate, reorder, rename and delete with distinct ids', async () => {
  const service = new MemoryUiConfigService(), ctx: any = { userId: 'fixture-a', botId: 'bot-fixture', depth: 0 };
  const tools = createUiTools({ ...deps, service, allowed: () => true, tainted: () => false, card() {} });
  const call = async (name: string, args: unknown) => JSON.parse(String((await tools.find(t => t.name === name)!.impl(args,ctx)).output));
  const apply = async (name: string, args: unknown) => { const p = await call(name,args); assert.ok(p.previewId,JSON.stringify(p)); assert.equal(p.applied,false); assert.ok(service.applyPreview(ctx.userId,p.previewId,'user').ok); };
  await apply('create_dashboard',{name:'Fixture',template:'pipeline'});
  const first = service.get(ctx.userId).doc.dashboards[0];
  await apply('duplicate_dashboard',{dashboardId:first.id,name:'Copy'});
  let dashboards = service.get(ctx.userId).doc.dashboards;
  assert.equal(dashboards.length,2); assert.notEqual(dashboards[0].widgets[0].id,dashboards[1].widgets[0].id);
  const copyId = dashboards[1].id;
  await apply('reorder_dashboards',{dashboardIds:[copyId,first.id]});
  assert.equal(service.get(ctx.userId).doc.dashboards[0].id,copyId);
  await apply('rename_dashboard',{dashboardId:copyId,name:'Renamed'});
  await apply('add_agent_widget',{dashboardId:copyId,prompt:'Summarize tasks'});
  dashboards = service.get(ctx.userId).doc.dashboards;
  assert.equal(dashboards[0].widgets.at(-1)?.type,'agent');
  assert.equal((await call('list_dashboards',{})).dashboards[0].name,'Renamed');
  await apply('delete_dashboard',{dashboardId:copyId}); assert.equal(service.get(ctx.userId).doc.dashboards.length,1);
  assert.equal(UI_SCHEMAS.reorder_dashboards.safeParse({dashboardIds:[first.id],foreign:1}).success,false);
});
