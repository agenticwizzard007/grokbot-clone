import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Administrator authority is bound to immutable account ids. A server upgraded from the ADMIN_PHONES rule maps its
// configured owners to account_roles once; phones never grant the role dynamically.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-admin-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: root, SESSION_SECRET: 'admin-access-test-secret', COMPUTER_PROVIDER: 'local',
  ADMIN_PHONES: '+1 (555) 010-0001, 15550100009', ADMIN_EMAILS: 'claimed@example.test' });
delete process.env.ADMIN_USER_IDS;
const { db } = await import('../server/src/db.js');
const { bootstrapAdministrators } = await import('../server/src/accounts.js'); // adds users.phone and runs the (empty) mapping
const { canManageServer } = await import('../server/src/settings.js');

const t = Date.now();
const insert = db.prepare('INSERT INTO users(id,email,name,phone,created_at) VALUES (?,?,?,?,?)');
insert.run('usr_owner', 'tel+15550100001@phone.invalid', 'Owner', '15550100001', t);
insert.run('usr_other', 'tel+15550100002@phone.invalid', 'Other', '15550100002', t + 1);
insert.run('usr_email', 'claimed@example.test', 'Email only', null, t + 2);
const user = (id: string) => ({ id, email: (db.prepare('SELECT email FROM users WHERE id=?').get(id) as { email: string }).email });

test('an upgraded server maps its ADMIN_PHONES owners to account_roles once', () => {
  assert.equal(canManageServer(user('usr_owner')), false, 'no administrator exists before the mapping');
  assert.deepEqual(bootstrapAdministrators(), ['usr_owner']);
  assert.equal(canManageServer(user('usr_owner')), true);
  assert.equal(canManageServer(user('usr_other')), false);
  assert.equal(canManageServer(user('usr_email')), false, 'an email address never grants administration');
});

test('after the mapping, phones no longer grant the role and the mapping does not repeat', () => {
  insert.run('usr_late', 'tel+15550100009@phone.invalid', 'Late owner number', '15550100009', t + 3);
  assert.deepEqual(bootstrapAdministrators(), [], 'an administrator already exists');
  assert.equal(canManageServer(user('usr_late')), false, 'a listed phone attached later does not confer the role');
});

test('ADMIN_USER_IDS is authoritative and disables the mapping', () => {
  db.prepare('DELETE FROM account_roles').run();
  process.env.ADMIN_USER_IDS = 'usr_other';
  try {
    assert.deepEqual(bootstrapAdministrators(), [], 'explicit ids mean the operator has adopted the id-based model');
    assert.equal(canManageServer(user('usr_other')), true);
    assert.equal(canManageServer(user('usr_owner')), false);
  } finally { delete process.env.ADMIN_USER_IDS; }
});
