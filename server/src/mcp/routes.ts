import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../db.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { canManageServer } from '../settings.js';
import { env } from '../env.js';
import { closeMcpSessions, testMcpServer } from './client.js';
import { getMcpServer, listMcpServers, mcpServerView, saveMcpServer } from './store.js';

export const mcpApi = new Hono<AuthVars>();
mcpApi.use('*', requireUser);
mcpApi.use('*', bodyLimit({ maxSize: 256 * 1024 }));
mcpApi.get('/', c => c.json({ servers: listMcpServers(c.get('user').id).map(mcpServerView), canManage: canManageServer(c.get('user')) }));

// Custom connections reach the server's network and local processes, like its
// API keys and computer controls, so configuration belongs to the server owner.
mcpApi.use('*', async (c, next) => {
  if (!canManageServer(c.get('user'))) return c.json({ error: 'Only the server owner can configure custom MCP servers.' }, 403);
  const origin = c.req.header('Origin');
  // The preview terminates HTTPS before forwarding to this HTTP server. Accept
  // the configured public app origins without trusting arbitrary proxy headers.
  const origins = [c.req.url, env.appUrl, env.serverUrl].map(url => new URL(url).origin);
  if (origin && !origins.includes(origin)) return c.json({ error: 'Invalid request origin.' }, 403);
  await next();
});
mcpApi.post('/', async c => {
  try {
    const server = saveMcpServer(c.get('user').id, await c.req.json());
    return c.json({ server: mcpServerView(server) }, 201);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Invalid MCP configuration.' }, 400); }
});
mcpApi.patch('/:id', async c => {
  const server = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!server) return c.json({ error: 'MCP server not found.' }, 404);
  try {
    const updated = saveMcpServer(server.userId, await c.req.json(), server);
    await closeMcpSessions(server.id);
    return c.json({ server: mcpServerView(updated) });
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Invalid MCP configuration.' }, 400); }
});
mcpApi.post('/:id/test', async c => {
  const server = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!server) return c.json({ error: 'MCP server not found.' }, 404);
  await closeMcpSessions(server.id);
  const result = await testMcpServer(server);
  return result ? c.json({ server: mcpServerView(result) }) : c.json({ error: 'MCP server was removed.' }, 404);
});
mcpApi.delete('/:id', async c => {
  const server = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!server) return c.json({ error: 'MCP server not found.' }, 404);
  db.prepare('DELETE FROM mcp_servers WHERE id=? AND user_id=?').run(server.id, server.userId);
  await closeMcpSessions(server.id);
  return c.json({ ok: true });
});
