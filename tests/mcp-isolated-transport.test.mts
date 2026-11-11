import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { McpServer } from '../server/src/mcp/store.js';

const tenantUserId = 'usr_mcp_socket_tenant';
const configuredSocket = '/run/swarm/mcp-transport-test.sock';
Object.assign(process.env, { SWARM_ROLE: 'tenant', SWARM_TENANT_ID: tenantUserId, SWARM_RUNNER_SOCKET: configuredSocket });
const { SandboxMcpTransport } = await import('../server/src/runtime/runner-client.js');
const config: McpServer = {
  id: 'mcp_socket_test', userId: tenantUserId, revision: 4, tools: [], checkedAt: null, error: null,
  config: { name: 'Socket test', transport: 'stdio', command: 'node', args: ['example.mjs'], cwd: '', folders: [],
    url: '', bearerToken: '', headers: {}, env: {}, enabled: true, botIds: [], requireApproval: true, oauth: false },
};

test('isolated MCP uses the configured Unix socket and /mcp route for registration and JSON-RPC', { timeout: 5000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mcp-socket-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const actualSocket = path.join(temp, 'runner.sock');
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  let route: string | undefined;
  const frames: any[] = [];
  wss.on('connection', (ws, request) => {
    route = request.url;
    ws.on('error', () => {});
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      frames.push(message);
      ws.send(JSON.stringify(frames.length === 1 ? { type: 'ready' } : { jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    });
  });
  http.listen(actualSocket);
  await once(http, 'listening');

  // Assert the actual ws destination before redirecting it to a temporary Unix
  // socket, preserving the production /run/swarm allowlist without requiring root.
  const connect = net.connect;
  let connections = 0;
  t.mock.method(net, 'connect', (options: any, ...args: any[]) => {
    connections++;
    assert.equal(options.path, configuredSocket, 'ws must use the Unix socket, not TCP localhost:80');
    return connect({ ...options, path: actualSocket }, ...args);
  });
  const transport = new SandboxMcpTransport(config);
  t.after(() => transport.close());
  await transport.start();
  assert.equal(connections, 1);
  assert.equal(route, '/mcp');
  assert.deepEqual(frames[0], { tenantId: tenantUserId, id: config.id, revision: config.revision, config: config.config });

  const response = new Promise(resolve => { transport.onmessage = resolve; });
  const request = { jsonrpc: '2.0' as const, id: 7, method: 'tools/list' };
  await transport.send(request);
  assert.deepEqual(await response, { jsonrpc: '2.0', id: 7, result: { tools: [] } });
  assert.deepEqual(frames[1], request);
  await transport.close();
  await assert.rejects(transport.send(request), /offline/);
  await assert.rejects(transport.start(), /revoked/);
});

test('isolated MCP refuses foreign tenants and unapproved socket paths before connecting', async t => {
  let connections = 0;
  t.mock.method(net, 'connect', () => { connections++; throw new Error('Unexpected connection'); });
  assert.throws(() => new SandboxMcpTransport({ ...config, userId: 'usr_foreign_tenant' }), /Tenant identity mismatch/);
  t.after(() => { process.env.SWARM_RUNNER_SOCKET = configuredSocket; });
  for (const socket of ['', '/tmp/runner.sock', 'ws://localhost/mcp']) {
    process.env.SWARM_RUNNER_SOCKET = socket;
    await assert.rejects(new SandboxMcpTransport(config).start(), /Isolated tenant runner is unavailable/);
  }
  assert.equal(connections, 0);
});
