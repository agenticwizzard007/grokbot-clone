import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { conversationUsagePercent } from '../web/src/lib/conversationUsage.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-usage-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture', SWARM_COMPACT_CHARS: '300000', SWARM_COMPACT_TOKENS: '' });
const { db } = await import('../server/src/db.js');
const { configApi } = await import('../server/src/routes-config.js');
const { createBot } = await import('../server/src/bots.js');
const { appendHistory, loadHistory, clearConversation } = await import('../server/src/store.js');
const { noteUsage, estimateChars } = await import('../server/src/agent/memory.js');
const app = new Hono().route('/api', configApi);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner', 'memory@example.test', 'Fixture', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('fixture', 'owner', Date.now(), Date.now() + 3600000);
const bot = createBot('owner', { name: 'Memory fixture' });
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const [name, chars, expected] of [['empty', 0, 0], ['typical', 30000, 10], ['near limit', 297000, 99]] as const) {
  test(`R7 conversation history meter: ${name}, independent of hosted request token usage`, async () => {
    clearConversation(bot.id);
    if (chars) appendHistory(bot.id, [{ role: 'user', content: 'x'.repeat(chars) }]);
    const history = loadHistory(bot.id);
    // Hosted runners include instructions, tool schemas and cumulative input, not stored history alone.
    noteUsage(bot.id, 500000, history.length);
    const response = await app.request(`/api/bots/${bot.id}/settings`, { headers: { cookie: 'swarm_session=fixture' } });
    assert.equal(response.status, 200);
    const { memory } = await response.json() as any;
    assert.equal(memory.historyChars, estimateChars(history));
    assert.equal(memory.compactAtChars, 300000);
    assert.equal(conversationUsagePercent(memory.historyChars, memory.compactAtChars), expected);
  });
}

test('R7 nearly empty history stays low and invalid thresholds never show full', () => {
  assert.equal(conversationUsagePercent(500, 300000), 0);
  for (const limit of [0, -1, NaN, Infinity]) assert.equal(conversationUsagePercent(500, limit), null);
  assert.equal(conversationUsagePercent(400000, 300000), 100);
  assert.equal(conversationUsagePercent(-5, 300000), 0);
});
