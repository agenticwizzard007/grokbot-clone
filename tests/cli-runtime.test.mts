// node --import tsx --test tests/cli-runtime.test.mts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-runtime-'));
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'app.db'),
  FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'offline-cli-runtime-test',
  COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0',
});
const { db } = await import('../server/src/db.js');
for (const id of ['legacy', 'hosted', 'bridge', 'new', 'late-legacy']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
}
// Reproduce an installation before runtime preferences were persisted.
db.exec(`
  CREATE TABLE cli_pairings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER);
  CREATE TABLE cli_runtimes(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, location TEXT NOT NULL CHECK(location IN ('server','bridge')));
  INSERT INTO cli_pairings VALUES ('legacy','legacy-hash',NULL),('hosted','old-hash',NULL);
  INSERT INTO cli_runtimes VALUES ('hosted','server'),('bridge','bridge');
`);
const { cliRuntime, createCliPairing, revokeCliPairing, setCliRuntime, selectCli, selectedCli } = await import('../server/src/cli/store.js');
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('hosted is the default; upgrading persists legacy bridge choices without overriding explicit preferences', () => {
  assert.equal(cliRuntime('new'), 'server');
  assert.equal(cliRuntime('legacy'), 'bridge');
  assert.deepEqual(db.prepare('SELECT location FROM cli_runtimes WHERE user_id=?').get('legacy'), { location: 'bridge' });
  assert.equal(cliRuntime('hosted'), 'server', 'a leftover bridge token cannot override hosted execution');
  assert.equal(cliRuntime('bridge'), 'bridge', 'an offline explicit bridge never becomes hosted');
});

test('revoking legacy and current bridge tokens preserves the runtime and subscription choice', () => {
  db.prepare('INSERT INTO cli_pairings VALUES (?,?,NULL)').run('late-legacy', 'late-hash');
  selectCli('late-legacy', 'claude');
  assert.equal(cliRuntime('late-legacy'), 'bridge');
  revokeCliPairing('late-legacy');
  assert.equal(cliRuntime('late-legacy'), 'bridge');
  assert.equal(selectedCli('late-legacy'), 'claude');
  assert.equal(db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get('late-legacy'), undefined);
  createCliPairing('new');
  revokeCliPairing('new');
  assert.equal(cliRuntime('new'), 'bridge');
});

test('explicit hosted login wins over a legacy pairing and remains hosted after token revocation', () => {
  setCliRuntime('legacy', 'server');
  revokeCliPairing('legacy');
  assert.equal(cliRuntime('legacy'), 'server');
  revokeCliPairing('hosted');
  assert.equal(cliRuntime('hosted'), 'server');
});
