import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteUiConfigService } from '../../server/src/ui/service.js';
import { DEFAULT_CONFIG, type PatchOp } from '../../server/src/ui-config/index.js';

function fixture(t: any) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT); INSERT INTO bots VALUES('bot_a','a','Fixture Alpha'),('bot_b','b','Fixture Beta');");
  let now = 1_000_000, flag = 'on'; const events: any[] = [];
  const service = new SqliteUiConfigService(db, { clock: () => now, flag: () => flag, metrics: () => {}, emit: (userId, event) => events.push({ userId, ...event }) });
  t.after(() => db.close());
  return { db, service, events, advance: (ms: number) => { now += ms; }, flag: (value: string) => { flag = value; } };
}
const mode = (value: string): PatchOp[] => [{ op: 'replace', path: '/theme/mode', value }];
const success = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => { assert.equal(result.ok, true, JSON.stringify(result)); return result as any; };
const error = (result: any, code: string) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.errors[0].code, code, JSON.stringify(result)); };

test('SQLite lazy defaults and isolated compare-and-swap patches', t => {
  const { db, service } = fixture(t);
  assert.deepEqual(service.get('a').doc, DEFAULT_CONFIG); assert.equal(service.get('a').revision, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM ui_config').get() as any).n, 0);
  success(service.patch('a', mode('dark'), 0, 'user'));
  error(service.patch('a', mode('light'), 0, 'user'), 'stale_revision');
  assert.equal(service.get('a').doc.theme.mode, 'dark'); assert.equal(service.get('b').revision, 0);
});

test('previews create, supersede, discard, apply once and expire at 15 minutes', t => {
  const { service, advance, events } = fixture(t);
  const first = success(service.preview('a', mode('dark'), { intent: 'Dark theme', actor: 'agent:bot_a' }));
  assert.equal(service.getPreview('b', first.previewId), null);
  const second = success(service.preview('a', mode('light'), { intent: 'Light theme', actor: 'user' }));
  assert.equal(service.getPreview('a', first.previewId)?.status, 'superseded');
  error(service.applyPreview('a', first.previewId, 'user'), 'stale_preview');
  service.discardPreview('a', second.previewId); assert.equal(service.getPreview('a', second.previewId)?.status, 'discarded');
  const third = success(service.preview('a', mode('dark'), { intent: 'Dark theme', actor: 'user' }));
  success(service.applyPreview('a', third.previewId, 'user'));
  error(service.applyPreview('a', third.previewId, 'user'), 'stale_preview');
  const fourth = success(service.preview('a', mode('light'), { intent: 'Light theme', actor: 'user' }));
  advance(15 * 60_000 - 1); assert.equal(service.getPreview('a', fourth.previewId)?.status, 'pending');
  advance(1); error(service.applyPreview('a', fourth.previewId, 'user'), 'preview_expired');
  assert.ok(events.some(event => event.state === 'expired')); assert.ok(events.every(event => event.userId === 'a'));
  assert.equal(events.find(event => event.state === 'pending').botId, 'bot_a');
});

test('a saved patch invalidates preview base and cross-user operations are not_found', t => {
  const { service } = fixture(t);
  const preview = success(service.preview('a', mode('dark'), { intent: 'Dark theme', actor: 'user' }));
  error(service.applyPreview('b', preview.previewId, 'user'), 'not_found');
  service.discardPreview('b', preview.previewId); assert.equal(service.getPreview('a', preview.previewId)?.status, 'pending');
  success(service.patch('a', mode('light'), 0, 'user'));
  error(service.applyPreview('a', preview.previewId, 'user'), 'stale_preview');
  error(service.reset('b', 'dashboard', 'd_aaaaaaaa'), 'not_found');
  error(service.patch('b', [{ op: 'add', path: '/layout/pinned/-', value: { type: 'bot', id: 'bot_a' } }], 0, 'user'), 'not_found');
});

test('undo creates revisions, supports ten steps, and undo of undo restores the latest state', t => {
  const { service } = fixture(t);
  for (let i = 0; i < 12; i++) success(service.patch('a', mode(i < 2 ? 'dark' : i % 2 ? 'light' : 'system'), i, 'user'));
  const undone = success(service.undo('a', 10, 'user')); assert.equal(undone.revision, 13); assert.equal(undone.doc.theme.mode, 'dark');
  const redo = success(service.undo('a', 1, 'user')); assert.equal(redo.revision, 14); assert.equal(redo.doc.theme.mode, 'light');
  for (let i = 0; i < 10; i++) success(service.undo('a', 1, 'user'));
  error(service.undo('a', 11, 'user'), 'invalid_value');
  error(service.undo('b', 1, 'user'), 'not_found');
});

test('history stays at 50 and expires after 90 days without pruning another user', t => {
  const { service, advance } = fixture(t);
  success(service.patch('b', mode('light'), 0, 'user'));
  for (let i = 0; i < 55; i++) success(service.patch('a', mode(i % 2 ? 'light' : 'dark'), i, 'user'));
  assert.equal(service.history('a').length, 50); assert.equal(service.history('b').length, 2);
  error(service.restore('a', 0, 55), 'not_found');
  advance(90 * 86400_000 + 1); assert.equal(service.history('a').length, 0);
});

test('corrupt and future documents fall back without writes and remain repairable', t => {
  const { service, db } = fixture(t);
  success(service.patch('a', mode('dark'), 0, 'user'));
  for (const corrupt of ['{', JSON.stringify({ ...DEFAULT_CONFIG, version: 999 }), JSON.stringify({ ...DEFAULT_CONFIG, theme: {} })]) {
    db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(corrupt, 'a');
    assert.equal(service.get('a').status, 'invalid_stored'); assert.deepEqual(service.get('a').doc, DEFAULT_CONFIG);
    assert.equal((db.prepare('SELECT doc FROM ui_config WHERE user_id=?').get('a') as any).doc, corrupt);
    assert.equal(service.get('b').status ?? 'ready', 'ready');
  }
  const reset = success(service.reset('a', 'all')); success(service.applyPreview('a', reset.previewId, 'reset'));
  assert.equal(service.get('a').status, 'ready');
});

test('all reset scopes validate, keep dashboards for appearance and repair removed references', t => {
  const { service } = fixture(t);
  const preview = success(service.preview('a', [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'Fixture dashboard', icon: 'layout-dashboard', widgets: [] } },
    { op: 'replace', path: '/layout/home', value: { kind: 'dashboard', dashboardId: '$new1' } },
    { op: 'replace', path: '/layout/phoneTabs', value: ['bots', 'settings', 'dashboard:$new1'] }], { intent: 'Fixture dashboard', actor: 'user' }));
  success(service.applyPreview('a', preview.previewId, 'user'));
  const original = service.get('a').doc;
  for (const scope of ['theme', 'layout', 'components', 'appearance', 'dashboards', 'dashboard', 'all'] as const) {
    const result = success(service.reset('a', scope, original.dashboards[0].id));
    const doc = service.getPreview('a', result.previewId)!.result;
    assert.equal(doc.dashboards.length, ['all', 'dashboards', 'dashboard'].includes(scope) ? 0 : 1);
    if (['all', 'dashboards', 'dashboard', 'appearance', 'layout'].includes(scope)) assert.equal(doc.layout.home.kind, 'default');
    assert.ok(doc.layout.phoneTabs.length >= 3);
  }
});

test('export names replace bot references and import round trips, drops unknown bots with warnings', t => {
  const { service } = fixture(t);
  success(service.patch('a', [{ op: 'add', path: '/layout/pinned/-', value: { type: 'bot', id: 'bot_a' } }], 0, 'user'));
  const file = service.export('a'); assert.equal(file.layout.pinned[0].id, 'Fixture Alpha'); assert.ok(!JSON.stringify(file).includes('bot_a'));
  const preview = success(service.importPreview('a', file));
  assert.deepEqual(service.getPreview('a', preview.previewId)!.result, service.get('a').doc);
  const foreign = success(service.importPreview('b', file)); assert.equal(foreign.warnings[0].code, 'not_found');
  assert.equal(service.getPreview('b', foreign.previewId)!.result.layout.pinned.length, 0);
  error(service.importPreview('a', { ...file, secret: 'fixture' }), 'invalid_value');
  error(service.importPreview('a', { ...file, padding: 'x'.repeat(256 * 1024) }), 'limit_exceeded');
  assert.equal(service.get('a').revision, 1);
});

test('presets enforce user boundaries, cap 20, and disabled service refuses changes', t => {
  const { service, flag } = fixture(t);
  for (let i = 0; i < 20; i++) success(service.savePreset('a', `Fixture ${i}`));
  error(service.savePreset('a', 'Too many'), 'limit_exceeded');
  const id = service.presets('a')[0].id; assert.equal(service.deletePreset('b', id), false);
  assert.equal(service.presets('b').length, 0); assert.equal(service.deletePreset('a', id), true);
  flag('off'); assert.equal(service.enabled('a'), false); error(service.patch('a', mode('dark'), 0, 'user'), 'disabled');
  error(service.preview('a', mode('dark'), { intent: 'Dark theme', actor: 'user' }), 'disabled');
});

test('registered older versions migrate through the shared hook before preview, without saving', async t => {
  const { service } = fixture(t);
  const { migrations } = await import('../../server/src/ui-config/migrate.js');
  // v1 is the first published format. Inject a test-only predecessor transform.
  migrations[0] = raw => ({ ...(raw as object), version: 1 });
  try {
    const result = success(service.importPreview('a', { ...structuredClone(DEFAULT_CONFIG), version: 0 }));
    assert.equal(service.getPreview('a', result.previewId)?.result.version, 1);
    assert.equal(service.get('a').revision, 0);
  } finally { delete migrations[0]; }
});

test('import and replacement accept large valid documents while incoming patches remain capped', t => {
  const { service } = fixture(t), doc = structuredClone(DEFAULT_CONFIG);
  for (let d = 0; d < 3; d++) doc.dashboards.push({ id: `d_0000000${d}`, name: `Fixture ${d}`, icon: 'layout-dashboard', widgets: Array.from({ length: 20 }, (_, w) => ({
    id: `w_${String(d * 20 + w).padStart(8, '0')}`, type: 'note' as const, title: 'Fixture note', span: 12, rows: 2, options: { text: 'x'.repeat(1900) },
  })) });
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) > 64 * 1024);
  const preview = success(service.importPreview('a', doc)); success(service.applyPreview('a', preview.previewId, 'import'));
  assert.deepEqual(service.get('a').doc, doc);
  const reset = success(service.reset('a', 'appearance')); success(service.applyPreview('a', reset.previewId, 'reset'));
  assert.equal(service.get('a').doc.dashboards.length, 3);
  success(service.undo('a', 1, 'user'));
  error(service.patch('a', [{ op: 'replace', path: '', value: doc }], 3, 'user'), 'limit_exceeded');
});

test('an unavailable imported bot cannot conceal malformed widget content', t => {
  const { service } = fixture(t), doc = structuredClone(DEFAULT_CONFIG);
  doc.dashboards.push({ id: 'd_aaaaaaaa', name: 'Fixture', icon: 'layout-dashboard', widgets: [{
    id: 'w_aaaaaaaa', type: 'stat', title: '<script>', span: 4, rows: 1,
    source: { id: 'tasks.counts', params: { botId: 'Foreign fixture' } }, options: { field: 'total' },
  }] });
  error(service.importPreview('a', doc), 'invalid_value');
});

test('portable bot filters and shortcuts round trip; missing bots remove their widgets visibly', t => {
  const { service } = fixture(t), doc = structuredClone(DEFAULT_CONFIG);
  doc.dashboards.push({ id: 'd_aaaaaaaa', name: 'Fixture bots', icon: 'layout-dashboard', widgets: [
    { id: 'w_aaaaaaaa', type: 'stat', span: 4, rows: 1, source: { id: 'tasks.counts', params: { botId: 'bot_a' } }, options: { field: 'total' } },
    { id: 'w_bbbbbbbb', type: 'shortcuts', span: 8, rows: 1, options: { items: [{ label: 'Open fixture', target: 'bot:bot_a' }, { label: 'Ask fixture', target: 'ask:bot_a:Fixture question' }] } },
  ] });
  success(service.replace('a', doc, 0)); const exported = service.export('a');
  assert.ok(!JSON.stringify(exported).includes('bot_a'));
  const own = success(service.importPreview('a', exported)); assert.deepEqual(service.getPreview('a', own.previewId)!.result, doc);
  const foreign = success(service.importPreview('b', exported)); assert.ok(foreign.warnings.length >= 2);
  assert.deepEqual(service.getPreview('b', foreign.previewId)!.result.dashboards[0].widgets, []);
});
