import { db } from '../db.js';
import crypto from 'node:crypto';
import { KnowledgeError, ownedBot } from './common.js';

export interface MessageRef { botId: string; generation: number; seq: number; contentHash?: string; kind?: 'tool' }
export interface MessageEvidence extends MessageRef { role: string; text: string; from?: { kind: string; id: string; name: string }; createdAt: number; archived: boolean; sourceKey: string }
export function isHumanUserMessage(body: any): boolean {
  return body?.role === 'user' && (!body.from || ['voice', 'imessage', 'sms', 'whatsapp'].includes(body.from.kind));
}
const sourceKey = (s: MessageRef) => `${s.botId}:${s.generation}:${s.seq}`;
function shape(row: any, generation: number): MessageEvidence {
  const body = JSON.parse(row.body);
  const ref = { botId: row.bot_id, generation: row.generation, seq: row.seq, ...(body.type==='tool-call'?{kind:'tool' as const}:{}), contentHash: crypto.createHash('sha256').update(row.body).digest('hex') };
  return { ...ref, sourceKey: sourceKey(ref), role: body.type==='tool-call'?'tool':body.role, ...(body.from ? { from: body.from } : {}), text: String(body.type==='tool-call'?body.summary:body.text).slice(0, 4000), createdAt: row.created_at, archived: row.generation !== generation };
}
export function validateEvidence(userId: string, botId: string, refs: unknown, required = true): MessageEvidence[] {
  const bot = ownedBot(userId, botId);
  if (!Array.isArray(refs) || refs.length > 12 || (required && !refs.length)) throw new KnowledgeError('Provide 1–12 source messages', 422);
  const seen = new Set<string>();
  return refs.map((s: any) => {
    if (!s || s.kind!==undefined&&s.kind!=='tool' || s.botId !== botId || !Number.isSafeInteger(s.generation) || s.generation < 1 || !Number.isSafeInteger(s.seq) || s.seq < 1) throw new KnowledgeError('Invalid source message', 422);
    const row = db.prepare("SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=? AND kind=?").get(botId, s.generation, s.seq,s.kind==='tool'?'tool-call':'message') as any;
    let body: any; try { body = row && JSON.parse(row.body); } catch { /* invalid source */ }
    if (!body || (s.kind==='tool' ? body.type!=='tool-call'||body.status!=='done'||typeof body.summary!=='string'||!body.summary.trim() : body.type !== 'message' || body.streaming || typeof body.text !== 'string' || !body.text.trim())) throw new KnowledgeError('Source message is unavailable or unfinished', 422);
    const result = shape(row, bot.generation);
    if (s.contentHash !== undefined && s.contentHash !== result.contentHash) throw new KnowledgeError('Source message changed; refresh the evidence', 409);
    return result;
  }).filter(s => { const key = sourceKey(s); if (seen.has(key)) return false; seen.add(key); return true; });
}
export function refsOnly(refs: MessageRef[]): MessageRef[] { return refs.map(({ botId, generation, seq, contentHash,kind }) => ({ botId, generation, seq, ...(kind?{kind}:{}), ...(contentHash ? { contentHash } : {}) })); }

const GROUNDING_STOP = new Set('a an the i me my user users he she they his her their is are am at in on to of for that this remember prefers prefer'.split(' '));
function groundingWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !GROUNDING_STOP.has(w)).map(w => w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}
/** Compatibility for older text-only callers: attach a source only when one
 * unique real user message contains all distinctive fact words. This never
 * attaches an arbitrary recent transcript or an assistant-authored assertion. */
export function inferUserEvidence(text: string, candidates: { ref: MessageRef; text: string }[]): MessageRef[] {
  const terms = groundingWords(text);
  if (terms.size < 2) return [];
  const hits = candidates.filter(c => {
    const source = groundingWords(c.text);
    // A positive fact must never be inferred from a negated user statement.
    const neg = /\b(not|never|no|don't|doesn't|isn't|cannot|can't)\b/i;
    return neg.test(text) === neg.test(c.text) && [...terms].every(w => source.has(w));
  });
  return hits.length === 1 ? [hits[0].ref] : [];
}
export function inferCurrentUserEvidence(userId: string, botId: string, text: string): MessageRef[] {
  const bot = ownedBot(userId, botId);
  const rows = db.prepare(`SELECT * FROM rows WHERE bot_id=? AND generation=? AND kind='message'
    AND json_valid(body) AND json_extract(body,'$.role')='user' AND coalesce(json_extract(body,'$.from.kind'),'') IN ('','voice','imessage','sms','whatsapp')
    AND coalesce(json_extract(body,'$.streaming'),0)=0 ORDER BY seq DESC LIMIT 30`).all(botId, bot.generation) as any[];
  return inferUserEvidence(text, rows.map(r => ({ ref: refsOnly([shape(r, bot.generation)])[0], text: JSON.parse(r.body).text ?? '' })));
}

// Port of Hermes hermes_state_search.py:194-198 (_quote_fts_tokens), revision
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898, MIT. Every token is quoted here:
// model/user text is never allowed to become FTS operators or SQL syntax.
export function quoteSearch(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 24).map(t => `"${t.replaceAll('"', '""')}"`).join(' AND ');
}
export function searchMessages(userId: string, botId: string, query = '', opts: { limit?: number; generation?: number; role?: string; offset?: number } = {}) {
  const bot = ownedBot(userId, botId);
  const limit = Math.max(1, Math.min(30, Number.isSafeInteger(opts.limit) ? opts.limit! : 10));
  const offset = Math.max(0, Math.min(10000, Number.isSafeInteger(opts.offset) ? opts.offset! : 0));
  if (typeof query !== 'string' || query.length > 500) throw new KnowledgeError('Search query must be at most 500 characters');
  const terms = quoteSearch(query);
  if (query.trim() && !terms) return { messages: [], nextOffset: null };
  const where = ['r.bot_id=?', 'b.user_id=?']; const args: any[] = [botId, userId];
  if (opts.generation !== undefined) { if (!Number.isSafeInteger(opts.generation) || opts.generation < 1) throw new KnowledgeError('Invalid generation'); where.push('r.generation=?'); args.push(opts.generation); }
  if (opts.role !== undefined) { if (!['user', 'assistant'].includes(opts.role)) throw new KnowledgeError('Invalid role'); where.push("json_extract(r.body,'$.role')=?"); args.push(opts.role); }
  if (terms) { where.push('knowledge_messages_fts MATCH ?'); args.push(terms); }
  const rows = db.prepare(`SELECT r.* FROM knowledge_messages_fts f JOIN rows r ON r.rowid=f.rowid JOIN bots b ON b.id=r.bot_id
    WHERE ${where.join(' AND ')} ORDER BY ${terms ? 'bm25(knowledge_messages_fts),' : ''} r.created_at DESC,r.generation DESC,r.seq DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as any[];
  return { messages: rows.slice(0, limit).map(r => shape(r, bot.generation)), nextOffset: rows.length > limit ? offset + limit : null };
}
// Port of Hermes tools/session_search_tool.py:447-463,531-575: bounded original
// messages and stable anchors, without a summarization model or Python runtime.
export function readMessageWindow(userId: string, botId: string, ref: MessageRef, window = 3): MessageEvidence[] {
  const bot = ownedBot(userId, botId); validateEvidence(userId, botId, [ref]);
  const n = Math.max(0, Math.min(10, Number.isSafeInteger(window) ? window : 3));
  return (db.prepare(`SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq BETWEEN ? AND ? AND kind IN ('message','tool-call')
    AND json_valid(body) AND (json_extract(body,'$.type')='message' AND coalesce(json_extract(body,'$.streaming'),0)=0 OR json_extract(body,'$.type')='tool-call' AND json_extract(body,'$.status')='done') ORDER BY seq LIMIT 21`)
    .all(botId, ref.generation, ref.seq - n, ref.seq + n) as any[]).map(r => shape(r, bot.generation));
}
