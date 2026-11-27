import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteUiConfigService } from '../../server/src/ui/service.js';
import { RequirementsStore } from '../../server/src/ui/requirements-store.js';
import { initUiDatabase } from '../../server/src/ui/db.js';
import { uiAdaptEnabled } from '../../server/src/ui/flags.js';
import { DEFAULT_CONFIG } from '../../server/src/ui-config/schema.js';

function fixture(t: any) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT); INSERT INTO bots VALUES('bot_a','a','Fixture Alpha'),('bot_b','b','Fixture Beta');");
  let now = 1_000_000, flag = '100';
  const ui = new SqliteUiConfigService(db, { clock: () => now, flag: () => 'on', metrics: () => {} });
  const store = new RequirementsStore(ui, { clock: () => now, flag: () => flag });
  t.after(() => db.close()); return { db, ui, store, advance: (ms: number) => { now += ms; }, flag: (value: string) => { flag = value; } };
}
const patch = (role = 'Sales') => [{ op: 'replace', path: '/role', value: role }, { op: 'replace', path: '/goals', value: ['Outreach and pipeline'] }, { op: 'replace', path: '/focus', value: ['tasks', 'routines', 'bots'] }];
const ok = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => { assert.equal(value.ok, true, JSON.stringify(value)); return value as any; };

test('requirements are lazy, isolated, versioned and do not change appearance on update', t => {
  const { db, ui, store } = fixture(t);
  assert.equal(store.get('a').profile, null); assert.equal(store.get('a').revision, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM ui_requirements').get() as any).n, 0);
  const saved = ok(store.update('a', patch(), 0)); assert.equal(saved.profile.role, 'Sales'); assert.equal(saved.revision, 1);
  assert.match(saved.remember, /^I will remember: Sales/); assert.equal(ui.get('a').revision, 0); assert.deepEqual(ui.get('a').doc, DEFAULT_CONFIG);
  assert.equal(store.get('b').profile, null); assert.equal(store.update('a', patch('Operations'), 0).ok, false);
  assert.equal((db.prepare("SELECT count(*) n FROM ui_config_history WHERE user_id='a' AND kind='requirements'").get() as any).n, 1);
});

test('different profiles keep identical navigation and home; Apply only appends a dashboard', t => {
  const { ui, store } = fixture(t);
  ok(store.update('a', patch('Sales'), 0)); ok(store.update('b', patch('Operations'), 0));
  assert.deepEqual(ui.get('a'), ui.get('b'));
  const before = ui.get('a');
  const pending = ok(store.preview('a', 1));
  assert.equal(pending.title, 'Add dashboard: Sales'); assert.deepEqual(ui.get('a'), before);
  assert.equal(ui.getPreview('b', pending.previewId), null); assert.equal(ui.applyPreview('b', pending.previewId, 'user').ok, false);
  const applied = ok(ui.applyPreview('a', pending.previewId, 'user'));
  assert.equal(applied.doc.dashboards.length, 1); assert.deepEqual({ ...applied.doc, dashboards: before.doc.dashboards }, before.doc);
  const restart = new RequirementsStore(ui, { flag: () => '100' });
  assert.deepEqual(restart.get('a').profile!.managedPaths, []);
  ok(restart.update('a', patch('Support'), restart.get('a').revision));
  assert.deepEqual(ui.get('a').doc, applied.doc);
  const next = ok(restart.preview('a', restart.get('a').revision));
  const second = ok(ui.applyPreview('a', next.previewId, 'user'));
  assert.equal(second.doc.dashboards.length, 2); assert.deepEqual(second.doc.dashboards[0], applied.doc.dashboards[0]);
  assert.deepEqual(second.doc.layout, ui.get('b').doc.layout);
});

test('discard, supersede and expiry never take ownership or change appearance', t => {
  const { ui, store, advance } = fixture(t); ok(store.update('a', patch(), 0));
  const discarded = ok(store.preview('a', 1)); ui.discardPreview('a', discarded.previewId);
  assert.deepEqual(store.get('a').profile?.managedPaths, []);
  const old = ok(store.preview('a', 1)); const next = ok(store.preview('a', 1));
  assert.equal(ui.getPreview('a', old.previewId)?.status, 'superseded');
  advance(15 * 60000); assert.equal(ui.applyPreview('a', next.previewId, 'user').ok, false);
  assert.deepEqual(store.get('a').profile?.managedPaths, []); assert.equal(ui.get('a').revision, 0);
});

test('requirements history cannot enter appearance history or undo', t => {
  const { ui, store } = fixture(t);
  for (let n = 0; n < 3; n++) ok(store.update('a', patch(`Sales ${n}`), n));
  assert.deepEqual(ui.history('a'), []);
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 0, 'user'));
  ok(ui.undo('a', 1, 'user')); assert.deepEqual(ui.get('a').doc.layout.home, { kind: 'default' }); assert.equal(store.get('a').profile?.role, 'Sales 2');
});

test('reset and Undo only change the profile, preserving manual layout and dashboards', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const adaptation = ok(store.preview('a', 1)); ok(ui.applyPreview('a', adaptation.previewId, 'user')); store.get('a');
  const before = ui.get('a').doc;
  const reset = ok(store.reset('a', store.get('a').revision)); assert.equal(store.get('a').profile, null); assert.deepEqual(ui.get('a').doc, before);
  assert.ok(!('previewId' in reset)); assert.deepEqual(ui.get('a').doc, before);
  assert.equal(store.undoReset('b', 0, reset.undoToken).ok, false);
  ok(store.undoReset('a', store.get('a').revision, reset.undoToken)); assert.equal(store.get('a').profile?.role, 'Sales'); assert.deepEqual(ui.get('a').doc, before);
  assert.equal(store.undoReset('a', 3, reset.undoToken).ok, false);
});

test('Undo reset preserves subsequent hand edits; later profile saves invalidate Undo', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const reset = ok(store.reset('a', 1));
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 0, 'user'));
  ok(store.undoReset('a', 2, reset.undoToken));
  assert.deepEqual(ui.get('a').doc.layout.home, { kind: 'tasks' });
  const resetAgain = ok(store.reset('a', 3));
  ok(store.update('a', patch('Support'), 4)); assert.equal(store.undoReset('a', 5, resetAgain.undoToken).ok, false);
});

test('history cap, account deletion and corrupt profile fallback are isolated', t => {
  const { db, store } = fixture(t);
  ok(store.update('b', patch('Operations'), 0));
  for (let n = 0; n < 55; n++) ok(store.update('a', patch(`Sales ${n}`), n));
  assert.equal((db.prepare("SELECT count(*) n FROM ui_config_history WHERE user_id='a' AND kind='requirements'").get() as any).n, 50);
  db.prepare('UPDATE ui_requirements SET doc=? WHERE user_id=?').run('{', 'a');
  assert.equal(store.get('a').status, 'invalid_stored'); assert.equal(store.get('b').profile?.role, 'Operations');
  db.prepare('DELETE FROM users WHERE id=?').run('a');
  assert.equal(store.get('a').profile, null); assert.equal(store.get('b').profile?.role, 'Operations');
  assert.equal((db.prepare("SELECT count(*) n FROM ui_config_history WHERE user_id='a'").get() as any).n, 0);
});

test('staged rollout is deterministic, off by default, with explicit account override', t => {
  const { db, store, flag } = fixture(t);
  flag('off'); assert.equal(store.enabled('a'), false); assert.equal(store.update('a', patch(), 0).ok, false);
  assert.equal(uiAdaptEnabled(db, 'a', 'staff', 'a,b'), true); assert.equal(uiAdaptEnabled(db, 'a', 'staff', 'b'), false);
  assert.equal(uiAdaptEnabled(db, 'a', undefined), false);
  let count = 0; for (let n = 0; n < 1000; n++) { const id = `fixture${n}`; const value = uiAdaptEnabled(db, id, '10'); assert.equal(value, uiAdaptEnabled(db, id, '10')); count += Number(value); }
  assert.ok(count >= 70 && count <= 130, String(count));
  db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_adapt) VALUES(?,?,?)').run('a', 1, 1);
  assert.equal(store.enabled('a'), true);
  db.prepare('UPDATE account_preferences SET ui_adapt=0 WHERE user_id=?').run('a'); flag('100'); assert.equal(store.enabled('a'), false);
});

test('existing history migration preserves rows and independent revision namespaces', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'); CREATE TABLE ui_config_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,doc TEXT NOT NULL,summary TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,revision)); INSERT INTO ui_config_history VALUES('fixture','a',1,'{}','[]','user',1)");
  initUiDatabase(db); initUiDatabase(db);
  assert.equal((db.prepare('SELECT kind FROM ui_config_history WHERE user_id=?').get('a') as any).kind, 'config');
  db.prepare("INSERT INTO ui_config_history VALUES('requirements','a',1,'null','[]','user',1,'requirements')").run();
  assert.equal((db.prepare('SELECT count(*) n FROM ui_config_history WHERE user_id=?').get('a') as any).n, 2);
});

test('dashboard suggestion preview warm p95 stays under 150 ms', t => {
  const { store } = fixture(t); ok(store.update('a', patch(), 0));
  const times: number[] = []; for (let i = 0; i < 100; i++) { const start = performance.now(); ok(store.preview('a', 1)); times.push(performance.now() - start); }
  times.sort((a, b) => a - b); console.log(`Dashboard suggestion p95: ${times[95].toFixed(2)} ms`); assert.ok(times[95] < 150);
});

test('backup and tenant export include only the owning account requirements and audit', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { exportTenantDatabase } = await import('../../server/src/platform/migration.js');
  const { db, store } = fixture(t); ok(store.update('a', patch('Sales'), 0)); ok(store.update('b', patch('Operations'), 0));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-export-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'source.db'), destination = path.join(root, 'account.db'); await db.backup(snapshot);
  await exportTenantDatabase(snapshot, destination, 'a', 'fixture_volume');
  const exported = new Database(destination); t.after(() => exported.close());
  assert.deepEqual(exported.prepare('SELECT user_id FROM ui_requirements').all(), [{ user_id: 'a' }]);
  assert.deepEqual(exported.prepare("SELECT user_id FROM ui_config_history WHERE kind='requirements'").all(), [{ user_id: 'a' }]);
  assert.equal(JSON.parse((exported.prepare('SELECT doc FROM ui_requirements').get() as any).doc).role, 'Sales');
});

test('failed requirements history persistence rolls back the entire profile write', t => {
  const { db, store, ui } = fixture(t);
  db.exec("CREATE TRIGGER fail_fixture_requirements BEFORE INSERT ON ui_config_history WHEN NEW.kind='requirements' AND NEW.user_id='a' BEGIN SELECT RAISE(ABORT,'Fixture history failure'); END");
  assert.throws(() => store.update('a', patch(), 0), /Fixture history failure/);
  assert.equal(store.get('a').revision, 0); assert.equal(store.get('a').profile, null); assert.equal(ui.get('a').revision, 0);
});



test('migration restores only owned matching layout pointers and is idempotent across startup', t => {
  const { db, ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const suggested = ok(store.preview('a', 1)); const applied = ok(ui.applyPreview('a', suggested.previewId, 'user'));
  const doc = structuredClone(applied.doc);
  doc.layout.home = { kind: 'dashboard', dashboardId: doc.dashboards[0].id };
  doc.layout.sidebar.order = [...doc.layout.sidebar.order].reverse();
  doc.layout.sidebar.hidden = ['files']; doc.layout.phoneTabs = ['tasks', 'routines', 'more', 'settings'];
  doc.layout.sidebar.width = 'wide'; doc.layout.pinned = [{ type: 'dashboard', id: doc.dashboards[0].id }];
  const written = ok(ui.patch('a', [{ op: 'replace', path: '/layout', value: doc.layout }], applied.revision, 'user'));
  const profile = { ...store.get('a').profile, managedPaths: ['/layout/sidebar/order', '/layout/sidebar/hidden', '/layout/phoneTabs', '/layout/home', '/layout/sidebar/width', '/layout/pinned'] };
  db.prepare('UPDATE ui_requirements SET doc=?,adaptation=? WHERE user_id=?').run(JSON.stringify(profile), JSON.stringify({ state: { doc, managedPaths: profile.managedPaths }, seenRevision: written.revision }), 'a');
  // The user changed home by hand after adaptation; it must survive.
  const manual = ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], written.revision, 'user'));
  const other = ui.get('b');
  initUiDatabase(db);
  const migrated = ui.get('a');
  assert.deepEqual(migrated.doc, { ...manual.doc, layout: { ...manual.doc.layout, sidebar: { ...manual.doc.layout.sidebar, order: DEFAULT_CONFIG.layout.sidebar.order, hidden: [] }, phoneTabs: DEFAULT_CONFIG.layout.phoneTabs } });
  assert.equal(migrated.revision, manual.revision + 1); assert.equal(migrated.updatedBy, 'migration');
  assert.deepEqual(ui.get('b'), other); assert.deepEqual(store.get('a').profile!.managedPaths, []);
  initUiDatabase(db); assert.deepEqual(ui.get('a'), migrated);
  assert.deepEqual(JSON.parse(ui.store.revision('a', manual.revision)!.doc), manual.doc);
});

test('migration preserves profiles without managedPaths, corrupt ledgers and unrelated settings', t => {
  const { db, ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const manual = ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }, { op: 'replace', path: '/layout/phoneTabs', value: ['files', 'more', 'settings'] }], 0, 'user'));
  const profile = store.get('a');
  db.prepare('UPDATE ui_requirements SET adaptation=? WHERE user_id=?').run(JSON.stringify({ state: { doc: manual.doc } }), 'a');
  initUiDatabase(db); assert.deepEqual(ui.get('a').doc, manual.doc); assert.deepEqual(store.get('a'), profile);
  db.prepare('UPDATE ui_requirements SET adaptation=? WHERE user_id=?').run('{', 'a');
  initUiDatabase(db); assert.deepEqual(ui.get('a').doc, manual.doc);
});

test('migration preserves an owned value edited away and back by hand', t => {
  const { db, ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const written = ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 0, 'user'));
  const profile = { ...store.get('a').profile, managedPaths: ['/layout/home'] };
  db.prepare('UPDATE ui_requirements SET doc=?,adaptation=? WHERE user_id=?').run(JSON.stringify(profile), JSON.stringify({ state: { doc: written.doc }, seenRevision: written.revision }), 'a');
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'bots' } }], 1, 'user'));
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 2, 'user'));
  const manual = ui.get('a'); initUiDatabase(db); assert.deepEqual(ui.get('a'), manual);
});

test('migration retires pending UC-I layout previews before they can be applied', t => {
  const { db, ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const pending = ok(ui.preview('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], { actor: 'user', intent: 'Old layout proposal' }));
  db.prepare('UPDATE ui_requirements SET adaptation=? WHERE user_id=?').run(JSON.stringify({ pending: [{ id: pending.previewId, state: { doc: DEFAULT_CONFIG } }] }), 'a');
  initUiDatabase(db); assert.equal(ui.getPreview('a', pending.previewId)!.status, 'superseded');
  assert.equal(ui.applyPreview('a', pending.previewId, 'user').ok, false); assert.deepEqual(ui.get('a').doc, DEFAULT_CONFIG);
});
