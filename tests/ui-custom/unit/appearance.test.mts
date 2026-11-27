import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, previewPatch, type UiConfig } from '../../../server/src/ui-config/index.ts';
registerHooks({ resolve(specifier, context, next) { return specifier.startsWith('@shared/') ? next(pathToFileURL(`${process.cwd()}/server/src/${specifier.slice(8)}.ts`).href, context) : next(specifier, context); } });
const builders = await import('../../../web/src/components/config/appearance/patches.ts');
const fixtures = JSON.parse(fs.readFileSync('tests/ui-custom/fixtures/parity.json', 'utf8'));
const ctx = { generateId: (kind: string) => `${kind === 'dashboard' ? 'd' : 'w'}_12345678` };
for (const fixture of fixtures.cases) test(`manual and agent parity: ${fixture.id}`, () => {
  const base = structuredClone(fixture.base ?? DEFAULT_CONFIG);
  const actual = fixture.builder === 'setValue' ? builders.setValue(fixture.path, fixture.value)
    : fixture.builder === 'setAccent' ? builders.setAccent(fixture.mode, fixture.value)
    : fixture.builder === 'choosePreset' ? builders.choosePreset(fixture.value)
    : fixture.builder === 'sidebarVisibility' ? builders.sidebarVisibility(base, fixture.idValue, fixture.value)
    : fixture.builder === 'moveSidebar' ? builders.moveSidebar(base, fixture.from, fixture.direction)
    : fixture.builder === 'createDashboard' ? builders.createDashboard(fixture.value)
    : builders.renameDashboard(base, fixture.idValue, fixture.value);
  assert.deepEqual(actual, fixture.patch);
  const manual = previewPatch(base, actual, { ctx });
  const agent = previewPatch(base, fixture.patch, { ctx });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  assert.deepEqual(manual, agent);
});
test('deleting a referenced dashboard clears every reference and repairs minimum phone tabs', () => {
  const doc: UiConfig = structuredClone(DEFAULT_CONFIG), id = 'd_12345678';
  doc.dashboards = [
    { id, name: 'QA-Temp-Board', icon: 'layout-dashboard', widgets: [] },
    { id: 'd_abcdefgh', name: 'QA-Temp-Links', icon: 'layout-dashboard', widgets: [
      { id: 'w_abcdefgh', type: 'shortcuts', span: 4, rows: 1, options: { items: [{ label: 'Open', target: `dashboard:${id}` }] } },
      { id: 'w_12345678', type: 'shortcuts', span: 4, rows: 1, options: { items: [{ label: 'Open', target: `dashboard:${id}` }, { label: 'Tasks', target: 'tasks' }] } },
    ] },
  ];
  doc.layout.home = { kind: 'dashboard', dashboardId: id };
  doc.layout.phoneTabs = ['bots', `dashboard:${id}`, 'settings'];
  doc.layout.pinned = [{ type: 'dashboard', id }];
  const result = previewPatch(doc, builders.deleteDashboard(doc, id), { ctx });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.result.layout.home, { kind: 'default' });
  assert.deepEqual(result.result.layout.phoneTabs, ['bots', 'tasks', 'settings']);
  assert.deepEqual(result.result.layout.pinned, []);
  assert.equal(result.result.dashboards[0].widgets.length, 1);
  assert.deepEqual(result.result.dashboards[0].widgets[0].options.items, [{ label: 'Tasks', target: 'tasks' }]);
  assert.equal(doc.dashboards.length, 2, 'input remains unchanged');
});
test('dashboard identity guard prevents renaming a different dashboard after reorder', () => {
  const doc = structuredClone(DEFAULT_CONFIG);
  doc.dashboards = [{ id: 'd_12345678', name: 'QA-Temp-Board', icon: 'layout-dashboard', widgets: [] }];
  const patch = builders.renameDashboard(doc, 'd_12345678', 'QA-Temp-Renamed');
  doc.dashboards[0].id = 'd_abcdefgh';
  assert.equal(previewPatch(doc, patch, { ctx }).ok, false);
});
test('keyboard recorder handles OS modifiers and physical letter keys', () => {
  assert.equal(builders.recordedShortcut({ key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }), 'Alt+J');
  assert.equal(builders.recordedShortcut({ key: 'K', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), 'Mod+Shift+K');
  assert.equal(builders.recordedShortcut({ key: 'Alt', code: 'AltLeft', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }), null);
});
test('low contrast and unsafe values are rejected without changing the document', () => {
  const base = JSON.stringify(DEFAULT_CONFIG);
  for (const color of ['#FFFFFF', 'red', 'url(https://example.test)', '#00000000']) assert.equal(previewPatch(DEFAULT_CONFIG, builders.setAccent('light', color), { ctx }).ok, false);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), base);
});
test('owned UI source uses plain copy and no unsafe HTML or truncation', () => {
  const files = ['web/src/components/config/AppearanceSettings.tsx', 'web/src/components/cards/UiPreviewCard.tsx', ...fs.readdirSync('web/src/components/config/appearance').map(f => `web/src/components/config/appearance/${f}`), 'web/src/styles/appearance.css'];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /[\u2013\u2014]|dangerouslySetInnerHTML|text-overflow:\s*ellipsis|line-clamp/, file);
});
test('phone selects swap existing tabs without duplicates or removing Settings', () => {
  const patch = builders.phoneTabPatch(DEFAULT_CONFIG, 0, 'tasks');
  assert.deepEqual(patch, [{ op: 'add', path: '/layout/phoneTabs', value: ['tasks', 'bots', 'search', 'settings'] }]);
  assert.equal(previewPatch(DEFAULT_CONFIG, patch, { ctx }).ok, true);
  assert.deepEqual(builders.phoneTabPatch(DEFAULT_CONFIG, 3, 'bots'), []);
});
