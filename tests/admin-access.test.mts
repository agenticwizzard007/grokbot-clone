import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Administrator authority is bound to immutable account ids. A server upgraded from the ADMIN_PHONES rule maps its
// configured owners to account_roles exactly once, on the first standalone startup of this version. Every scenario below
// seeds an OLD database first (users and roles, no marker), then starts the server modules in fresh processes, because
// the mapping runs at import time and the role is fixed per process.

const serverSrc = path.resolve('server/src');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-admin-'));
let n = 0;
const baseEnv = (dbPath: string) => ({ ...process.env, DB_PATH: dbPath, FILES_DIR: scratch, SESSION_SECRET: 'admin-access-test-secret', COMPUTER_PROVIDER: 'local', NODE_ENV: 'test', SWARM_ROLE: 'standalone', ADMIN_EMAILS: 'claimed@example.test', ADMIN_PHONES: undefined, ADMIN_USER_IDS: undefined } as Record<string, string | undefined>);
const clean = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
const run = (script: string, env: Record<string, string | undefined>) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: clean(env), encoding: 'utf8', cwd: process.cwd() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};

/** An old database: created by db.ts of this version minus the accounts module, with the pre-existing users.phone column. */
function seedOldDatabase(users: { id: string; phone: string | null }[], adminRoles: string[] = []) {
  const dbPath = path.join(scratch, `old-${++n}.db`);
  run(`const { db } = await import(${JSON.stringify(path.join(serverSrc, 'db.ts'))});
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    for (const u of ${JSON.stringify(users)}) db.prepare('INSERT INTO users(id,email,name,phone,created_at) VALUES (?,?,?,?,?)').run(u.id, u.id + '@example.test', u.id, u.phone, Date.now());
    for (const id of ${JSON.stringify(adminRoles)}) db.prepare("INSERT INTO account_roles VALUES(?,'admin')").run(id);
    db.close();`, baseEnv(dbPath));
  return dbPath;
}

/** One server startup: imports db, accounts (runs the mapping) and settings; reports roles, the marker and who may manage. */
function startup(dbPath: string, env: Record<string, string | undefined>, ids: string[]) {
  const out = run(`const { db } = await import(${JSON.stringify(path.join(serverSrc, 'db.ts'))});
    await import(${JSON.stringify(path.join(serverSrc, 'accounts.ts'))});
    const { canManageServer, loadSettings } = await import(${JSON.stringify(path.join(serverSrc, 'settings.ts'))});
    loadSettings();
    const roles = db.prepare("SELECT user_id FROM account_roles WHERE role='admin' ORDER BY user_id").all().map(r => r.user_id);
    const marker = db.prepare("SELECT value, updated_by FROM server_settings WHERE key='admin_bootstrap'").get() ?? null;
    const manage = Object.fromEntries(${JSON.stringify(ids)}.map(id => [id, canManageServer({ id, email: id + '@example.test' })]));
    console.log('RESULT ' + JSON.stringify({ roles, marker: marker && { ...JSON.parse(marker.value), updatedBy: marker.updated_by }, manage }));
    db.close();`, { ...baseEnv(dbPath), ...env });
  return JSON.parse(out.split('RESULT ')[1]) as { roles: string[]; marker: { outcome: string; granted: string[]; updatedBy: string | null } | null; manage: Record<string, boolean> };
}
const mutate = (dbPath: string, sql: string) => { const d = new Database(dbPath); d.exec(sql); d.close(); };
/** A startup that is allowed to fail; returns the exit status and combined output. */
const boot = (dbPath: string, env: Record<string, string | undefined>) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const { db } = await import(${JSON.stringify(path.join(serverSrc, 'db.ts'))}); await import(${JSON.stringify(path.join(serverSrc, 'accounts.ts'))}); db.close();`], { env: clean({ ...baseEnv(dbPath), ...env }), encoding: 'utf8', cwd: process.cwd() });
  return { status: r.status, output: r.stdout + r.stderr };
};
const state = (dbPath: string) => { const d = new Database(dbPath, { readonly: true }); const roles = d.prepare("SELECT user_id FROM account_roles WHERE role='admin' ORDER BY user_id").all().map((r: any) => r.user_id as string); const marker = d.prepare("SELECT 1 FROM server_settings WHERE key='admin_bootstrap'").get(); d.close(); return { roles, consumed: !!marker }; };
const LISTED = '15550100001';

test('upgrade: the first startup maps the configured owner once and records a marker outside user and role rows', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }, { id: 'usr_other', phone: '15550100002' }, { id: 'usr_email', phone: null }]);
  const first = startup(dbPath, { ADMIN_PHONES: '+1 (555) 010-0001' }, ['usr_owner', 'usr_other', 'usr_email']);
  assert.deepEqual(first.roles, ['usr_owner']);
  assert.equal(first.marker?.outcome, 'mapped');
  assert.deepEqual(first.marker?.granted, ['usr_owner']);
  assert.equal(first.marker?.updatedBy, null);
  assert.deepEqual(first.manage, { usr_owner: true, usr_other: false, usr_email: false });

  // Revoking the role and restarting must not grant it again.
  mutate(dbPath, 'DELETE FROM account_roles');
  const afterRevocation = startup(dbPath, { ADMIN_PHONES: '+1 (555) 010-0001' }, ['usr_owner']);
  assert.deepEqual(afterRevocation.roles, []);
  assert.equal(afterRevocation.manage.usr_owner, false);
  assert.equal(afterRevocation.marker?.outcome, 'mapped', 'the marker is unchanged by later restarts');

  // Reassigning the listed number to another account must not grant it either.
  mutate(dbPath, `UPDATE users SET phone=NULL WHERE id='usr_owner'; UPDATE users SET phone='${LISTED}' WHERE id='usr_other';`);
  const afterReassignment = startup(dbPath, { ADMIN_PHONES: LISTED }, ['usr_owner', 'usr_other']);
  assert.deepEqual(afterReassignment.roles, []);
  assert.deepEqual(afterReassignment.manage, { usr_owner: false, usr_other: false });

  // Explicit configuration is the only way back.
  assert.equal(startup(dbPath, { ADMIN_PHONES: LISTED, ADMIN_USER_IDS: 'usr_owner' }, ['usr_owner']).manage.usr_owner, true);
});

test('deleting the mapped administrator account and restarting grants nothing', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }, { id: 'usr_heir', phone: null }]);
  assert.deepEqual(startup(dbPath, { ADMIN_PHONES: LISTED }, []).roles, ['usr_owner']);
  mutate(dbPath, `PRAGMA foreign_keys=ON; DELETE FROM users WHERE id='usr_owner'; UPDATE users SET phone='${LISTED}' WHERE id='usr_heir';`);
  const after = startup(dbPath, { ADMIN_PHONES: LISTED }, ['usr_heir']);
  assert.deepEqual(after.roles, []);
  assert.equal(after.manage.usr_heir, false);
});

test('a pre-existing administrator consumes the mapping without granting, and its later deletion reopens nothing', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }, { id: 'usr_role', phone: null }], ['usr_role']);
  const first = startup(dbPath, { ADMIN_PHONES: LISTED }, ['usr_owner', 'usr_role']);
  assert.deepEqual(first.roles, ['usr_role']);
  assert.equal(first.marker?.outcome, 'preexisting-admin');
  assert.deepEqual(first.manage, { usr_owner: false, usr_role: true });
  mutate(dbPath, 'DELETE FROM account_roles');
  assert.deepEqual(startup(dbPath, { ADMIN_PHONES: LISTED }, []).roles, []);
});

test('explicit ADMIN_USER_IDS consumes the mapping without granting; removing the variable later reopens nothing', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }, { id: 'usr_listed', phone: null }]);
  const first = startup(dbPath, { ADMIN_PHONES: LISTED, ADMIN_USER_IDS: 'usr_listed' }, ['usr_owner', 'usr_listed']);
  assert.deepEqual(first.roles, []);
  assert.equal(first.marker?.outcome, 'explicit-ids');
  assert.deepEqual(first.manage, { usr_owner: false, usr_listed: true });
  const later = startup(dbPath, { ADMIN_PHONES: LISTED }, ['usr_owner', 'usr_listed']);
  assert.deepEqual(later.roles, []);
  assert.deepEqual(later.manage, { usr_owner: false, usr_listed: false });
});

test('no match and no configured numbers both consume the mapping; a listed phone appearing later grants nothing', () => {
  const noMatch = seedOldDatabase([{ id: 'usr_a', phone: '15550100002' }]);
  assert.equal(startup(noMatch, { ADMIN_PHONES: LISTED }, []).marker?.outcome, 'no-match');
  mutate(noMatch, `UPDATE users SET phone='${LISTED}' WHERE id='usr_a'`);
  assert.deepEqual(startup(noMatch, { ADMIN_PHONES: LISTED }, ['usr_a']).manage, { usr_a: false });

  const noPhones = seedOldDatabase([{ id: 'usr_a', phone: LISTED }]);
  assert.equal(startup(noPhones, {}, []).marker?.outcome, 'no-phones');
  assert.deepEqual(startup(noPhones, { ADMIN_PHONES: LISTED }, ['usr_a']).manage, { usr_a: false }, 'configuring numbers after the first start maps nothing');
});

test('an email address never grants administration', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_email', phone: null }]);
  mutate(dbPath, "UPDATE users SET email='claimed@example.test' WHERE id='usr_email'");
  assert.equal(startup(dbPath, { ADMIN_PHONES: LISTED }, ['usr_email']).manage.usr_email, false);
});

test('a failure to write the consumed marker rolls back the grants and fails the startup; a later retry may succeed', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }]);
  mutate(dbPath, "CREATE TRIGGER fail_marker BEFORE INSERT ON server_settings WHEN NEW.key='admin_bootstrap' BEGIN SELECT RAISE(ABORT, 'test_marker_failure'); END;");
  const failed = boot(dbPath, { ADMIN_PHONES: LISTED });
  assert.notEqual(failed.status, 0, 'startup must not continue past a failed mapping transaction');
  assert.match(failed.output, /test_marker_failure/);
  assert.deepEqual(state(dbPath), { roles: [], consumed: false }, 'the grant and the marker are one transaction');
  mutate(dbPath, 'DROP TRIGGER fail_marker');
  assert.deepEqual(startup(dbPath, { ADMIN_PHONES: LISTED }, []).roles, ['usr_owner'], 'a genuinely failed transaction may be retried on the next start');
});

test('a failure to insert one role rolls back the roles already granted and leaves the mapping unconsumed', () => {
  const dbPath = seedOldDatabase([{ id: 'usr_owner', phone: LISTED }, { id: 'usr_other', phone: '15550100002' }]);
  mutate(dbPath, "CREATE TRIGGER fail_role BEFORE INSERT ON account_roles WHEN NEW.user_id='usr_other' BEGIN SELECT RAISE(ABORT, 'test_role_failure'); END;");
  const failed = boot(dbPath, { ADMIN_PHONES: `${LISTED},15550100002` });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /test_role_failure/);
  assert.deepEqual(state(dbPath), { roles: [], consumed: false });
  mutate(dbPath, 'DROP TRIGGER fail_role');
  assert.deepEqual(startup(dbPath, { ADMIN_PHONES: `${LISTED},15550100002` }, []).roles, ['usr_other', 'usr_owner']);
});
