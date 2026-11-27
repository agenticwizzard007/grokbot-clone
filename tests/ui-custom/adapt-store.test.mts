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

test('only applying a preview claims its managed paths, including after process restart', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const pending = ok(store.preview('a', 1));
  assert.deepEqual(store.get('a').profile?.managedPaths, []); assert.equal(ui.get('a').revision, 0);
  assert.equal(ui.getPreview('b', pending.previewId), null); assert.equal(ui.applyPreview('b', pending.previewId, 'user').ok, false);
  ok(ui.applyPreview('a', pending.previewId, 'user'));
  const restart = new RequirementsStore(ui, { flag: () => '100' });
  assert.ok(restart.get('a').profile!.managedPaths.includes('/layout/home'));
  const manual = ok(ui.patch('a', [{ op: 'replace', path: '/layout/home', value: { kind: 'tasks' } }], 1, 'user'));
  ok(restart.update('a', patch('Operations'), 1));
  const next = ok(restart.preview('a', 2, 'user', 'operations'));
  assert.deepEqual(next.after.layout.home, manual.doc.layout.home); assert.ok(next.kept.some(k => k.path === '/layout/home'));
});

test('discard, supersede and expiry never take ownership or change appearance', t => {
  const { ui, store, advance } = fixture(t); ok(store.update('a', patch(), 0));
  const discarded = ok(store.preview('a', 1)); ui.discardPreview('a', discarded.previewId);
  assert.deepEqual(store.get('a').profile?.managedPaths, []);
  const old = ok(store.preview('a', 1)); const next = ok(store.preview('a', 1, 'user', 'operations'));
  assert.equal(ui.getPreview('a', old.previewId)?.status, 'superseded');
  advance(15 * 60000); assert.equal(ui.applyPreview('a', next.previewId, 'user').ok, false);
  assert.deepEqual(store.get('a').profile?.managedPaths, []); assert.equal(ui.get('a').revision, 0);
});

test('requirements history cannot enter appearance history or undo', t => {
  const { ui, store } = fixture(t);
  for (let n = 0; n < 3; n++) ok(store.update('a', patch(`Sales ${n}`), n));
  assert.deepEqual(ui.history('a'), []);
  ok(ui.patch('a', [{ op: 'replace', path: '/theme/mode', value: 'dark' }], 0, 'user'));
  ok(ui.undo('a', 1, 'user')); assert.equal(ui.get('a').doc.theme.mode, 'system'); assert.equal(store.get('a').profile?.role, 'Sales 2');
});

test('reset clears only requirements, previews defaults, and Undo restores both', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const adaptation = ok(store.preview('a', 1)); ok(ui.applyPreview('a', adaptation.previewId, 'user')); store.get('a');
  const before = ui.get('a').doc;
  const reset = ok(store.reset('a', 1)); assert.equal(store.get('a').profile, null); assert.deepEqual(ui.get('a').doc, before);
  ok(ui.applyPreview('a', reset.previewId, 'user')); assert.deepEqual(ui.get('a').doc.layout, DEFAULT_CONFIG.layout);
  assert.equal(store.undoReset('b', 0, reset.undoToken).ok, false);
  ok(store.undoReset('a', 2, reset.undoToken)); assert.equal(store.get('a').profile?.role, 'Sales'); assert.deepEqual(ui.get('a').doc, before);
  assert.equal(store.undoReset('a', 3, reset.undoToken).ok, false);
});

test('new requirements and subsequent appearance edits invalidate a reset Undo', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const reset = ok(store.reset('a', 1)); ok(ui.applyPreview('a', reset.previewId, 'user'));
  ok(ui.patch('a', [{ op: 'replace', path: '/theme/mode', value: 'dark' }], 1, 'user'));
  assert.equal(store.undoReset('a', 2, reset.undoToken).ok, false);
  ok(store.update('a', patch('Support'), 2)); assert.equal(store.undoReset('a', 3, reset.undoToken).ok, false);
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

test('adaptation preview warm p95 stays under 150 ms', t => {
  const { store } = fixture(t); ok(store.update('a', patch(), 0));
  const times: number[] = []; for (let i = 0; i < 100; i++) { const start = performance.now(); ok(store.preview('a', 1)); times.push(performance.now() - start); }
  times.sort((a, b) => a - b); console.log(`preview_adaptation p95: ${times[95].toFixed(2)} ms`); assert.ok(times[95] < 150);
});

test('a hand edit followed by a revert is never reclaimed by adaptation', t => {
  const { ui, store } = fixture(t); ok(store.update('a', patch(), 0));
  const first = ok(store.preview('a', 1)); ok(ui.applyPreview('a', first.previewId, 'user')); store.get('a');
  const order = ui.get('a').doc.layout.sidebar.order;
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/sidebar/order', value: [...order].reverse() }], 1, 'user'));
  ok(ui.patch('a', [{ op: 'replace', path: '/layout/sidebar/order', value: order }], 2, 'user'));
  const next = ok(store.preview('a', 1, 'user', 'operations'));
  assert.deepEqual(next.after.layout.sidebar.order, order);
  assert.ok(next.kept.some(k => k.path === '/layout/sidebar/order'));
});
