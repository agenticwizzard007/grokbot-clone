import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { assembleToolCatalog } from '../server/src/agent/tool-catalog.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-capacity-'));
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'mcp-capacity-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'unused', ADMIN_EMAILS: '',
});
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { saveMcpServer, getMcpServer } = await import('../server/src/mcp/store.js');
const { testMcpServer, mcpSchemas, closeMcpSessions } = await import('../server/src/mcp/client.js');
const { TOOLS } = await import('../server/src/agent/tools.js');
const { composioTools } = await import('../server/src/composio.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Owner', Date.now());
const a = createBot('owner', { name: 'A', isPrimary: true });
const b = createBot('owner', { name: 'B', isPrimary: true });
let discovered = 0;
const tools = (count: number) => Array.from({ length: count }, (_, n) => ({ name: `tool_${n}`, description: 'Fixture tool', inputSchema: { type: 'object' as const } }));
const server = (botIds: string[] | null = [a.id], enabled = true) => saveMcpServer('owner', {
  name: 'Capacity fixture', transport: 'http', url: 'https://capacity.example.test/mcp', botIds, enabled,
});
async function discover(s: ReturnType<typeof server>, count: number) {
  discovered = count;
  return (await testMcpServer(s))!;
}
beforeEach(() => {
  db.exec('DELETE FROM mcp_servers');
  // The production discovery/caching path runs; only the remote server is fake.
  mock.method(Client.prototype, 'connect', async () => {});
  mock.method(Client.prototype, 'close', async () => {});
  mock.method(Client.prototype, 'listTools', async () => ({ tools: tools(discovered) }));
});
afterEach(async () => { await closeMcpSessions(); mock.restoreAll(); });
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('discovery accepts the per-agent budget and rejects growth before replacing a working manifest', async () => {
  assert.equal((await discover(server(), 1000)).error, null);
  assert.equal((await discover(server(), 1000)).error, null);
  await discover(server(), 1000);
  await discover(server(), 1000);
  const last = await discover(server(), 96);
  assert.equal(last.error, null);
  assert.equal(mcpSchemas('owner', a.id).length, 4096);
  const rejected = await discover(last, 97);
  assert.match(rejected.error!, /4097.*4096/);
  assert.match(rejected.error!, /agent|server/i);
  assert.deepEqual(rejected.tools, last.tools, 'failed rediscovery preserves the last accepted manifest');
  assert.equal(rejected.revision, last.revision);
  assert.equal(mcpSchemas('owner', a.id).length, 4096);
});

test('capacity applies to overlapping assignments, including all-agent servers, rather than the whole account', async () => {
  for (const bot of [a, b]) for (let n = 0; n < 4; n++) assert.equal((await discover(server([bot.id]), 1000)).error, null);
  assert.equal(mcpSchemas('owner', a.id).length, 4000);
  assert.equal(mcpSchemas('owner', b.id).length, 4000);
  const wildcard = await discover(server(null), 97);
  assert.match(wildcard.error!, /4097.*4096/);
  assert.equal(wildcard.tools.length, 0);
  assert.equal((await discover(wildcard, 96)).error, null);
  assert.equal(mcpSchemas('owner', a.id).length, 4096);
  assert.equal(mcpSchemas('owner', b.id).length, 4096);
});

test('unassigned and disabled servers consume no budget until enabled, assigned and rediscovered', async () => {
  for (let n = 0; n < 4; n++) await discover(server(), 1000);
  const unassigned = await discover(server([]), 200);
  const disabled = await discover(server([a.id], false), 200);
  assert.equal(unassigned.error, null); assert.equal(disabled.error, null);
  assert.equal(mcpSchemas('owner', a.id).length, 4000);
  for (const previous of [unassigned, disabled]) {
    const assigned = saveMcpServer('owner', { botIds: [a.id], enabled: true }, previous);
    assert.equal(assigned.tools.length, 0);
    assert.match((await discover(assigned, 200)).error!, /4200.*4096/);
  }
});

test('legacy oversized configurations give an actionable error and can be repaired by disabling a server', () => {
  const saved = [server(), server(), server(), server(), server()];
  for (const s of saved) db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify(tools(1000)), s.id);
  assert.throws(() => mcpSchemas('owner', a.id), /5000.*4096/);
  const current = getMcpServer('owner', saved[2].id)!;
  saveMcpServer('owner', { enabled: false }, current);
  assert.equal(mcpSchemas('owner', a.id).length, 4000);
});

test('the custom-tool budget leaves room for the complete built-in and app wrapper union', async () => {
  const { MAX_CUSTOM_MCP_TOOLS } = await import('../server/src/mcp/store.js');
  const full = [...TOOLS.map(t => ({ type: 'function', ...t })), ...(await composioTools('owner')), ...tools(MAX_CUSTOM_MCP_TOOLS).map(t => ({ type: 'function', name: 'mcp_' + t.name, parameters: t.inputSchema }))];
  assert.equal(MAX_CUSTOM_MCP_TOOLS, 4096);
  assert.ok(assembleToolCatalog(full).tools.length <= 512, 'deferred schemas must fit both native CLI transports');
});
