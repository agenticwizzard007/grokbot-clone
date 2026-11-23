import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-session-list-'));
Object.assign(process.env, {
  NODE_ENV: 'development', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(root, 'test.sqlite'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'session-list-tests-only', COMPUTER_PROVIDER: 'local',
  APP_URL: 'http://localhost:3000', SERVER_URL: 'http://localhost:3000',
  COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: 'http://localhost:1/v1',
  LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
});
// No model or toolkit requests may escape this isolated development fixture.
mock.method(globalThis, 'fetch', async () => Response.json({ data: [], items: [] }));
const { db } = await import('../server/src/db.js');
const { sessionHash, userFromToken } = await import('../server/src/lib/auth.js');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('QA SO A-04: session inventory matches authentication expiry without refreshing listed sessions', async () => {
  const login = await app.request('/api/auth/dev', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'session-fixture@example.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('swarm_session='))!.split(';')[0];
  const owner = userFromToken(cookie.split('=')[1])!;
  const at = Date.now();
  mock.method(Date, 'now', () => at);
  const day = 24 * 3600_000;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('foreign', 'foreign@example.test', 'Fixture', at);
  const cases = [
    { raw: 'active', created: at - 2 * day, seen: at - 1000, expires: at + day, active: true },
    { raw: 'idle-expired', created: at - 2 * day, seen: at - day - 1, expires: at + day, active: false },
    { raw: 'idle-boundary', created: at - 2 * day, seen: at - day, expires: at + day, active: false },
    { raw: 'idle-inside', created: at - 2 * day, seen: at - day + 1, expires: at + day, active: true },
    { raw: 'absolute-boundary', created: at - 7 * day, seen: at, expires: at + day, active: false },
    { raw: 'absolute-inside', created: at - 7 * day + 1, seen: at, expires: at + day, active: true },
    { raw: 'expires-boundary', created: at, seen: at, expires: at, active: false },
    { raw: 'legacy-expired', created: at - day, seen: 0, expires: at + day, active: false },
    { raw: 'legacy-active', created: at - day + 1, seen: 0, expires: at + day, active: true },
  ];
  const insert = db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (?,?,?,?,?,?)');
  for (const row of cases) insert.run(sessionHash(row.raw), owner.id, row.created, row.expires, row.seen, row.created);
  insert.run(sessionHash('foreign'), 'foreign', at, at + day, at, at);
  const before = db.prepare('SELECT * FROM auth_sessions WHERE token!=? ORDER BY token').all(sessionHash(cookie.split('=')[1]));
  const response = await app.request('/api/auth/sessions', { headers: { cookie } });
  assert.equal(response.status, 200);
  const { sessions } = await response.json() as { sessions: { id: string; current: boolean }[] };
  assert.equal(sessions.length, cases.filter(row => row.active).length + 1);
  assert.deepEqual(sessions.filter(row => row.current).map(row => row.id), [sessionHash(cookie.split('=')[1])]);
  assert.deepEqual(db.prepare('SELECT * FROM auth_sessions WHERE token!=? ORDER BY token').all(sessionHash(cookie.split('=')[1])), before);
  for (const row of cases) {
    assert.equal(sessions.some(session => session.id === sessionHash(row.raw)), row.active, row.raw);
    assert.equal(!!userFromToken(row.raw), row.active, `auth parity: ${row.raw}`);
  }
  assert.equal(sessions.some(row => row.id === sessionHash('foreign')), false);
});
