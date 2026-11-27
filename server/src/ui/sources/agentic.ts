import { db } from '../../db.js';
import { listMcpServers } from '../../mcp/store.js';
import type { Params, SourceData } from './catalog.js';

export const AGENTIC_SOURCES = ['handoffs.list', 'loops.list', 'outputs.recent', 'connectors.status', 'email.recent', 'calendar.upcoming', 'crm.deals'];
const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const unavailable = (): SourceData => ({ available: false, rows: [], count: 0 });
/** No provider calls, message bodies, output bodies, credentials or MCP tool execution. */
export function agenticSource(id: string, userId: string, params: Params): SourceData {
  const limit = Math.min(10, Number(params.limit ?? 10));
  if (id === 'connectors.status') {
    const connections = listMcpServers(userId).map(s => ({ id: s.id, label: s.config.name, connected: s.config.enabled && s.checkedAt !== null && !s.error }));
    return { rows: connections.slice(0, limit), count: connections.length, available: connections.length > 0 };
  }
  // Connected-app credentials and sessions are not a safe data cache. Do not call
  // generic MCP/Composio tools based on their name or a claimed read-only flag.
  if (['email.recent', 'calendar.upcoming', 'crm.deals'].includes(id)) return unavailable();
  let sql: string, args: (string | number)[] = [userId];
  if (id === 'handoffs.list') {
    if (!exists('handoffs')) return unavailable();
    sql = `SELECT h.id,o.title,f.name AS fromBot,t.name AS toBot,h.status AS state,h.updated_at AS updatedAt
      FROM handoffs h JOIN bots f ON f.id=h.from_bot_id AND f.user_id=h.user_id
      JOIN bots t ON t.id=h.to_bot_id AND t.user_id=h.user_id
      JOIN run_outputs o ON o.id=h.source_output_id AND o.user_id=h.user_id WHERE h.user_id=?`;
    if (params.botId) { sql += ' AND (h.from_bot_id=? OR h.to_bot_id=?)'; args.push(params.botId, params.botId); }
  } else if (id === 'loops.list') {
    if (!exists('loops')) return unavailable();
    sql = `SELECT l.id,l.name,l.status AS state,l.iteration AS round,l.updated_at AS updatedAt
      FROM loops l JOIN bots b ON b.id=l.owner_bot_id AND b.user_id=l.user_id WHERE l.user_id=?`;
  } else {
    if (!exists('run_outputs')) return unavailable();
    sql = `SELECT o.id,o.title,b.name AS botName,o.source AS kind,o.created_at AS createdAt
      FROM run_outputs o JOIN bots b ON b.id=o.bot_id AND b.user_id=o.user_id WHERE o.user_id=? AND o.status='final'`;
    if (params.botId) { sql += ' AND o.bot_id=?'; args.push(params.botId); }
  }
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args) as { n: number }).n;
  return { count, available: true, rows: db.prepare(`${sql} ORDER BY ${id === 'outputs.recent' ? 'createdAt' : 'updatedAt'} DESC,id LIMIT ?`).all(...args, limit) as Record<string, unknown>[] };
}
