import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { seedChatOpen, CHAT_OPEN_BOT, CHAT_OPEN_ROWS } from './chat-open-fixture.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'chat-open-api-'));
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(temp, 'app.db'),
  FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'chat-open-fixture-only', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('External backend request blocked'); });
const { db } = await import('../server/src/db.js');
const { api } = await import('../server/src/routes.js');
const { repairActiveSetup } = await import('../server/src/bot-setup.js');
const app = new Hono().route('/api', api);
const now = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('fixture-owner', 'fixture@example.test', 'Fixture account', now);
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)')
  .run('fixture-session', 'fixture-owner', now, now + 60000);
seedChatOpen(db, 'fixture-owner');
const request = (suffix = '') => app.request(`/api/bots/${CHAT_OPEN_BOT}/${suffix || 'rows'}`, { headers: { cookie: 'swarm_session=fixture-session' } });
after(() => { mock.restoreAll(); db.close(); rmSync(temp, { recursive: true, force: true }); });

test('chat open returns only the latest 24 rows, with a disjoint older page', async () => {
  const first = await (await request()).json();
  assert.equal(first.rows.length, 24);
  assert.equal(first.rows[0].seq, CHAT_OPEN_ROWS - 23);
  assert.equal(first.rows.at(-1).seq, CHAT_OPEN_ROWS);
  assert.equal(first.revision, CHAT_OPEN_ROWS);
  assert.equal(first.olderCursor, first.rows[0].seq);
  assert.ok(first.rows.some((r: any) => r.body.type === 'tool-call' && JSON.stringify(r.body).length > 48_000));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 600_000, 'latest page is bounded even with large tool bodies');
  const older = await (await request(`rows?beforeSeq=${first.olderCursor}&limit=200`)).json();
  assert.equal(older.rows.length, 200);
  assert.equal(older.rows.at(-1).seq, first.rows[0].seq - 1);
  assert.equal(new Set([...older.rows, ...first.rows].map(r => r.seq)).size, 224);
  assert.equal(older.olderCursor, older.rows[0].seq);
});

test('first-page handler only uses bounded indexed history reads and never repairs setup', async t => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    for (const method of ['all', 'get', 'run'] as const) {
      const execute = statement[method].bind(statement);
      statement[method] = (...params: unknown[]) => { statements.push({ sql, params }); return execute(...params); };
    }
    return statement;
  });
  assert.equal((await request()).status, 200);
  assert.ok(statements.every(({ sql }) => !/json_extract|UPDATE|INSERT|DELETE/i.test(sql)), 'no full-history JSON scan or setup mutation');
  const history = statements.filter(({ sql }) => /FROM rows\b/.test(sql));
  assert.equal(history.length, 1, 'no per-row queries');
  assert.match(history[0].sql, /LIMIT \?/);
  assert.equal(history[0].params.at(-1), 24);
  for (const { sql, params } of history) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[];
    assert.ok(plan.some(row => /SEARCH rows USING INDEX sqlite_autoindex_rows_1/.test(row.detail)));
    assert.ok(plan.every(row => !/SCAN|TEMP B-TREE/.test(row.detail)));
  }
});

test('setup repair uses the partial card index instead of reading message/tool bodies', () => {
  const sql = "SELECT seq FROM rows WHERE bot_id=? AND generation=? AND created_at < ? AND kind='card' AND json_extract(body,'$.card')='question'";
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(CHAT_OPEN_BOT, 1, now) as any[];
  assert.ok(plan.some(row => /SEARCH rows USING INDEX rows_cards/.test(row.detail)));
  repairActiveSetup(CHAT_OPEN_BOT);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(CHAT_OPEN_BOT) as any).n, CHAT_OPEN_ROWS);
});

test('revision recovery is bounded, indexed, ordered and excludes unchanged or unopened history', async () => {
  const page = await (await request('row-changes?afterRev=500&throughRev=720&minSeq=501')).json();
  assert.equal(page.rows.length, 200);
  assert.equal(page.nextRev, 700);
  const rest = await (await request(`row-changes?afterRev=${page.nextRev}&throughRev=720&minSeq=501`)).json();
  assert.equal(rest.rows.length, 20);
  assert.equal(rest.rows[0].seq, 701);
  assert.equal(rest.nextRev, null);
  const unchanged = await (await request('row-changes?afterRev=720&throughRev=720&minSeq=1')).json();
  assert.equal(unchanged.rows.length, 0);
  const sql = 'SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? AND updated_seq<=? AND seq>=? ORDER BY updated_seq ASC LIMIT 200';
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(CHAT_OPEN_BOT, 1, 500, 720, 501) as any[];
  assert.ok(plan.some(row => /SEARCH rows USING INDEX rows_rev/.test(row.detail)));
  assert.ok(plan.every(row => !/SCAN|TEMP B-TREE/.test(row.detail)));
  assert.equal((await request('row-changes?afterRev=bad&throughRev=720&minSeq=1')).status, 400);
  assert.equal((await request('row-changes?afterRev=0&throughRev=Infinity&minSeq=1')).status, 400);
});
