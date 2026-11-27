import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_CONFIG, uiConfigSchema, previewPatch, LIMITS, REGISTRY, migrate, summarize,
  presetConfig, presetPatch, effectiveConfig, effectiveTokens, SEED_IDS, DERIVED_IDS,
  type UiConfig, type PatchOp, type PatchResult,
} from '../../../server/src/ui-config/index.ts';
export const dashboardPatch: PatchOp[] = JSON.parse(fs.readFileSync(new URL('./documents.json', import.meta.url), 'utf8')).dashboardPatch;
const clone = () => structuredClone(DEFAULT_CONFIG);
const patch = (ops: PatchOp[], current = clone(), autofix = false) => previewPatch(current, ops, { ctx: {}, autofix });
function good(result: PatchResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('Expected success'); return result; }
function bad(result: PatchResult, code?: string) { assert.equal(result.ok, false, JSON.stringify(result)); if (result.ok) throw new Error('Expected rejection'); assert.ok(result.errors.length); if (code) assert.ok(result.errors.some(e => e.code === code), JSON.stringify(result.errors)); return result.errors; }
function set(path: string, value: unknown): PatchOp { return { op: 'add', path, value }; }

// Schema acceptance and rejection are tested independently from the patch engine.
test('strict schema accepts defaults and normalizes hex colors', () => {
  const doc = clone(); doc.theme.colors.light.primary = '#0f766e';
  assert.equal(uiConfigSchema.parse(doc).theme.colors.light.primary, '#0F766E');
  assert.equal(uiConfigSchema.parse(DEFAULT_CONFIG).version, 1);
});
test('unknown keys are rejected at every object and registry boundary', () => {
  const paths = ['', '/theme', '/theme/colors', '/theme/colors/light', '/theme/overrides/dark', '/theme/font', '/layout', '/layout/sidebar', '/layout/home', '/layout/chat', '/components', '/keybindings', '/device', '/device/phone', '/policy'];
  for (const path of paths) {
    const doc: any = clone(); let parent = doc; for (const key of path.split('/').slice(1)) parent = parent[key]; parent.unregistered = 'value';
    assert.equal(uiConfigSchema.safeParse(doc).success, false, path);
  }
});
test('all color seeds and derived overrides reject CSS and non-hex input', () => {
  for (const group of ['colors', 'overrides'] as const) for (const id of group === 'colors' ? SEED_IDS : DERIVED_IDS) for (const value of ['red', 'rgb(0,0,0)', 'hsl(1,2%,3%)', '#FFF', '#12345678', 'url(https://example.test)', 'var(--x)', 'calc(1px)', '#123456;', '#123456\n']) {
    const doc: any = clone(); doc.theme[group].light[id] = value; assert.equal(uiConfigSchema.safeParse(doc).success, false, `${group}/${id}: ${value}`);
  }
});
test('every enum and numeric range stays closed', () => {
  const values: [string, unknown][] = [['/theme/mode', 'auto'], ['/theme/font/ui', 'remote'], ['/theme/font/heading', 'url'], ['/theme/font/scale', 0.9], ['/theme/density', 'tiny'], ['/theme/radius', 2], ['/theme/motion', 'always'], ['/theme/contrast', 'low'], ['/layout/sidebar/width', 100], ['/layout/sidebar/collapsed', 'yes'], ['/layout/chat/width', 500], ['/device/phone/scale', 'small'], ['/preset', 'custom-url']];
  for (const [path, value] of values) bad(patch([set(path, value)]));
  const doc = good(patch(dashboardPatch)).result;
  for (const [field, value] of [['span', 0], ['span', 13], ['span', 1.1], ['rows', 0], ['rows', 7], ['refreshSec', 10]] as const) bad(patch([set(`/dashboards/0/widgets/0/${field}`, value)], doc));
});
test('text rejects HTML control characters and forbidden dash characters', () => {
  const doc = good(patch(dashboardPatch)).result;
  for (const value of ['<script>', 'A>B', 'line\u0000', 'line\u0085', 'word\u2013word', 'word\u2014word']) {
    bad(patch([set('/dashboards/0/name', value)], doc)); bad(patch([set('/dashboards/0/widgets/0/title', value)], doc));
  }
  bad(patch([set('/dashboards/0/name', 'x'.repeat(41))], doc)); bad(patch([set('/dashboards/0/widgets/0/title', 'x'.repeat(61))], doc));
});
test('required navigation and shortcuts cannot be hidden removed or unbound', () => {
  bad(patch([set('/layout/sidebar/hidden', ['settings'])]), 'required_item');
  bad(patch([set('/layout/sidebar/order', ['tasks'])]), 'required_item');
  bad(patch([set('/layout/phoneTabs', ['bots', 'tasks', 'search'])]), 'required_item');
  bad(patch([set('/keybindings/settings', null)]), 'required_item');
  for (const tabs of [['bots', 'settings'], ['bots', 'tasks', 'search', 'settings', 'bots', 'tasks']]) bad(patch([set('/layout/phoneTabs', tabs)]));
  for (const id of ['composer', 'approval', 'back', 'settings', 'errors', 'previewBanner', 'safeMode']) bad(patch([set(`/components/${id}`, 'hide')]), 'unknown_path');
});
test('duplicate navigation pins and ids are rejected', () => {
  bad(patch([set('/layout/phoneTabs', ['settings', 'bots', 'bots'])]));
  const doc = good(patch(dashboardPatch)).result;
  bad(patch([set('/layout/pinned/-', doc.layout.pinned[0])], doc));
  bad(patch([set('/dashboards/-', doc.dashboards[0])], doc));
  bad(patch([set('/dashboards/0/widgets/-', doc.dashboards[0].widgets[0])], doc));
});
test('dangling home pinned tab and shortcut dashboard ids are rejected', () => {
  for (const [path, value] of [['/layout/home', { kind: 'dashboard', dashboardId: 'd_00000000' }], ['/layout/pinned', [{ type: 'dashboard', id: 'd_00000000' }]], ['/layout/phoneTabs', ['bots', 'settings', 'dashboard:d_00000000']]] as [string, unknown][]) bad(patch([set(path, value)]), 'not_found');
  const doc = good(patch(dashboardPatch)).result;
  bad(patch([set('/dashboards/0/widgets/-', { id: '$new1', type: 'shortcuts', span: 12, rows: 1, options: { items: [{ label: 'Missing', target: 'dashboard:d_00000000' }] } })], doc), 'not_found');
  const two = good(patch([...dashboardPatch, set('/dashboards/-', { id: '$new7', name: 'Second', icon: 'layout-dashboard', widgets: [] })])).result;
  bad(patch([set('/layout/phoneTabs', ['settings', ...two.dashboards.map(d => `dashboard:${d.id}`)])], two));
});
test('all widget types validate their own source options fields and source params', () => {
  const base = good(patch(dashboardPatch)).result;
  const widgets = [
    { type: 'table', source: { id: 'tasks.list', params: {} }, options: { columns: ['title', 'state'], limit: 5 } },
    { type: 'meter', source: { id: 'usage.windows', params: {} }, options: { window: 0 } },
    { type: 'botStatus', source: { id: 'bots.status', params: {} }, options: { limit: 12 } },
    { type: 'taskBoard', source: { id: 'tasks.list', params: {} }, options: {} },
    { type: 'routineSchedule', source: { id: 'routines.upcoming', params: { days: 7 } }, options: { days: 7 } },
    { type: 'note', options: { text: '## Note\n**Hello**\n[Example](https://example.test)' } },
    { type: 'shortcuts', options: { items: [{ label: 'Tasks', target: 'tasks' }, { label: 'Ask', target: 'ask:bot_qa:Summarize tasks' }] } },
  ];
  for (const widget of widgets) good(patch([set('/dashboards/0/widgets/-', { id: '$new1', span: 6, rows: 2, ...widget })], base));
  for (const [path, value] of [['/dashboards/0/widgets/0/options/field', 'prompt'], ['/dashboards/0/widgets/0/source/id', 'tasks.series'], ['/dashboards/0/widgets/0/options/css', 'none'], ['/dashboards/0/widgets/0/source/params/url', 'https://example.test'], ['/dashboards/0/widgets/0/source', null]] as [string, unknown][]) bad(patch([set(path, value)], base));
  for (const text of ['<img src=x>', '![image](https://example.test)', '[run](javascript:alert(1))', '[bad](http://example.test)', 'x'.repeat(2001)]) bad(patch([set('/dashboards/0/widgets/-', { id: '$new1', type: 'note', span: 6, rows: 1, options: { text } })], base));
});
test('component states only allow collapsed for the run log', () => {
  for (const c of REGISTRY.components) for (const value of c.allowed) good(patch([set(`/components/${c.id}`, value)]));
  bad(patch([set('/components/sidebar.usage', 'collapsed')]));
});
test('reserved keys conflicts default bindings and modifier order are checked', () => {
  for (const value of ['Mod+W', 'Mod+Shift+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+R', 'Mod+L', 'Mod+Alt+0', 'Alt+F4', 'F5', 'Tab', 'Escape', 'Enter', 'Space', 'K', 'Mod+Mod+K']) bad(patch([set('/keybindings/search', value)]));
  bad(patch([set('/keybindings/search', 'Mod+I')]));
  bad(patch([set('/keybindings/search', 'Shift+Alt+N')]));
  good(patch([set('/keybindings/focusComposer', 'Alt+J')]));
  good(patch([set('/keybindings/toggleSidebar', null), set('/keybindings/search', 'Mod+B')]));
});
test('limits cover dashboards widgets pins operations bytes and JSON depth', () => {
  const dashboard = (i: number) => ({ id: `d_${i.toString(36).padStart(8, '0')}`, name: 'Fixture', icon: 'layout-dashboard', widgets: [] });
  const doc: any = clone(); doc.dashboards = Array.from({ length: 13 }, (_, i) => dashboard(i)); assert.equal(uiConfigSchema.safeParse(doc).success, false);
  doc.dashboards = [dashboard(0)]; doc.dashboards[0].widgets = Array.from({ length: 25 }, (_, i) => ({ id: `w_${i.toString(36).padStart(8, '0')}`, type: 'note', span: 1, rows: 1, options: { text: 'Fixture' } })); assert.equal(uiConfigSchema.safeParse(doc).success, false);
  bad(patch([set('/layout/pinned', Array.from({ length: 9 }, (_, i) => ({ type: 'bot', id: `bot_${i}` })))]), 'limit_exceeded');
  bad(patch(Array.from({ length: 101 }, () => set('/theme/mode', 'dark'))), 'limit_exceeded');
  bad(patch([set('/theme/mode', 'x'.repeat(65536))]), 'limit_exceeded');
  let nested: unknown = 'x'; for (let i = 0; i < 13; i++) nested = [nested]; bad(patch([set('/theme/mode', nested)]), 'invalid_patch');
  doc.dashboards = Array.from({ length: 12 }, (_, i) => ({ ...dashboard(i), widgets: Array.from({ length: 24 }, (_, j) => ({ id: `w_${(i * 24 + j).toString(36).padStart(8, '0')}`, type: 'note', span: 1, rows: 1, options: { text: 'x'.repeat(2000) } })) }));
  assert.ok(JSON.stringify(doc).length > LIMITS.documentBytes); assert.equal(uiConfigSchema.safeParse(doc).success, false);
});
test('patch implements all five operations append and atomic test failures', () => {
  const base = clone(), snapshot = structuredClone(base);
  const result = good(patch([set('/theme/colors/light/primary', '#0F766E'), { op: 'replace', path: '/theme/mode', value: 'dark' }, { op: 'test', path: '/theme/mode', value: 'dark' }, { op: 'remove', path: '/theme/colors/light/primary' }, { op: 'move', from: '/layout/phoneTabs/0', path: '/layout/phoneTabs/1' }], base));
  assert.deepEqual(result.result.layout.phoneTabs, ['tasks', 'bots', 'search', 'settings']); assert.deepEqual(base, snapshot);
  bad(patch([set('/theme/mode', 'dark'), { op: 'test', path: '/theme/mode', value: 'light' }], base), 'invalid_patch'); assert.deepEqual(base, snapshot);
  good(patch([{ op: 'test', path: '/theme/font', value: { scale: 'default', heading: 'instrument', ui: 'inter' } }]));
});
test('unknown paths malformed pointers invalid indices and move parents return hints', () => {
  for (const path of ['/them/mode', '/theme/color', '/theme/colors/light/primari', '/components/composer', '/layout/phoneTabs/01', '/layout/phoneTabs/99', 'theme/mode', '/theme/~9', '/__proto__/polluted', '/constructor/prototype']) {
    const errors = bad(patch([set(path, 'dark')]), 'unknown_path'); assert.ok(errors[0].hint);
  }
  bad(patch([{ op: 'move', from: '/theme', path: '/theme/colors/light' }]), 'invalid_patch');
  bad(patch([{ op: 'remove', path: '/theme/colors/light/missing' }]), 'unknown_path');
  bad(patch([{ op: 'replace', path: '/theme/colors/light/primary', value: '#0F766E' }]), 'unknown_path');
  bad(patch([{ op: 'move', from: '/theme/colors/light/primary', path: '/theme/colors/dark/primary' }]), 'unknown_path');
  assert.equal(({} as any).polluted, undefined);
});
test('temporary ids are generated once and substituted across later references', () => {
  const result = good(patch([...dashboardPatch, set('/layout/home', { kind: 'dashboard', dashboardId: '$new1' }), set('/layout/phoneTabs', ['bots', 'settings', 'dashboard:$new1'])]));
  assert.match(result.idMap.$new1, /^d_[a-z0-9]{8}$/); assert.equal(Object.keys(result.idMap).length, 6);
  assert.equal(result.result.layout.pinned[0].id, result.idMap.$new1);
  assert.equal(result.result.layout.phoneTabs[2], `dashboard:${result.idMap.$new1}`);
  assert.equal(JSON.stringify(result.result).includes('$new'), false);
  const doc = result.result;
  bad(patch([set('/dashboards/0/id', 'd_00000000')], doc), 'invalid_value');
  bad(patch([{ op: 'replace', path: '/dashboards/0', value: { ...doc.dashboards[0], id: 'd_00000000' } }], doc), 'invalid_value');
  bad(patch([set('/layout/pinned/-', { type: 'dashboard', id: '$new99' })]), 'invalid_patch');
  bad(patch([...dashboardPatch, ...dashboardPatch]), 'invalid_patch');
});
test('Bot references are checked per user while missing Bot pins become warnings', () => {
  const result = good(previewPatch(clone(), [set('/layout/pinned/-', { type: 'bot', id: 'bot_other' })], { ctx: { botIds: ['bot_qa'] } }));
  assert.deepEqual(result.result.layout.pinned, []); assert.equal(result.warnings[0].code, 'not_found');
  const doc = good(patch(dashboardPatch)).result;
  bad(previewPatch(doc, [set('/dashboards/0/widgets/2/source/params/botId', 'bot_other')], { ctx: { botIds: ['bot_qa'] } }), 'not_found');
  good(previewPatch(doc, [set('/dashboards/0/widgets/2/source/params/botId', 'bot_qa')], { ctx: { botIds: ['bot_qa'] } }));
});
test('5000 deterministic random patches never throw or mutate input', () => {
  let state = 0x2a97; const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const current = clone(), original = JSON.stringify(current), start = performance.now();
  const paths = ['/theme/mode', '/theme/colors/light/primary', '/theme/font/scale', '/layout/home', '/layout/phoneTabs/-', '/policy/root', '/theme/~0x', '/__proto__/x', '/dashboards/-'];
  for (let i = 0; i < 5000; i++) {
    const value = [null, true, random(), 'x'.repeat(Math.floor(random() * 30)), { x: 'y' }, ['settings'], '#0F766E'][Math.floor(random() * 7)];
    const ops: any = [{ op: ['add', 'replace', 'remove', 'move', 'test', 'copy'][Math.floor(random() * 6)], path: paths[Math.floor(random() * paths.length)], value }];
    const result = previewPatch(current, ops, { ctx: {} });
    if (result.ok) assert.ok(uiConfigSchema.safeParse(result.result).success); else assert.ok(result.errors.every(e => typeof e.path === 'string' && typeof e.code === 'string'));
  }
  assert.equal(JSON.stringify(current), original); console.log(`Fuzz: 5000 patches, 0 exceptions, ${Math.round(performance.now() - start)} ms`);
});
test('non-JSON cyclic prototype and accessor inputs reject without invoking code', () => {
  const cycle: any = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('Do not invoke'); } });
  for (const value of [undefined, NaN, Infinity, 1n, Symbol('x'), () => 1, new Date(), cycle, getter, new Map(), JSON.parse('{"__proto__":{"polluted":true}}')]) bad(patch([set('/theme/mode', value)]), 'invalid_patch');
  bad(previewPatch(null as any, [] as any, { ctx: {} }));
});
test('all worked examples A to J have golden outcomes', () => {
  const a = good(patch([{ op: 'replace', path: '/theme/mode', value: 'dark' }, set('/theme/colors/dark/primary', '#2DD4BF'), set('/theme/colors/light/primary', '#0F766E')], clone(), true));
  assert.deepEqual(a.summary, ['Theme: System to Dark', 'Primary color: #3043AB to #0F766E', 'Primary color: #B5C1FF to #2DD4BF']);
  assert.deepEqual(good(patch([set('/theme/font/scale', 'large'), set('/theme/density', 'comfortable')])).summary, ['Text size: Default to Large', 'Density: Default to Comfortable']);
  assert.deepEqual(good(patch([set('/components/sidebar.usage', 'hide'), set('/components/chat.runLog', 'collapsed')])).summary, ['Hid Usage in the sidebar']);
  assert.deepEqual(good(patch([set('/layout/home', { kind: 'tasks' }), set('/layout/phoneTabs', ['tasks', 'bots', 'search', 'settings'])])).summary, ['Home: Tasks', 'Reordered phone tabs']);
  const e = good(patch(dashboardPatch)); assert.deepEqual(e.summary, ['Updated pinned items', 'Added dashboard My week with 5 widgets']);
  const f = good(patch([set('/dashboards/0/widgets/4/span', 12), set('/dashboards/0/widgets/-', { id: '$new1', type: 'routineSchedule', title: 'Next runs', span: 12, rows: 2, source: { id: 'routines.upcoming', params: { days: 7 } }, options: { days: 7 } })], e.result));
  assert.deepEqual(f.summary, ['Updated Cost by day in My week', 'Added Next runs to My week']);
  bad(patch([set('/theme/css', 'button{}')]), 'unknown_path'); bad(patch([set('/theme/font/url', 'https://example.test')]), 'unknown_path');
  bad(patch([set('/layout/sidebar/hidden', ['settings'])]), 'required_item');
  assert.ok(summarize(e.result, clone()).includes('Removes 1 dashboard'));
  assert.deepEqual(good(patch(presetPatch('calm'))).summary, ['Preset: Calm', 'Density: Default to Comfortable', 'Corners: Default to Round', 'Motion: System to Reduced']);
  const three = clone(); three.dashboards = [{ ...e.result.dashboards[0], widgets: e.result.dashboards[0].widgets.slice(0, 3) }];
  assert.deepEqual(summarize(clone(), three), ['Added dashboard My week with 3 widgets']);
});
test('summaries expose only registry labels names and titles', () => {
  const doc = good(patch(dashboardPatch)).result;
  const next = structuredClone(doc); next.dashboards[0].description = 'Private description'; next.dashboards[0].widgets.push({ id: 'w_00000000', type: 'note', title: 'Fixture note', span: 12, rows: 1, options: { text: 'Do not print note content' } });
  const text = summarize(doc, next).join('\n'); assert.ok(text.includes('Fixture note')); assert.ok(!text.includes('Private')); assert.ok(!text.includes('Do not print'));
});
test('preset data device overlay and explicit document values follow precedence', () => {
  for (const preset of REGISTRY.presets) assert.ok(uiConfigSchema.safeParse(presetConfig(preset.id)).success);
  const doc = presetConfig('forest'); doc.theme.colors.light.primary = '#3043AB'; doc.device = { phone: { density: 'compact', scale: 'xlarge' } };
  assert.equal(effectiveConfig(doc).theme.colors.light.primary, '#3043AB'); assert.equal(effectiveConfig(doc, true).theme.density, 'default'); assert.equal(effectiveConfig(doc, true).theme.font.scale, 'xlarge');
  assert.equal(effectiveTokens(presetConfig('paper'), 'light')['--font-stack'], 'Georgia, "Times New Roman", serif');
});
test('migration accepts v1 rejects future invalid missing and unsupported old versions without mutation', () => {
  const doc = clone(), copy = structuredClone(doc); assert.deepEqual(migrate(doc), { doc, migrated: false });
  for (const raw of [{ ...doc, version: 0 }, { ...doc, version: 2 }, { ...doc, version: undefined }, null, { ...doc, policy: { enforced: true } }]) assert.ok('error' in migrate(raw));
  assert.deepEqual(doc, copy);
  const future = migrate({ ...doc, version: 2 }); assert.ok('error' in future && future.error.includes('newer version'));
});
test('registries are complete and new code uses neither identity colors nor forbidden copy', () => {
  assert.equal(REGISTRY.widgets.length, 11); assert.equal(REGISTRY.sources.length, 21); assert.equal(REGISTRY.presets.length, 8);
  for (const group of ['tokens', 'fonts', 'components', 'nav', 'widgets', 'sources', 'shortcuts', 'presets'] as const) {
    assert.equal(new Set(REGISTRY[group].map(x => x.id)).size, REGISTRY[group].length); assert.ok(REGISTRY[group].every(x => x.label));
  }
  for (const token of REGISTRY.tokens) assert.ok(token.cssVars.every(v => !v.includes('--color-bot-')));
  for (const file of fs.readdirSync('server/src/ui-config')) {
    const text = fs.readFileSync(`server/src/ui-config/${file}`, 'utf8'); assert.ok(!/[\u2013\u2014]/.test(text)); assert.ok(!/from ['"](?:node:|fs|path|react)/.test(text));
  }
});
test('5000 hostile strings cycle through every color and enum field', () => {
  const fields = [
    ...(['light', 'dark'] as const).flatMap(mode => [...SEED_IDS.map(id => `/theme/colors/${mode}/${id}`), ...DERIVED_IDS.map(id => `/theme/overrides/${mode}/${id}`)]),
    '/theme/mode', '/theme/font/ui', '/theme/font/heading', '/theme/font/scale', '/theme/density', '/theme/radius', '/theme/motion', '/theme/contrast', '/layout/sidebar/width', '/layout/chat/width', '/device/phone/density', '/device/phone/scale', '/preset',
  ];
  let seed = 90817; const start = performance.now();
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const value = ['url(', 'var(', '<script>', 'rgb(', '#GG', 'font;', '\u0000'][i % 7] + seed.toString(36);
    bad(patch([set(fields[i % fields.length], value)]));
  }
  console.log(`String fuzz: 5000 inputs across ${fields.length} fields, 0 accepted, ${Math.round(performance.now() - start)} ms`);
});
