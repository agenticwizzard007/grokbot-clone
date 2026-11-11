import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tenant-browser-tools-'));
const owner = 'usr_tenant_browser_integrity';
const manifest = path.join(root, 'manifest.json'), key = path.join(root, 'key');
fs.writeFileSync(manifest, JSON.stringify({ tenantId: owner, volumeId: 'fixture-volume' }));
fs.writeFileSync(key, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 });
Object.assign(process.env, {
  SWARM_ROLE: 'tenant', SWARM_TENANT_ID: owner, SWARM_VOLUME_ID: 'fixture-volume', NODE_ENV: 'test',
  TENANT_MANIFEST_FILE: manifest, TENANT_DATA_KEY_FILE: key, DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'tenant-browser-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', COMPOSIO_WEBHOOK_SECRET: '',
  FLY_API_TOKEN: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
  INKBOX_ADMIN_API_KEY: '', INKBOX_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '', GOOGLE_CLIENT_SECRET: '', APPLE_PRIVATE_KEY: '',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No network is allowed in tenant capability tests'); });
const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
const { createBot } = await import('../server/src/bots.js');
const { computers } = await import('../server/src/computers/index.js');
const { BROWSER_TOOLS } = await import('../server/src/computers/browser-tools.js');
const { functionSchemas } = await import('../server/src/agent/tools.js');
const { prepareCliRequest } = await import('../server/src/cli/responses.js');
const { withUsage } = await import('../server/src/usage-context.js');
initSubagents(); initRooms();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(owner, 'tenant@example.test', 'Tenant', Date.now());
const bot = createBot(owner, { name: 'Tenant primary', isPrimary: true });
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('tenant local MULTI advertises browser and shell without requiring a personal computer', () => withUsage({ userId: owner, botId: bot.id }, () => {
  assert.equal(computers.kind, 'local');
  assert.equal(computers.capabilities.shell, true);
  assert.equal(computers.capabilities.browser, true);
}));

test('all 18 tenant browser tools reach the subscription native manifest with their exact schemas', () => withUsage({ userId: owner, botId: bot.id }, () => {
  const tools = functionSchemas(bot.id);
  const request = prepareCliRequest({ input: [{ role: 'user', content: 'Use my Swarm browser.' }], tools }, true);
  const browser = request.nativeTools.filter((tool: any) => tool.name.startsWith('browser_'));
  assert.equal(browser.length, 18);
  assert.deepEqual(browser, BROWSER_TOOLS);
  assert.ok(request.nativeTools.some((tool: any) => tool.name === 'shell'));
}));
