import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { assertLegacyDatabaseFences, assertLegacyFenceCurrent, holdLegacyDatabase, registerLegacyFenceFunctions } from '../../server/src/platform/legacy-database-fence.js';

const tenant = 'usr_fence_fixture';
function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-fence-'));
    const file = path.join(root, 'fixture.db');
    const db = new Database(file);
    db.pragma('journal_mode=WAL');
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
        CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
        CREATE TABLE outputs(id TEXT PRIMARY KEY,bot_id TEXT REFERENCES bots(id),body TEXT);
        INSERT INTO users VALUES('${tenant}');
        INSERT INTO bots VALUES('fixture-bot','${tenant}');`);
    const other = new Database(file);
    registerLegacyFenceFunctions(other);
    t.after(() => { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const receipt = holdLegacyDatabase(db, tenant, 'fixture-migration-operation', '1');
    assertLegacyFenceCurrent(db, receipt);
    return { db, other, receipt };
}

test('warm fence checks detect trigger replacement and deletion through another connection', t => {
    const { db, other, receipt } = fixture(t);
    const trigger = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='outputs' ORDER BY name LIMIT 1").get() as { name: string; sql: string };
    const name = `"${trigger.name.replaceAll('"', '""')}"`;
    other.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} BEFORE INSERT ON outputs BEGIN SELECT 1; END`);
    for (let i = 0; i < 2; i++) assert.throws(() => assertLegacyFenceCurrent(db, receipt), /missing or changed/);
    other.exec(`DROP TRIGGER ${name}`);
    assert.throws(() => assertLegacyDatabaseFences(db), /missing or changed/);
    other.exec(trigger.sql);
    assertLegacyFenceCurrent(db, receipt);
    assert.throws(() => other.prepare('INSERT INTO outputs VALUES(?,?,?)').run('fixture-output', 'fixture-bot', 'Placeholder'), /migration_hold/);
});

test('warm fence checks detect live schema and receipt changes after successful validation', t => {
    const { db, other, receipt } = fixture(t);
    other.exec('CREATE INDEX fixture_body ON outputs(body)');
    assert.throws(() => assertLegacyFenceCurrent(db, receipt), /schema changed/);
    other.exec('DROP INDEX fixture_body');
    assertLegacyFenceCurrent(db, receipt);
    other.exec('UPDATE legacy_owner_fences SET version=2');
    assert.throws(() => assertLegacyFenceCurrent(db, receipt), /schema changed/);
    other.exec('UPDATE legacy_owner_fences SET version=1');
    assertLegacyFenceCurrent(db, receipt);
    const renewed = holdLegacyDatabase(other, tenant, receipt.operation, '2');
    assert.throws(() => assertLegacyFenceCurrent(db, receipt), /fence changed/);
    assertLegacyFenceCurrent(db, renewed);
});

test('a verified database cannot mask a missing fence on another database with identical schema', t => {
    const first = fixture(t), second = fixture(t);
    assert.equal(first.receipt.schemaHash, second.receipt.schemaHash);
    const trigger = second.other.prepare("SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1").get() as { name: string };
    second.other.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    assertLegacyFenceCurrent(first.db, first.receipt);
    assert.throws(() => assertLegacyFenceCurrent(second.db, second.receipt), /missing or changed/);
});
