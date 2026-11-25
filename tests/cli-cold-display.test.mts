import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cold-display-'));
const fake = path.join(root, 'cli');
const delayFile = path.join(root, 'delay');
const audit = path.join(root, 'calls');
fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(audit)}, process.argv.slice(2).join(' ') + '\\n');
setTimeout(() => { console.log(process.argv[2] === 'login' ? 'Logged in using ChatGPT' : JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'})); }, Number(fs.readFileSync(${JSON.stringify(delayFile)}, 'utf8')));
`, { mode: 0o700 });
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), CLI_PROFILES_DIR: path.join(root, 'profiles'), SWARM_CLI_SERVER_LOGIN: '1', SWARM_CLI_CODEX_PATH: fake, SWARM_CLI_CLAUDE_PATH: fake, SESSION_SECRET: 'fixture-only', LLM_PROVIDER: 'direct' });
const { db } = await import('../server/src/db.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { clearCliCatalog, cliDisplayCatalog, cliCatalog } = await import('../server/src/cli/catalog.js');
const { modelsApi } = await import('../server/src/routes-models.js');
const app = new Hono().route('/api', modelsApi);
for (const id of ['cold-10', 'cold-20', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Fixture', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
  selectCli(id, 'codex');
}
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const seconds of [10, 20]) test(`hosted Codex cold status taking ${seconds}s survives passive reads and an aborted first waiter`, async () => {
  fs.writeFileSync(delayFile, String(seconds * 1000));
  const user = `cold-${seconds}`;
  const start = performance.now();
  const first = await app.request('/api/models', { headers: { cookie: `swarm_session=${user}` } });
  const initial = await first.json() as any;
  assert.ok(performance.now() - start < 1500);
  assert.equal(initial.stale, true); assert.equal(initial.error, undefined);
  const abort = new AbortController();
  const cancelled = cliCatalog(user, 'codex', false, abort.signal);
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  for (let i = 0; i < 100; i++) {
    const data = await cliDisplayCatalog(user, 'codex');
    if (!data.stale) {
      assert.equal(data.models[0].id, 'codex/default');
      assert.equal(data.models[0].name, 'Codex CLI default');
      assert.equal(data.usage.available, false, 'no invented ChatGPT quota');
      assert.ok(performance.now() - start >= seconds * 1000);
      // One official status spawn per provider, despite repeated passive reads.
      assert.equal(fs.readFileSync(audit, 'utf8').trim().split('\n').filter(line => line.startsWith('login')).length, seconds === 10 ? 1 : 2);
      clearCliCatalog(user);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail('Cold catalog never settled');
});
