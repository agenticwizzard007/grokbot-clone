import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-zone-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'local-zone-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '' });
mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests in time zone tests'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { createBot } = await import('../server/src/bots.js');
const { toolMap, executionPolicyFor } = await import('../server/src/agent/tools.js');
const { getCheckins, setCheckins } = await import('../server/src/proactive.js');
const { hub } = await import('../server/src/lib/hub.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('zone-account', 'zone@example.test', 'Test account', Date.now());
const bot = createBot('zone-account', { name: 'Account Bot', isPrimary: true });
const ctx = { userId: 'zone-account', botId: bot.id, depth: 0, enqueueBotMessage() {} };
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('Bot account time zone writes require fresh chat confirmation even with an Always allow policy', async () => {
  const before = db.prepare('SELECT timezone FROM users WHERE id=?').get(ctx.userId);
  for (const tool of ['update_profile', 'update_profile:timezone']) {
    db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,?)').run(ctx.userId, tool, 'always_allow');
  }
  const policy = await executionPolicyFor(ctx.userId, 'update_profile', { timezone: 'Asia/Dubai' }, bot.id);
  assert.equal(policy.decision, 'ask');
  assert.equal(policy.title, 'change your account time zone to Asia/Dubai');
  assert.deepEqual(db.prepare('SELECT timezone FROM users WHERE id=?').get(ctx.userId), before);
  assert.equal((await executionPolicyFor(ctx.userId, 'update_profile', { name: 'Account' }, bot.id)).decision, 'allow');
  assert.match(toolMap.get('update_profile')!.description, /explicitly asks in this chat/);
});

test('confirmed Bot time zone changes leave a chat notice, update account schedules and notify the UI', async () => {
  const events: unknown[] = [];
  const unsubscribe = hub.subscribe(ctx.userId, event => events.push(event));
  try {
    const result = await toolMap.get('update_profile')!.impl({ timezone: 'Asia/Dubai' }, ctx);
    assert.equal(result.summary, 'Account time zone set to Asia/Dubai');
    assert.deepEqual(db.prepare('SELECT timezone FROM users WHERE id=?').get(ctx.userId), { timezone: 'Asia/Dubai' });
    const notice = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice' ORDER BY seq DESC LIMIT 1").get(bot.id) as { body: string };
    assert.match(notice.body, /Account time zone changed to Asia\/Dubai/);
    assert.ok(events.some(event => (event as any).type === 'synopses' && (event as any).timezone === 'Asia/Dubai'));
    assert.equal(getCheckins(ctx.userId).timezone, 'Asia/Dubai');
    setCheckins(ctx.userId, { enabled: false, timezone: 'Asia/Tokyo' });
    await toolMap.get('update_profile')!.impl({ timezone: 'Europe/London' }, ctx);
    assert.equal(getCheckins(ctx.userId).timezone, 'Asia/Tokyo', 'explicit check-in schedules stay independent of the account default');
  } finally { unsubscribe(); }
});

test('invalid Bot time zones cannot alter the account or append a success note', async () => {
  const before = db.prepare('SELECT timezone FROM users WHERE id=?').get(ctx.userId);
  const result = await toolMap.get('update_profile')!.impl({ timezone: 'Mars/Base' }, ctx);
  assert.match(String(result.output), /not a valid IANA time zone/);
  assert.deepEqual(db.prepare('SELECT timezone FROM users WHERE id=?').get(ctx.userId), before);
});
