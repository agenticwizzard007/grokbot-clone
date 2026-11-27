import { db } from '../db.js';
import { listMcpServers } from '../mcp/store.js';
import { storedSuggestions } from '../suggestion-store.js';
import { hub } from '../lib/hub.js';
import { transactionWithEffects } from '../lib/commit-effects.js';
import { assertTenant } from '../deployment.js';
import { buildFlowModel, flowInputsHash, type FlowInputs } from './build.js';
import type { FlowModel } from './model-types.js';
import type { FlowSummaryInput } from '../handoffs/contracts.js';

// Only flow-owned storage is initialized here. HO-B owns the remaining handoff DDL.
db.exec(`CREATE TABLE IF NOT EXISTS bot_flow_cache (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, inputs_hash TEXT NOT NULL,
 model_json TEXT NOT NULL, version INTEGER NOT NULL, agent_steps_json TEXT, agent_steps_hash TEXT, updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS flow_connection_snapshots (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS flow_refresh_requests (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, requested_at INTEGER NOT NULL);`);
export class FlowError extends Error {
  constructor(public code: string, message: string, public status: 404 | 409 | 422 | 429 | 503 = 422) { super(message); }
}
export const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function assertFlowEnabled(userId: string) {
  assertTenant(userId);
  if (process.env.HANDOFFS_DISABLED === '1' || (hasTable('handoff_user_settings') && (db.prepare('SELECT enabled FROM handoff_user_settings WHERE user_id=?').get(userId) as { enabled: number } | undefined)?.enabled === 0)) throw new FlowError('disabled', 'Agent flow is unavailable.', 503);
}
export function ownFlowBot(userId: string, botId: string) {
  assertFlowEnabled(userId);
  const bot = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(botId, userId) as { id: string; name: string; instructions: string; avatar_shape: string; avatar_color: string; kind?: string; hidden?: number; suggestions_snapshot?: string } | undefined;
  if (!bot || bot.kind === 'room' || bot.hidden) throw new FlowError('not_found', 'Agent not found.', 404);
  return bot;
}
const parse = <T>(raw: string | undefined | null, fallback: T): T => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

/** The connection reader already talks to providers. Its caller records only public display facts here.
 * This hook performs no provider IO and is never an authorization source. */
export function recordFlowConnections(userId: string, apps: FlowInputs['apps']) {
  assertTenant(userId);
  const snapshot = JSON.stringify(apps.map(a => ({ id: a.id, name: a.name, attention: !!a.attention })).sort((a,b) => a.id.localeCompare(b.id)));
  transactionWithEffects(() => {
    const previous = db.prepare('SELECT snapshot FROM flow_connection_snapshots WHERE user_id=?').get(userId) as { snapshot: string } | undefined;
    if (snapshot === previous?.snapshot) return;
    db.prepare('INSERT INTO flow_connection_snapshots VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET snapshot=excluded.snapshot').run(userId, snapshot);
    for (const bot of db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[]) touchFlow(bot.id);
  });
}

/** All input readers are local and run inside the caller's single read/write transaction. */
export function readFlowInputs(userId: string, botId: string): FlowInputs {
  const bot = ownFlowBot(userId, botId);
  const skills = (db.prepare('SELECT * FROM skills WHERE bot_id=?').all(botId) as { id: string; name: string; body: string; deleted_at?: number }[]).filter(s => !s.deleted_at).map(({id,name,body}) => ({id,name,body}));
  const routines = (db.prepare('SELECT * FROM routines WHERE bot_id=?').all(botId) as { id: string; name: string; schedule: string; enabled: number; created_at: number; trigger_id?: string }[]).map(r => ({ id: r.id, name: r.name, schedule: r.schedule, enabled: !!r.enabled, createdAt: r.created_at, event: !!r.trigger_id }));
  const connection = db.prepare('SELECT snapshot FROM flow_connection_snapshots WHERE user_id=?').get(userId) as { snapshot: string } | undefined;
  const apps = parse<FlowInputs['apps']>(connection?.snapshot, []);
  const mcp = listMcpServers(userId).filter(m => m.config.botIds === null || m.config.botIds.includes(botId)).map(m => ({ id: m.id, name: m.config.name, enabled: m.config.enabled, attention: !!m.error }));
  const suggestions: FlowInputs['suggestions'] = (storedSuggestions(bot.suggestions_snapshot)?.suggestions ?? []).filter(s => !s.noAuth && !apps.some(a => a.id === s.slug)).map(s => ({ id: s.slug, name: s.name, kind: 'app' }));
  const knowledge = (db.prepare('SELECT * FROM memories WHERE bot_id=?').all(botId) as { status?: string }[]).filter(m => !m.status || m.status === 'active').length;
  const brief = parse<{ purpose?: string; success_criteria?: string[] }>((db.prepare('SELECT brief FROM bot_setups WHERE bot_id=?').get(botId) as { brief: string } | undefined)?.brief, {});
  let files = 0, reports = 0;
  if (hasTable('run_outputs')) {
    const rows = db.prepare("SELECT manifest FROM run_outputs WHERE user_id=? AND bot_id=? AND status='final' ORDER BY created_at DESC,id DESC LIMIT 20").all(userId, botId) as { manifest: string }[];
    for (const row of rows) for (const part of parse<{ kind: string; filename?: string }[]>(row.manifest, [])) if (part.kind === 'file') { files++; if (/\.(pdf|md|html|csv)$/i.test(part.filename ?? '')) reports++; }
  }
  if (hasTable('output_artifacts') && !files) {
    const rows = db.prepare('SELECT filename FROM output_artifacts WHERE user_id=? AND bot_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(userId, botId) as { filename: string }[];
    files = rows.length; reports = rows.filter(r => /\.(pdf|md|html|csv)$/i.test(r.filename)).length;
  }
  const channels = ['chat'];
  if (hasTable('messaging_links')) for (const row of db.prepare("SELECT channel FROM messaging_links WHERE user_id=? AND status='connected'").all(userId) as { channel: string }[]) channels.push(({ imessage: 'iMessage', sms: 'SMS', whatsapp: 'WhatsApp' })[row.channel] ?? row.channel);
  const links: FlowInputs['links'] = hasTable('handoff_links') ? (db.prepare('SELECT l.*,b.name,b.hidden,b.kind FROM handoff_links l JOIN bots b ON b.id=CASE WHEN l.from_bot_id=? THEN l.to_bot_id ELSE l.from_bot_id END AND b.user_id=l.user_id WHERE l.user_id=? AND (l.from_bot_id=? OR l.to_bot_id=?)').all(botId, userId, botId, botId) as { id: string; from_bot_id: string; to_bot_id: string; name: string; mode: 'off'|'suggest'|'auto'; hidden?: number; kind?: string; trigger: string; template: string; auto_approve_loops: number }[]).filter(l => !l.hidden && l.kind !== 'room').map(l => ({ id: l.id, fromBotId: l.from_bot_id, toBotId: l.to_bot_id, name: l.name, mode: l.mode, trigger: l.trigger, template: l.template, autoApproveLoops: !!l.auto_approve_loops })) : [];
  const loops: FlowInputs['loops'] = hasTable('loops') ? (db.prepare("SELECT id,name,spec FROM loops WHERE user_id=? AND status IN ('draft','awaiting_approval','running','paused')").all(userId) as { id: string; name: string; spec: string }[]).filter(l => parse<{ steps?: { botId: string }[] }>(l.spec, {}).steps?.some(s => s.botId === botId)).map(l => ({ id: l.id, name: l.name })) : [];
  const inbound = hasTable('handoffs') && !!db.prepare('SELECT 1 FROM handoffs WHERE user_id=? AND to_bot_id=? LIMIT 1').get(userId, botId);
  return { bot: { id: bot.id, name: bot.name, avatar: `${bot.avatar_shape}:${bot.avatar_color}`, instructions: bot.instructions }, skills, routines, apps, mcp, suggestions, knowledge, outputs: { files, reports, tasks: (db.prepare('SELECT count(*) n FROM tasks WHERE bot_id=?').get(botId) as { n: number }).n, channels, purpose: brief.success_criteria?.[0] ?? '' }, links, loops, inbound, connectionsKnown: !!connection };
}
export interface CacheRow { inputs_hash: string; model_json: string; version: number; agent_steps_json: string | null; agent_steps_hash: string | null }
export function getFlow(userId: string, botId: string): FlowModel {
  return transactionWithEffects(() => {
    const input = readFlowInputs(userId, botId), hash = flowInputsHash(input);
    const cached = db.prepare('SELECT * FROM bot_flow_cache WHERE bot_id=?').get(botId) as CacheRow | undefined;
    if (cached?.inputs_hash === hash && cached.model_json) return JSON.parse(cached.model_json);
    const model = buildFlowModel(input, { version: (cached?.version ?? 0) + 1, generatedAt: Date.now(), summary: parse<FlowSummaryInput | undefined>(cached?.agent_steps_json, undefined), summaryHash: cached?.agent_steps_hash ?? undefined });
    db.prepare('INSERT INTO bot_flow_cache(bot_id,inputs_hash,model_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET inputs_hash=excluded.inputs_hash,model_json=excluded.model_json,version=excluded.version,updated_at=excluded.updated_at').run(botId, hash, JSON.stringify(model), model.version, model.generatedAt);
    hub.emit(userId, { type: 'flow', botId, version: model.version });
    return model;
  });
}
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Writers may call this after a change; hash comparison remains the correctness boundary. */
export function touchFlow(botId: string) {
  clearTimeout(pending.get(botId));
  const timer = setTimeout(() => {
    pending.delete(botId);
    const row = db.prepare('SELECT b.user_id,coalesce(c.version,0) version FROM bots b LEFT JOIN bot_flow_cache c ON c.bot_id=b.id WHERE b.id=?').get(botId) as { user_id: string; version: number } | undefined;
    if (row) hub.emit(row.user_id, { type: 'flow', botId, version: row.version });
  }, 500);
  timer.unref(); pending.set(botId, timer);
}
