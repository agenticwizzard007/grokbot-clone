import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../db.js';
import { requireUser, requireRecentAuth, recentlyAuthenticated, userFromCookieHeader, sessionHash, sessionFromCookie, type AuthVars } from '../lib/auth.js';
import { beginMcpOAuth, finishMcpOAuth } from './oauth.js';
import { listMcpFolders } from './folders.js';
import type { Context } from 'hono';
import { closeMcpSessions, testMcpServer } from './client.js';
import { getMcpServer, listMcpServers, mcpServerView, saveMcpServer } from './store.js';

export const mcpApi = new Hono<AuthVars>();
mcpApi.use('*', requireUser);
mcpApi.use('*', bodyLimit({ maxSize: 256 * 1024 }));
function currentSession(c: Context<AuthVars>) {
  return userFromCookieHeader(c.req.header('cookie'))?.id === c.get('user').id;
}
function sensitiveChange(input: unknown) {
  return !!input && typeof input === 'object' && ['bearerToken', 'headers', 'env', 'folders'].some(key => (input as Record<string, unknown>)[key] !== undefined);
}
mcpApi.get('/folders', c => {
  try { return c.json(listMcpFolders(c.get('user').id, c.req.query('path'), c.req.query('after'))); }
  catch { return c.json({ error: 'Folder not found or too large to browse.' }, 404); }
});
mcpApi.get('/oauth/callback', async c => {
  try {
    const id = await finishMcpOAuth(c.get('user').id, sessionHash(sessionFromCookie(c.req.header('cookie')) ?? ''), c.req.query('state') ?? '', c.req.query('code') ?? '');
    await closeMcpSessions(id);
    return c.html('<!doctype html><meta charset="utf-8"><title>MCP connected</title><p>MCP connected. Return to Swarm.</p>');
  } catch { return c.json({ error: 'MCP authorization expired or failed. Start again from Settings.' }, 400); }
});
mcpApi.post('/:id/oauth', requireRecentAuth, async c => {
  const s = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!s) return c.json({ error: 'MCP server not found.' }, 404);
  try { return c.json(await beginMcpOAuth(s, sessionHash(sessionFromCookie(c.req.header('cookie')) ?? ''))); }
  catch { return c.json({ error: 'Could not start MCP authorization. Check the endpoint and its OAuth support.' }, 400); }
});
mcpApi.get('/', c => c.json({ servers: listMcpServers(c.get('user').id).map(mcpServerView), canManage: true }));

mcpApi.post('/', async c => {
  try {
    const input = await c.req.json();
    if (!currentSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    if (sensitiveChange(input) && !recentlyAuthenticated(c)) return c.json({ error: 'Sign in again to change credentials or folder access.', code: 'reauth_required' }, 401);
    const server = saveMcpServer(c.get('user').id, input);
    return c.json({ server: mcpServerView(server) }, 201);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Invalid MCP configuration.' }, 400); }
});
mcpApi.patch('/:id', async c => {
  const server = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!server) return c.json({ error: 'MCP server not found.' }, 404);
  try {
    const input = await c.req.json();
    if (!currentSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    if (sensitiveChange(input) && !recentlyAuthenticated(c)) return c.json({ error: 'Sign in again to change credentials or folder access.', code: 'reauth_required' }, 401);
    const updated = saveMcpServer(server.userId, input, server);
    await closeMcpSessions(server.id);
    return c.json({ server: mcpServerView(updated) });
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Invalid MCP configuration.' }, 400); }
});
mcpApi.post('/:id/test', async c => {
  const server = getMcpServer(c.get('user').id, c.req.param('id'));
  if (!server) return c.json({ error: 'MCP server not found.' }, 404);
  await closeMcpSessions(server.id);
  if (!currentSession(c)) return c.json({ error: 'unauthenticated' }, 401);
  if (getMcpServer(server.userId, server.id)?.revision !== server.revision) return c.json({ error: 'MCP configuration changed. Test again.' }, 409);
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
