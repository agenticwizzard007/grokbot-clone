// Exhaustive registration/transport coverage, not a live-provider action test.
// Real Responses adapter, runner, HTTP MCP and personal WebSocket transport;
// only the provider executable and the final action handler are fixtures.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { startBridge } from '../companion/cli-bridge.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-manifest-'));
const unexpectedRequests: string[] = [];
const server = createServer((req, res) => {
  unexpectedRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503); res.end('No API fallback is allowed');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'manifest-test-only', SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'cloudvm',
  COMPOSIO_API_KEY: 'manifest-unused', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0', SWARM_CLI_SERVER_LOGIN: '1',
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: `${base}/direct`,
  OPENROUTER_API_KEY: 'fixture', OPENROUTER_BASE_URL: `${base}/openrouter`,
});
const { db } = await import('../server/src/db.js');
const { TOOLS, toolMap } = await import('../server/src/agent/tools.js');
const { composioTools } = await import('../server/src/composio.js');
const { createBot } = await import('../server/src/bots.js');
const { saveMcpServer } = await import('../server/src/mcp/store.js');
const { mcpSchemas } = await import('../server/src/mcp/client.js');
const { createCliPairing, selectCli, setCliRuntime } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliStatus, disconnectCli } = await import('../server/src/cli/bridge.js');
const { cliResponsesClient } = await import('../server/src/cli/responses.js');
const { withNativeTools } = await import('../server/src/cli/native-tools.js');
const { withUsage, attribution, currentComputerRevision } = await import('../server/src/usage-context.js');
attachCliSocket(server);
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

const owner = 'manifest-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(owner, `${owner}@example.test`, owner, Date.now());
const bot = createBot(owner, { name: 'Manifest Bot', isPrimary: true });
const custom = saveMcpServer(owner, {
  name: 'Manifest fixture', transport: 'http', url: 'https://fixture.example.test/mcp', botIds: [bot.id], requireApproval: false,
});
// Cached discovery fixtures exercise real custom-tool name/schema mapping without
// opening a remote MCP connection or executing the remote actions.
db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([
  { name: 'lookup/item', description: 'Look up a fixture item', inputSchema: {
    type: 'object', properties: { key: { type: 'string', minLength: 1 } }, required: ['key'], additionalProperties: false,
  } },
  { name: 'lookup_item', description: 'Distinct tool with the same sanitized name', inputSchema: {
    type: 'object', properties: { ids: { type: 'array', minItems: 2, items: { type: 'integer', minimum: 1 } } }, required: ['ids'], additionalProperties: false,
  } },
]), custom.id);
const customTools = mcpSchemas(owner, bot.id);
const manifest = [...TOOLS, ...await composioTools(owner), ...customTools].map(({ name, description, parameters }) => ({ name, description, parameters }));

// Generate required arguments from the actual schemas so newly added tools enter
// the matrix automatically. AJV checks these examples independently below.
function sample(schema: any): any {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries((schema.required ?? []).map((key: string) => [key, sample(schema.properties?.[key] ?? {})]));
    case 'array': return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? {}));
    case 'integer': case 'number': return Math.min(schema.maximum ?? Infinity, Math.max(schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1));
    case 'boolean': return false;
    case 'null': return null;
    case 'string': return 'x'.repeat(Math.max(schema.minLength ?? 0, 1));
    case undefined: return {};
    default: throw new Error(`Add a sample generator for schema type ${schema.type}`);
  }
}
const validator = new AjvJsonSchemaValidator();
const cases = manifest.map(tool => ({ ...tool, arguments: sample(tool.parameters), validate: validator.getValidator(tool.parameters as any) }));
const fixtureCases = path.join(temp, 'cases.json');
fs.writeFileSync(fixtureCases, JSON.stringify(cases));

test('the entire exported tool union has unique names, handlers and valid schema examples', () => {
  assert.equal(new Set(manifest.map(tool => tool.name)).size, manifest.length);
  assert.equal(customTools.length, 2);
  assert.notEqual(customTools[0].name, customTools[1].name, 'custom names that sanitize identically must remain distinct');
  assert.ok(manifest.some(tool => tool.name === 'SWARM_APPS_SEARCH'));
  assert.ok(manifest.some(tool => tool.name === 'SWARM_APPS_EXECUTE'));
  for (const tool of TOOLS) assert.equal(toolMap.get(tool.name), tool, `${tool.name}: missing built-in handler`);
  for (const tool of cases) {
    const result = tool.validate(tool.arguments);
    assert.equal(result.valid, true, `${tool.name}: ${result.errorMessage}`);
  }
});

async function executable(provider: 'claude' | 'codex', auditFile: string) {
  const file = path.join(temp, `${provider}-${path.basename(auditFile)}.mjs`);
  fs.writeFileSync(file, `#!${process.execPath}
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const args = process.argv.slice(2);
if (args[0] === 'login' || args[0] === 'auth') {
  console.log(${JSON.stringify(provider === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }))});
  process.exit(0);
}
for await (const chunk of process.stdin) {}
let config;
if (${JSON.stringify(provider)} === 'claude') config = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.swarm;
else {
  const raw = args.find(arg => arg.startsWith('mcp_servers='));
  config = { url: JSON.parse(/url=("(?:[^"\\\\]|\\\\.)*")/.exec(raw)[1]), headers: { Authorization: JSON.parse(/Authorization=("(?:[^"\\\\]|\\\\.)*")/.exec(raw)[1]) } };
}
const cases = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureCases)}, 'utf8'));
if (${JSON.stringify(provider)} === 'claude') {
  assert.equal(args[args.indexOf('--allowedTools') + 1], cases.map(tool => 'mcp__swarm__' + tool.name).join(','));
} else {
  assert.ok(args.find(arg => arg.startsWith('mcp_servers=')).includes('enabled_tools=' + JSON.stringify(cases.map(tool => tool.name))));
}
const client = new Client({ name: 'manifest-fixture', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
const listing = await client.listTools();
assert.equal(listing.nextCursor, undefined);
assert.deepEqual(listing.tools, cases.map(({ name, description, parameters }) => ({
  name, description, inputSchema: parameters,
  ...(${JSON.stringify(provider)} === 'claude' ? { _meta: { 'anthropic/maxResultSizeChars': 500000 } } : {}),
})));
const receipts = [];
for (const tool of cases) {
  const result = await client.callTool({ name: tool.name, arguments: tool.arguments });
  assert.notEqual(result.isError, true, tool.name);
  const receipt = JSON.parse(result.content[0].text);
  assert.equal(receipt.name, tool.name);
  assert.deepEqual(receipt.arguments, tool.arguments);
  receipts.push(receipt);
}
await client.close();
fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ names: listing.tools.map(tool => tool.name), calls: receipts.length }) + '\\n');
const output = { text: JSON.stringify(receipts), tool_calls: [] };
if (${JSON.stringify(provider)} === 'codex') {
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(output));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }));
} else console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: output, usage: { input_tokens: 3, output_tokens: 2 } }));
`, { mode: 0o700 });
  return file;
}

for (const provider of ['claude', 'codex'] as const) for (const runtime of ['server', 'bridge'] as const) {
  test(`${provider}/${runtime}: every built-in, app wrapper and custom MCP tool completes a native round trip`, { timeout: 30_000 }, async t => {
    const auditFile = path.join(temp, `${provider}-${runtime}.jsonl`);
    const codexPath = await executable('codex', auditFile), claudePath = await executable('claude', auditFile);
    process.env.SWARM_CLI_CODEX_PATH = codexPath; process.env.SWARM_CLI_CLAUDE_PATH = claudePath;
    selectCli(owner, provider); setCliRuntime(owner, runtime);
    if (runtime === 'bridge') {
      const controller = new AbortController();
      const running = startBridge({ server: base, token: createCliPairing(owner), codexPath, claudePath, signal: controller.signal,
        env: { PATH: process.env.PATH, HOME: temp, CODEX_HOME: path.join(temp, 'personal-codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'personal-claude') } });
      void running.catch(() => {});
      t.after(async () => { controller.abort(); await running; disconnectCli(owner); });
      const deadline = Date.now() + 5000;
      while (!cliStatus(owner).connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(cliStatus(owner).connected, true, 'personal bridge must authenticate before generation');
    }
    const receipts: any[] = [], ids = new Set<string>();
    const expected = new Map(cases.map(tool => [tool.name, tool]));
    const response = await withUsage({ userId: owner, botId: bot.id, kind: 'chat' }, async () => {
      const revision = currentComputerRevision();
      return withNativeTools(owner, async call => {
        assert.deepEqual(attribution(), { userId: owner, botId: bot.id, kind: 'chat' });
        assert.equal(currentComputerRevision(), revision, `${call.name}: computer context lost`);
        assert.equal(ids.has(call.id), false, `${call.name}: duplicate execution`); ids.add(call.id);
        const tool = expected.get(call.name);
        assert.ok(tool, `${call.name}: unexpected tool`);
        assert.deepEqual(call.arguments, tool.arguments);
        assert.equal(tool.validate(call.arguments).valid, true);
        const receipt = { name: call.name, arguments: call.arguments, owner, botId: bot.id, runtime, provider };
        receipts.push(receipt);
        return { output: receipt };
      }, () => cliResponsesClient(owner, provider, 20_000).responses.create({
        input: [{ role: 'user', content: 'Exercise the registered manifest using fixture actions.' }],
        tools: manifest.map(tool => ({ type: 'function', ...tool })),
      }));
    });
    assert.deepEqual(receipts.map(receipt => receipt.name), manifest.map(tool => tool.name));
    assert.deepEqual(JSON.parse(response.output_text), receipts, 'the model receives the result of each action intact');
    assert.equal(response.billing, 'subscription');
    assert.equal(response.usage_status, 'complete');
    const generations = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(generations, [{ names: manifest.map(tool => tool.name), calls: manifest.length }], 'all actions use one generation without replay');
    assert.deepEqual(unexpectedRequests, [], 'no API fallback or unplanned HTTP request');
    t.diagnostic(`${manifest.length} tool definitions and request/result pairs verified`);
  });
}
