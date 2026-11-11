import { z } from 'zod';
import { db, now } from '../db.js';
import { newId, sha256 } from '../lib/ids.js';
import { sealPrivate, openPrivate } from '../security/secrets.js';
import { publicHttpsUrl } from '../security/network.js';
import { assertTenant } from '../deployment.js';
import type { McpServerView } from '../types.js';
import { mcpFoldersSchema } from '../security/mcp-folders.js';
import { validateMcpFolders } from './folders.js';

db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER, error TEXT, created_at INTEGER NOT NULL
);`);

const strings = z.record(z.string().min(1).max(200), z.string().max(16000));
export const mcpConfigSchema = z.object({
  name: z.string().trim().min(1).max(80),
  transport: z.enum(['http', 'sse', 'stdio']),
  url: z.string().trim().max(4000).default(''),
  command: z.string().trim().max(2000).default(''),
  args: z.array(z.string().max(4000)).max(100).default([]),
  cwd: z.string().trim().max(2000).default(''),
  folders: mcpFoldersSchema,
  bearerToken: z.string().max(16000).default(''),
  headers: strings.default({}),
  env: strings.default({}),
  enabled: z.boolean().default(true),
  botIds: z.array(z.string().max(100)).max(200).nullable().default([]),
  requireApproval: z.boolean().default(true),
  oauth: z.boolean().default(false),
}).strict();
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface McpServer { id: string; userId: string; config: McpConfig; tools: McpTool[]; revision: number; checkedAt: number | null; error: string | null }
const fromRow = (r: any): McpServer => {
  const config = openPrivate<McpConfig>(r.user_id, `mcp:${r.id}`, r.config);
  return { id: r.id, userId: r.user_id, config: { ...config, folders: config.folders ?? [] }, tools: JSON.parse(r.tools), revision: r.revision, checkedAt: r.checked_at, error: r.error };
};
export function getMcpServer(userId: string, id: string) {
  assertTenant(userId);
  const row = db.prepare('SELECT * FROM mcp_servers WHERE user_id=? AND id=?').get(userId, id);
  return row ? fromRow(row) : undefined;
}
export function listMcpServers(userId: string) {
  assertTenant(userId);
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id=? ORDER BY created_at,id').all(userId).map(fromRow);
}
export function mcpServerView(s: McpServer): McpServerView {
  const { bearerToken, headers, env, ...config } = s.config;
  return { ...config, id: s.id, hasBearerToken: !!bearerToken, headerNames: Object.keys(headers), envNames: Object.keys(env), checkedAt: s.checkedAt, error: s.error, tools: s.tools.map(t => ({ name: t.name, description: t.description ?? '', toolName: mcpToolName(s, t.name) })) };
}
export function saveMcpServer(userId: string, input: unknown, previous?: McpServer) {
  assertTenant(userId);
  if (previous && previous.userId !== userId) throw new Error('MCP server not found.');
  if (previous && getMcpServer(userId, previous.id)?.revision !== previous.revision) throw new Error('MCP configuration changed. Reload before saving.');
  const config = mcpConfigSchema.parse(previous ? { ...previous.config, ...(input as object) } : input);
  if (config.transport === 'stdio') {
    if (!config.command || /[\0\r\n]/.test(config.command) || /\0/.test(config.cwd) || config.args.some(a => /\0/.test(a))) throw new Error('Enter an executable and its arguments separately.');
    for (const [key, value] of Object.entries(config.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid environment variable.');
    validateMcpFolders(userId, config.folders);
  } else {
    if (config.folders.length) throw new Error('Folder access is available only for local MCP servers.');
    let url: URL;
    try { url = publicHttpsUrl(config.url); } catch { throw new Error('Enter a valid MCP server URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use an HTTP or HTTPS URL; enter credentials in the authentication fields.');
    if (/[\r\n]/.test(config.bearerToken)) throw new Error('Invalid bearer token.');
    for (const [key, value] of Object.entries(config.headers)) {
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || /[\r\n]/.test(value) || /^(host|content-length|connection|transfer-encoding|mcp-session-id)$/i.test(key)) throw new Error('Invalid custom header.');
    }
  }
  for (const botId of config.botIds ?? []) {
    if (!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId, userId)) throw new Error('Choose agents from your own team.');
  }
  if (!previous && listMcpServers(userId).length >= 20) throw new Error('You can add up to 20 MCP servers.');
  const id = previous?.id ?? newId('mcp');
  // Connection changes invalidate discovered tools and previous approvals.
  const changed = !!previous && JSON.stringify(previous.config) !== JSON.stringify(config);
  if (previous) db.prepare('UPDATE mcp_servers SET config=?, tools=?, revision=?, checked_at=?, error=? WHERE id=? AND user_id=?').run(sealPrivate(userId, `mcp:${id}`, config), JSON.stringify(changed ? [] : previous.tools), previous.revision + Number(changed), changed ? null : previous.checkedAt, changed ? null : previous.error, id, userId);
  else db.prepare('INSERT INTO mcp_servers(id,user_id,config,created_at) VALUES (?,?,?,?)').run(id, userId, sealPrivate(userId, `mcp:${id}`, config), now());
  return getMcpServer(userId, id)!;
}
export const mcpToolName = (server: McpServer, name: string) => `mcp_${sha256(server.id).slice(0, 12)}_${server.revision}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}_${sha256(name).slice(0, 8)}`;
export function mcpForBot(userId: string, botId: string) {
  if (!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId, userId)) return [];
  return listMcpServers(userId).filter(s => s.config.enabled && (s.config.botIds === null || s.config.botIds.includes(botId)));
}
export function findMcpTool(userId: string, name: string, botId?: string) {
  for (const server of botId ? mcpForBot(userId, botId) : listMcpServers(userId).filter(s => s.config.enabled)) {
    const tool = server.tools.find(t => mcpToolName(server, t.name) === name);
    if (tool) return { server, tool };
  }
}

export function migrateMcpSecrets() {
  for (const row of db.prepare("SELECT id,user_id,config FROM mcp_servers WHERE config NOT LIKE 'private1:%'").all() as { id: string; user_id: string; config: string }[]) {
    const config = JSON.parse(row.config);
    db.prepare('UPDATE mcp_servers SET config=?,revision=revision+1,tools=? WHERE id=? AND user_id=?').run(sealPrivate(row.user_id, `mcp:${row.id}`, config), '[]', row.id, row.user_id);
  }
}
migrateMcpSecrets();
