// MF-028 (PD-08 option B): GET /api/conversation-search fans out to every Bot the user owns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-qa-ws3-search-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'qa-ws3-search-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async () => { throw new Error('Tests must not call the network'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
initSubagents(); // adds bots.hidden, which listBots filters on
for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
const insertBot = (id: string, owner: string, generation = 1) => db.prepare('INSERT INTO bots(id,user_id,name,generation,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, owner, id.toUpperCase(), generation, Date.now(), Date.now());
insertBot('alpha', 'owner'); insertBot('beta', 'owner', 2); insertBot('foreign', 'other');
let seq = 0;
const message = (botId: string, text: string, opts: { generation?: number; role?: string; audience?: string } = {}) => {
  const n = ++seq;
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(botId, opts.generation ?? 1, n, n, 'message', JSON.stringify({ type: 'message', role: opts.role ?? 'user', text, ...(opts.audience ? { audience: opts.audience } : {}) }), 1000 + n);
  return n;
};
const alphaSeq = message('alpha', 'Please reply PONG when ready');
const betaSeq = message('beta', 'PONG received, all good', { generation: 2, role: 'assistant' });
message('beta', 'An older PONG from the cleared conversation', { generation: 1 });
message('alpha', 'Internal PONG between Bots', { audience: 'internal' });
message('foreign', 'Someone else said PONG');

const { knowledgeApi, searchAllConversations, searchSnippet } = await import('../server/src/routes-knowledge.js');
function cookie(owner: string) {
  const raw = crypto.randomBytes(32).toString('hex'); const hash = crypto.createHash('sha256').update(raw).digest('hex'); const at = Date.now();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(?,?,?,?,?,?)').run(hash, owner, at, at + 60000, at, at);
  return `swarm_session=${raw}`;
}
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('conversation search spans the user\'s Bots, current conversations only, newest first', () => {
  const { results } = searchAllConversations('owner', 'pong');
  assert.deepEqual(results.map(r => [r.botId, r.seq, r.role]), [['beta', betaSeq, 'assistant'], ['alpha', alphaSeq, 'user']]);
  assert.equal(results[0].botName, 'BETA');
  assert.equal(results[0].generation, 2);
  assert.deepEqual(searchAllConversations('owner', '   ').results, []);
  assert.deepEqual(searchAllConversations('other', 'pong').results.map(r => r.botId), ['foreign'], 'never another account\'s Bots');
});

test('GET /conversation-search requires a session and caps results at 20', async () => {
  assert.equal((await knowledgeApi.request('/conversation-search?q=pong')).status, 401);
  for (let i = 0; i < 30; i++) message('alpha', `Bulk PONG ${i}`);
  const res = await knowledgeApi.request('/conversation-search?q=pong', { headers: { cookie: cookie('owner') } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json() as { results: { botId: string }[] };
  assert.equal(body.results.length, 20);
  assert.ok(body.results.every(r => r.botId === 'alpha' || r.botId === 'beta'));
  const long = await knowledgeApi.request(`/conversation-search?q=${'a'.repeat(501)}`, { headers: { cookie: cookie('owner') } });
  assert.equal(long.status, 400);
});

test('snippets centre on the match and stay short', () => {
  const text = `${'intro '.repeat(60)}the PONG answer ${'tail '.repeat(60)}`;
  const snippet = searchSnippet(text, 'pong', 80);
  assert.ok(snippet.includes('PONG'));
  assert.ok(snippet.length <= 86);
  assert.ok(snippet.startsWith('...') && snippet.endsWith('...'));
  assert.equal(searchSnippet('short text', 'x'), 'short text');
});
