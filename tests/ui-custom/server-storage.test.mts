import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initUiDatabase, initUiPreferences } from '../../server/src/ui/db.js';
import { uiEnabled, uiAgentApplyMode } from '../../server/src/ui/flags.js';
import { createUiMetrics } from '../../server/src/ui/metrics.js';
import { UiStore } from '../../server/src/ui/store.js';
import { DEFAULT_CONFIG } from '../../server/src/ui-config/index.js';
import { exportTenantDatabase } from '../../server/src/platform/migration.js';
import { inventoryLegacySource } from '../../server/src/platform/migration-inventory.js';

const tables = ['ui_config', 'ui_config_history', 'ui_previews', 'ui_user_presets'];
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('usr_aaaaaaaa'),('usr_bbbbbbbb'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT);");
  initUiDatabase(db); initUiPreferences(db); return db;
}

test('additive schema initializes twice, creates no user records and defaults to ask', t => {
  const db = fixture(); t.after(() => db.close()); initUiDatabase(db); initUiPreferences(db);
  for (const table of tables) assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n, 0);
  assert.equal(uiAgentApplyMode(db, 'usr_aaaaaaaa'), 'ask');
});

test('deployment flag and independent account overrides support dark launch and account rollback', t => {
  const db = fixture(); t.after(() => db.close());
  assert.equal(uiEnabled(db, 'usr_aaaaaaaa', 'off'), false);
  assert.equal(uiEnabled(db, 'usr_aaaaaaaa', 'on'), true);
  db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,ui_agent_apply,updated_at) VALUES(?,?,?,?)').run('usr_aaaaaaaa', 1, 'auto', 1);
  assert.equal(uiEnabled(db, 'usr_aaaaaaaa', 'off'), true);
  assert.equal(uiEnabled(db, 'usr_bbbbbbbb', 'off'), false);
  assert.equal(uiAgentApplyMode(db, 'usr_aaaaaaaa'), 'auto');
  assert.equal(uiAgentApplyMode(db, 'usr_bbbbbbbb'), 'ask');
  db.prepare('UPDATE account_preferences SET ui_custom_enabled=0 WHERE user_id=?').run('usr_aaaaaaaa');
  assert.equal(uiEnabled(db, 'usr_aaaaaaaa', 'on'), false);
});

test('all new data statements contain a user_id predicate or binding', () => {
  for (const file of fs.readdirSync('server/src/ui').filter(file => file.endsWith('.ts'))) {
    const code = fs.readFileSync(`server/src/ui/${file}`, 'utf8');
    for (const match of code.matchAll(/\.prepare\((['"`])([\s\S]*?)\1\)/g)) {
      if (/\bui_(config|config_history|previews|user_presets)\b/.test(match[2])) assert.match(match[2], /\buser_id\b/, `${file}: ${match[2]}`);
    }
  }
});

test('metrics only contain finite counts and closed labels', () => {
  const events: unknown[] = [], metric = createUiMetrics(event => events.push(event));
  metric('ui_patch_rejected', 1, 'private fixture text'); metric('ui_config_bytes', 256); metric('ui_undo', NaN);
  metric('ui_agent_apply_mode', 1, 'auto');
  assert.deepEqual(events, [{ metric: 'ui_patch_rejected', value: 1 }, { metric: 'ui_config_bytes', value: 256 }, { metric: 'ui_agent_apply_mode', value: 1, label: 'auto' }]);
});

test('backup restore and tenant export preserve only owned customization rows', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-storage-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = fixture(); t.after(() => db.close()); const store = new UiStore(db);
  for (const userId of ['usr_aaaaaaaa', 'usr_bbbbbbbb']) {
    store.write(userId, DEFAULT_CONFIG, 1, 'user', Date.now());
    store.record(userId, 1, JSON.stringify(DEFAULT_CONFIG), ['Fixture'], 'user', Date.now());
    store.addPreset(userId, 'Fixture preset', DEFAULT_CONFIG, Date.now());
    store.addPreview(userId, { id: `preview-${userId}`, userId, baseRevision: 1, patch: [], result: DEFAULT_CONFIG,
      summary: [], warnings: [], idMap: {}, intent: 'Fixture preview', actor: 'user', status: 'pending', createdAt: 1, expiresAt: 900001 });
  }
  const snapshot = path.join(root, 'backup.db'); await db.backup(snapshot);
  const restored = new Database(snapshot); restored.pragma('journal_mode=DELETE');
  for (const table of tables) assert.equal((restored.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n, 2);
  restored.close();
  const inventory = await inventoryLegacySource({ tenant: 'usr_aaaaaaaa', sourceSnapshot: snapshot }); assert.ok(inventory);
  const destination = path.join(root, 'tenant.db'); await exportTenantDatabase(snapshot, destination, 'usr_aaaaaaaa', 'fixture_volume');
  const tenant = new Database(destination); t.after(() => tenant.close());
  for (const table of tables) assert.deepEqual(tenant.prepare(`SELECT user_id FROM ${table}`).all(), [{ user_id: 'usr_aaaaaaaa' }]);
  db.prepare('DELETE FROM users WHERE id=?').run('usr_aaaaaaaa');
  for (const table of tables) assert.deepEqual(db.prepare(`SELECT user_id FROM ${table}`).all(), [{ user_id: 'usr_bbbbbbbb' }]);
});

test('operator reset repairs only the requested test account and preserves raw corrupt history', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-repair-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.db'), db = new Database(file); t.after(() => db.close());
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT); INSERT INTO users VALUES('a','qa-temp-alpha@example.test'),('b','qa-temp-beta@example.test'); CREATE TABLE bots(id TEXT,user_id TEXT,name TEXT);");
  initUiDatabase(db); initUiPreferences(db); const store = new UiStore(db);
  store.write('a', DEFAULT_CONFIG, 7, 'user', Date.now()); store.write('b', DEFAULT_CONFIG, 3, 'user', Date.now());
  db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run('{', 'a');
  db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,updated_at) VALUES(?,0,?)').run('a', Date.now());
  const child = spawnSync(process.execPath, ['scripts/ui-config-reset.mjs', 'qa-temp-alpha@example.test'], { env: { PATH: process.env.PATH, DB_PATH: file }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).revision, 8);
  assert.deepEqual(JSON.parse(store.config('a')!.doc), DEFAULT_CONFIG); assert.equal(store.revision('a', 7)!.doc, '{');
  assert.equal(store.config('b')!.revision, 3); assert.equal(uiEnabled(db, 'a', 'on'), false);
});
