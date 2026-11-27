import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { DEFAULT_CONFIG, LIMITS, type UiConfigService, type MemoryServiceOptions, type PreviewResult, type ApplyResult, type PatchOp, type ResetScope } from '../../../server/src/ui-config/index.ts';
const dashboardPatch = JSON.parse(fs.readFileSync(new URL('./documents.json', import.meta.url), 'utf8')).dashboardPatch as PatchOp[];
const theme = (mode: string): PatchOp[] => [{ op: 'replace', path: '/theme/mode', value: mode }];
const userA = 'QA-Temp-a', userB = 'QA-Temp-b';
function preview(result: PreviewResult) { assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) throw Error('Expected preview'); return result; }
function applied(result: ApplyResult) { assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) throw Error('Expected apply'); return result; }
function rejected(result: ApplyResult | PreviewResult, code: string) { assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some(e => e.code === code), JSON.stringify(result.errors)); }
/** UC-B supplies an adapter factory with a fresh database and injected clock for each case. */
export function serviceContract(name: string, create: (options?: MemoryServiceOptions) => UiConfigService) {
  test(`${name}: defaults are lazy per-user defensive copies`, () => {
    const s = create(), first = s.get(userA); assert.equal(first.revision, 0); assert.deepEqual(first.doc, DEFAULT_CONFIG);
    first.doc.theme.mode = 'dark'; assert.deepEqual(s.get(userA).doc, DEFAULT_CONFIG); assert.deepEqual(s.get(userB).doc, DEFAULT_CONFIG); assert.equal(s.agentApplyMode(userA), 'ask'); assert.equal(s.enabled(userA), true);
  });
  test(`${name}: preview leaves saved config alone then applies exactly once`, () => {
    const s = create(), p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    assert.equal(p.applied, false); assert.equal(p.baseRevision, 0); assert.equal(s.get(userA).revision, 0);
    const stored = s.getPreview(userA, p.previewId)!; assert.equal(stored.status, 'pending'); assert.equal(stored.result.theme.mode, 'dark');
    assert.equal(stored.expiresAt - stored.createdAt, LIMITS.previewTtlMs);
    const result = applied(s.applyPreview(userA, p.previewId, 'user')); assert.equal(result.revision, 1); assert.equal(result.doc.theme.mode, 'dark'); assert.equal(s.getPreview(userA, p.previewId)!.status, 'applied');
    rejected(s.applyPreview(userA, p.previewId, 'user'), 'stale_preview'); assert.equal(s.get(userA).revision, 1);
  });
  test(`${name}: get and stored previews never share mutable references`, () => {
    const s = create(), p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    p.summary.push('Mutation'); const stored = s.getPreview(userA, p.previewId)!; stored.result.theme.mode = 'light'; stored.summary.push('Mutation');
    assert.equal(s.getPreview(userA, p.previewId)!.result.theme.mode, 'dark'); assert.ok(!s.getPreview(userA, p.previewId)!.summary.includes('Mutation'));
    const result = applied(s.applyPreview(userA, p.previewId, 'user')); result.doc.theme.mode = 'light'; assert.equal(s.get(userA).doc.theme.mode, 'dark');
  });
  test(`${name}: preview ids results discard and apply are isolated between users`, () => {
    const s = create(), p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    assert.equal(s.getPreview(userB, p.previewId), null); rejected(s.applyPreview(userB, p.previewId, 'user'), 'not_found'); s.discardPreview(userB, p.previewId);
    assert.equal(s.getPreview(userA, p.previewId)!.status, 'pending'); applied(s.applyPreview(userA, p.previewId, 'user')); assert.deepEqual(s.get(userB), { doc: DEFAULT_CONFIG, revision: 0 });
    rejected(s.undo(userB, 1, 'user'), 'not_found');
  });
  test(`${name}: valid newer preview supersedes only the same user's pending preview`, () => {
    const s = create(), a = preview(s.preview(userA, theme('dark'), { intent: 'First', actor: 'user' })), b = preview(s.preview(userB, theme('dark'), { intent: 'Other', actor: 'user' }));
    rejected(s.preview(userA, theme('invalid'), { intent: 'Invalid', actor: 'user' }), 'invalid_value'); assert.equal(s.getPreview(userA, a.previewId)!.status, 'pending');
    const next = preview(s.preview(userA, theme('light'), { intent: 'Second', actor: 'user' })); assert.equal(s.getPreview(userA, a.previewId)!.status, 'superseded'); assert.equal(s.getPreview(userB, b.previewId)!.status, 'pending');
    rejected(s.applyPreview(userA, a.previewId, 'user'), 'stale_preview'); applied(s.applyPreview(userA, next.previewId, 'user'));
  });
  test(`${name}: discard is idempotent and never applies a saved preview`, () => {
    const s = create(), p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    s.discardPreview(userA, p.previewId); s.discardPreview(userA, p.previewId); assert.equal(s.getPreview(userA, p.previewId)!.status, 'discarded'); rejected(s.applyPreview(userA, p.previewId, 'user'), 'stale_preview'); assert.equal(s.get(userA).revision, 0);
  });
  test(`${name}: expiry happens exactly at 15 minutes using the injected clock`, () => {
    let now = 1000; const s = create({ now: () => now }); const p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    now += LIMITS.previewTtlMs - 1; assert.equal(s.getPreview(userA, p.previewId)!.status, 'pending'); now++; assert.equal(s.getPreview(userA, p.previewId)!.status, 'expired'); rejected(s.applyPreview(userA, p.previewId, 'user'), 'preview_expired'); assert.equal(s.get(userA).revision, 0);
  });
  test(`${name}: patch If-Match admits one writer and rejects stale previews`, () => {
    const s = create(), p = preview(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }));
    assert.equal(applied(s.patch(userA, theme('light'), 0, 'user')).revision, 1); rejected(s.patch(userA, theme('dark'), 0, 'user'), 'stale_revision'); rejected(s.applyPreview(userA, p.previewId, 'user'), 'stale_preview'); assert.equal(s.get(userA).doc.theme.mode, 'light');
  });
  test(`${name}: failed patches and previews do not change revision`, () => {
    const s = create(); rejected(s.patch(userA, [{ op: 'add', path: '/layout/sidebar/hidden', value: ['settings'] }], 0, 'user'), 'required_item');
    rejected(s.preview(userA, theme('dark'), { intent: '<bad>', actor: 'user' }), 'invalid_value');
    rejected(s.patch(userA, [{ op: 'add', path: '/theme/colors/light/primary', value: '#FFFFFF' }], 0, 'user'), 'accessibility'); assert.equal(s.get(userA).revision, 0);
  });
  test(`${name}: autofix preview stores exactly the passing result it applies`, () => {
    const s = create(), p = preview(s.preview(userA, [{ op: 'add', path: '/theme/colors/light/primary', value: '#FFFFFF' }], { intent: 'Readable accent', actor: 'user', autofix: true }));
    assert.ok(p.warnings.length); const stored = s.getPreview(userA, p.previewId)!; assert.notEqual(stored.result.theme.colors.light.primary, '#FFFFFF'); assert.deepEqual(applied(s.applyPreview(userA, p.previewId, 'user')).doc, stored.result);
  });
  test(`${name}: generated dashboard ids remain stable from preview through apply`, () => {
    const s = create(), p = preview(s.preview(userA, dashboardPatch, { intent: 'My week', actor: 'user' })); const stored = s.getPreview(userA, p.previewId)!;
    assert.equal(stored.result.layout.pinned[0].id, p.idMap.$new1); assert.deepEqual(applied(s.applyPreview(userA, p.previewId, 'user')).doc, stored.result);
  });
  test(`${name}: undo restores ten revisions and undoing the undo redoes the change`, () => {
    const s = create();
    for (let i = 0; i < 10; i++) applied(s.patch(userA, theme(i % 2 ? 'light' : 'dark'), i, 'user'));
    const last = s.get(userA); const undo = applied(s.undo(userA, 10, 'user')); assert.equal(undo.revision, 11); assert.deepEqual(undo.doc, DEFAULT_CONFIG);
    assert.deepEqual(applied(s.undo(userA, 1, 'user')).doc, last.doc);
    for (const steps of [0, 11, .5, NaN]) rejected(s.undo(userA, steps, 'user'), 'invalid_value');
  });
  test(`${name}: reset appearance preserves dashboards and all reset reports removal counts`, () => {
    const s = create(); applied(s.patch(userA, [...theme('dark'), ...dashboardPatch], 0, 'user'));
    const appearance = preview(s.reset(userA, 'appearance')); assert.ok(appearance.summary.includes('Removes 0 dashboards')); const doc = applied(s.applyPreview(userA, appearance.previewId, 'user')).doc;
    assert.equal(doc.dashboards.length, 1); assert.deepEqual(doc.theme, DEFAULT_CONFIG.theme);
    const all = preview(s.reset(userA, 'all')); assert.ok(all.summary.includes('Removes 1 dashboard')); assert.deepEqual(applied(s.applyPreview(userA, all.previewId, 'user')).doc, DEFAULT_CONFIG);
  });
  test(`${name}: dashboard reset repairs home pins and phone tabs atomically`, () => {
    const s = create(); applied(s.patch(userA, [...dashboardPatch, { op: 'replace', path: '/layout/home', value: { kind: 'dashboard', dashboardId: '$new1' } }, { op: 'replace', path: '/layout/phoneTabs', value: ['bots', 'settings', 'dashboard:$new1'] }], 0, 'user'));
    rejected(s.reset(userB, 'dashboard', s.get(userA).doc.dashboards[0].id), 'not_found');
    const p = preview(s.reset(userA, 'dashboard', s.get(userA).doc.dashboards[0].id)), doc = applied(s.applyPreview(userA, p.previewId, 'user')).doc;
    assert.equal(doc.dashboards.length, 0); assert.equal(doc.layout.home.kind, 'default'); assert.equal(doc.layout.pinned.length, 0); assert.equal(doc.layout.phoneTabs.length, 3); assert.ok(doc.layout.phoneTabs.includes('settings'));
  });
  test(`${name}: individual reset scopes preserve unrelated customization`, () => {
    for (const scope of ['theme', 'layout', 'components', 'dashboards'] as ResetScope[]) {
      const s = create(); applied(s.patch(userA, [...theme('dark'), ...dashboardPatch, { op: 'add', path: '/components/sidebar.usage', value: 'hide' }, { op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 0, 'user'));
      const p = preview(s.reset(userA, scope)), doc = applied(s.applyPreview(userA, p.previewId, 'user')).doc;
      assert.equal(doc.theme.mode, scope === 'theme' ? 'system' : 'dark'); assert.equal(doc.dashboards.length, scope === 'dashboards' ? 0 : 1);
      assert.deepEqual(doc.components, scope === 'components' ? {} : { 'sidebar.usage': 'hide' }); assert.equal(doc.layout.home.kind, scope === 'layout' ? 'default' : 'tasks');
    }
  });
  test(`${name}: disabled service rejects writes and keeps saved state untouched`, () => {
    const s = create({ enabled: false }); assert.equal(s.enabled(userA), false); rejected(s.patch(userA, theme('dark'), 0, 'user'), 'disabled'); rejected(s.preview(userA, theme('dark'), { intent: 'Dark theme', actor: 'user' }), 'disabled'); rejected(s.applyPreview(userA, 'missing', 'user'), 'disabled'); rejected(s.undo(userA, 1, 'user'), 'disabled'); rejected(s.reset(userA, 'all'), 'disabled'); assert.equal(s.get(userA).revision, 0);
  });
}
