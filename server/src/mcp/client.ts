import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { db, now } from '../db.js';
import { canManageServer } from '../settings.js';
import { isConfiguring } from '../bot-setup.js';
import { findMcpTool, getMcpServer, mcpForBot, mcpToolName, type McpServer, type McpTool } from './store.js';

const sessions = new Map<string, { serverId: string; promise: Promise<Client>; touched: number }>();
const CONNECT_MS = 12000;
const CALL_MS = 60000;

function canRunLocal(s: McpServer) {
  const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(s.userId) as { id: string; email: string } | undefined;
  return !!user && canManageServer(user);
}

export function mcpError(error: unknown, s: McpServer) {
  let text = error instanceof Error ? error.message : String(error);
  const secrets = [s.config.bearerToken, ...Object.values(s.config.headers), ...Object.values(s.config.env)];
  try { secrets.push(...new URL(s.config.url).searchParams.values()); } catch { /* local */ }
  for (const value of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) text = text.split(value).join('[redacted]');
  return text.slice(0, 700);
}

async function connect(s: McpServer): Promise<Client> {
  const c = s.config;
  if (c.transport === 'stdio' && !canRunLocal(s)) throw new Error('Only the server owner can run a local MCP command.');
  const headers = new Headers(c.headers);
  if (c.bearerToken) headers.set('Authorization', `Bearer ${c.bearerToken}`);
  const requestInit = { headers, redirect: 'error' as const };
  const remoteFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== new URL(c.url).origin) throw new Error('The MCP server redirected to a different origin. Use its direct URL.');
    return fetch(input, { ...init, redirect: 'error' });
  };
  const transport = c.transport === 'stdio'
    ? new StdioClientTransport({ command: c.command, args: c.args, cwd: c.cwd || undefined, env: { ...getDefaultEnvironment(), ...c.env }, stderr: 'ignore' })
    : c.transport === 'sse'
      ? new SSEClientTransport(new URL(c.url), { requestInit, fetch: remoteFetch, eventSourceInit: { fetch: (url, init) => remoteFetch(url, { ...init, headers }) } })
      : new StreamableHTTPClientTransport(new URL(c.url), { requestInit, fetch: remoteFetch });
  const client = new Client({ name: 'grokbot', version: '1.0.0' }, { capabilities: {} });
  // Limit the handshake as well as the JSON-RPC request (a hung HTTP endpoint can
  // otherwise block transport.start before the SDK's request timeout begins).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport, { timeout: CONNECT_MS }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP connection timed out. Check the address or command.')), CONNECT_MS); }),
    ]);
    return client;
  } catch (error) { await client.close().catch(() => {}); throw new Error(mcpError(error, s)); }
  finally { clearTimeout(timer); }
}

export async function closeMcpSessions(serverId?: string) {
  const closing: Promise<unknown>[] = [];
  for (const [key, session] of sessions) {
    if (!serverId || session.serverId === serverId) {
      sessions.delete(key);
      closing.push(session.promise.then(c => c.close()).catch(() => {}));
    }
  }
  await Promise.all(closing);
}
const idle = setInterval(() => {
  for (const [key, s] of sessions) if (now()-s.touched > 5*60_000) {
    sessions.delete(key); void s.promise.then(c => c.close()).catch(() => {});
  }
}, 60_000);
idle.unref();

async function sessionFor(s: McpServer, botId: string) {
  const key = `${s.id}:${s.revision}:${botId}`;
  let session = sessions.get(key);
  if (!session) {
    const promise = connect(s);
    session = { serverId: s.id, promise, touched: now() };
    sessions.set(key, session);
    promise.then(client => {
      client.onclose = () => { if (sessions.get(key)?.promise === promise) sessions.delete(key); };
    }).catch(() => { if (sessions.get(key)?.promise === promise) sessions.delete(key); });
  }
  session.touched = now();
  return session.promise;
}

export async function testMcpServer(s: McpServer) {
  let client: Client | undefined;
  try {
    client = await connect(s);
    const tools: McpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_MS });
      for (const tool of result.tools) if (!tools.some(t => t.name === tool.name)) tools.push(tool);
      if (tools.length > 200) throw new Error('This server exposes over 200 tools. Configure a smaller tool set on the MCP server.');
      cursor = result.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('The MCP server returned invalid tool pagination.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    db.prepare('UPDATE mcp_servers SET tools=?, checked_at=?, error=NULL WHERE id=? AND revision=?').run(JSON.stringify(tools), now(), s.id, s.revision);
  } catch (error) {
    db.prepare('UPDATE mcp_servers SET checked_at=?, error=? WHERE id=? AND revision=?').run(now(), mcpError(error, s), s.id, s.revision);
  } finally { await client?.close().catch(() => {}); }
  return getMcpServer(s.userId, s.id);
}

export function mcpSchemas(userId: string, botId: string) {
  if (isConfiguring(botId)) return [];
  return mcpForBot(userId, botId).flatMap(server => server.tools.map(tool => ({
    type: 'function' as const, name: mcpToolName(server, tool.name),
    description: `${server.config.name}: ${tool.description || tool.name}`.slice(0, 6000),
    parameters: tool.inputSchema, strict: false,
  })));
}

export async function runMcpTool(userId: string, botId: string, name: string, args: Record<string, unknown>) {
  if (isConfiguring(botId)) throw new Error('Complete agent setup first.');
  const match = findMcpTool(userId, name, botId);
  if (!match) throw new Error('This MCP tool is no longer enabled for this agent. Check Settings → MCP servers.');
  const { server, tool } = match;
  try {
    const client = await sessionFor(server, botId);
    // Recheck after connecting: the user may have disabled or edited the server.
    if (!findMcpTool(userId, name, botId)) throw new Error('This MCP tool is no longer enabled for this agent.');
    const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: CALL_MS });
    if (result.isError) throw new Error(JSON.stringify(result.content ?? result.structuredContent ?? 'MCP tool failed'));
    const content: any[] = [];
    let remaining = 60000;
    for (const block of (Array.isArray(result.content) ? result.content : [])) {
      if (block.type === 'image' && typeof block.data === 'string' && block.data.length <= 4_000_000 && /^image\/(png|jpeg|webp|gif)$/.test(String(block.mimeType))) {
        if (content.filter(c => c.type === 'input_image').length < 3) content.push({ type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}` });
      } else if (remaining > 0) {
        const text = block.type === 'text' ? String(block.text) : JSON.stringify(block);
        content.push({ type: 'input_text', text: text.slice(0, remaining) }); remaining -= text.length;
      }
    }
    if (result.structuredContent && remaining > 0) content.push({ type: 'input_text', text: JSON.stringify(result.structuredContent).slice(0, remaining) });
    return { output: content.length ? content : 'Tool completed without content.', summary: `${server.config.name}: ${tool.name}` };
  } catch (error) { throw new Error(mcpError(error, server)); }
}
