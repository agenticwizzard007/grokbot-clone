import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNote, parseInline, noteLink } from '../../web/src/dashboards/note-parser.js';
import { tsImport } from 'tsx/esm/api';
const { defaultWidget, widgetAction, columnSpan, sourceKey, widgetSource, findDashboard } = await tsImport('../../web/src/dashboards/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
import { DEFAULT_CONFIG, widgetSchema } from '../../server/src/ui-config/schema.js';
import { WIDGET_TYPES } from '../../server/src/ui-config/registry-widgets.js';
import { previewPatch } from '../../server/src/ui-config/patch.js';
import { checkAccessibility } from '../../server/src/ui-config/contrast.js';
const widgets = WIDGET_TYPES.map((type, index) => ({ ...defaultWidget(type), id: `w_${String(index).padStart(8, '0')}` }));
const dashboard = { id: 'd_00000000', name: 'Fixture dashboard', icon: 'layout-dashboard' as const, widgets };
const config = { ...structuredClone(DEFAULT_CONFIG), dashboards: [dashboard] };
const ctx = { ownsBot: () => false };
for (const widget of widgets) test(`${widget.type}: library defaults validate and have a working registered source`, () => {
  assert.equal(widgetSchema.safeParse(widget).success, true);
  const result = previewPatch(DEFAULT_CONFIG, [{ op: 'add', path: '/dashboards/-', value: { ...dashboard, id: '$new1', widgets: [{ ...widget, id: '$new2' }] } }], { ctx });
  assert.equal(result.ok, true, JSON.stringify(result));
});
test('all edit actions use guarded patches and enforce array and geometry boundaries', () => {
  for (const action of ['later', 'wider', 'taller', 'remove'] as const) {
    const ops = widgetAction(0, widgets, widgets[0].id, action); assert.equal(ops[0].op, 'test');
    const result = previewPatch(config, ops, { ctx }); assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) continue;
    if (action === 'later') assert.equal(result.result.dashboards[0].widgets[1].id, widgets[0].id);
    if (action === 'wider') assert.equal(result.result.dashboards[0].widgets[0].span, 5);
    if (action === 'taller') assert.equal(result.result.dashboards[0].widgets[0].rows, 2);
    if (action === 'remove') assert.equal(result.result.dashboards[0].widgets.length, widgets.length - 1);
  }
  for (const action of ['earlier', 'narrower', 'shorter'] as const) {
    const ops = widgetAction(0, widgets, widgets[2].id, action);
    assert.equal(previewPatch(config, ops, { ctx }).ok, true);
  }
  assert.deepEqual(widgetAction(0, widgets, widgets[0].id, 'earlier'), []);
  assert.deepEqual(widgetAction(0, widgets, widgets.at(-1)!.id, 'later'), []);
  assert.deepEqual(widgetAction(0, widgets, widgets[0].id, 'shorter'), []);
  assert.deepEqual(widgetAction(0, [{ ...widgets[0], span: 12 }], widgets[0].id, 'wider'), []);
  assert.deepEqual(widgetAction(0, [{ ...widgets[0], rows: 6 }], widgets[0].id, 'taller'), []);
});
test('stale widget indexes are rejected instead of editing the next widget', () => {
  const ops = widgetAction(0, widgets, widgets[0].id, 'wider');
  const changed = { ...config, dashboards: [{ ...dashboard, widgets: [...widgets].reverse() }] };
  assert.equal(previewPatch(changed, ops, { ctx }).ok, false);
});
test('responsive columns follow 12, 6 and 2 column rules for every span', () => {
  for (let span = 1; span <= 12; span++) {
    assert.equal(columnSpan(span, 1280), span); assert.equal(columnSpan(span, 768), Math.ceil(span / 2));
    assert.equal(columnSpan(span, 500), Math.ceil(span / 2)); assert.equal(columnSpan(span, 390), span <= 4 ? 1 : 2); assert.equal(columnSpan(span, 320), span <= 4 ? 1 : 2);
  }
});
test('source keys share equivalent queries and dashboard routes survive renaming', () => {
  const one = { ...widgets[1], source: { id: 'tasks.list' as const, params: { state: 'done', limit: 5 } } };
  assert.equal(sourceKey(one), sourceKey({ ...one, source: { ...one.source, params: { limit: 5, state: 'done' } } }));
  assert.equal(findDashboard([dashboard], 'old-name-d_00000000'), dashboard);
});
test('note parser produces only the fixed block and inline node set', () => {
  assert.deepEqual(parseNote('## Heading\n### Detail\nA **bold** and *italic* line.\n- One\n- Two\n1. First\n2. Next').map(node => node.kind), ['heading', 'heading', 'paragraph', 'list', 'list']);
  assert.deepEqual(parseInline('A **bold** *word*').map(node => node.kind), ['text', 'bold', 'text', 'italic']);
  assert.deepEqual(noteLink('https://example.test/report'), { href: 'https://example.test/report', domain: 'example.test' });
  assert.deepEqual(noteLink('dashboard:d_12345678'), { href: '#dash/d_12345678' });
});
test('note links reject script, data, protocol-relative, file and remote asset injection', () => {
  for (const target of ['javascript:alert(1)', 'data:text/html,x', '//example.test', 'http://example.test', 'file:///tmp/secret', 'https://', 'ask:bot:send']) assert.equal(noteLink(target), null);
  for (const payload of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[run](javascript:alert)', '![image](https://example.test/image.png)', '<iframe src=https://example.test>']) {
    const nodes = parseNote(payload); assert.ok(nodes.every(node => ['paragraph', 'heading', 'list'].includes(node.kind)));
    assert.doesNotMatch(JSON.stringify(nodes), /"kind":"(?:html|script|image|iframe)"/);
  }
  assert.equal(checkAccessibility(config).length, 0);
});

test('task board option scope and source scope share the same query and cache identity', () => {
  const widget = defaultWidget('taskBoard');
  const optionScope = { ...widget, options: { botId: 'fixture-bot' } };
  const sourceScope = { ...widget, source: { ...widget.source!, params: { ...widget.source!.params, botId: 'fixture-bot' } } };
  assert.deepEqual(widgetSource(optionScope), widgetSource(sourceScope));
  assert.equal(sourceKey(optionScope), sourceKey(sourceScope));
  assert.notEqual(sourceKey(widget), sourceKey(optionScope));
});
