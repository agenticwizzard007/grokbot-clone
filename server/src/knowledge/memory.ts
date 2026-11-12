import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { boundedText, checkedRun, expectedRevision, KnowledgeError, ownedBot } from './common.js';
import { refsOnly, validateEvidence, type MessageRef } from './sessions.js';

export interface MemoryView { id: string; botId: string; text: string; createdAt: number; source: 'chat' | 'learned'; status: string; revision: number; evidence: MessageRef[]; runId: string | null; supersedes: string | null }
function view(m: any): MemoryView { return { id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at, source: m.source === 'learned' ? 'learned' : 'chat', status: m.status, revision: m.revision, evidence: JSON.parse(m.evidence), runId: m.run_id, supersedes: m.supersedes }; }
function ownMemory(userId: string, id: string): any {
  const m = db.prepare('SELECT m.* FROM memories m JOIN bots b ON b.id=m.bot_id WHERE m.id=? AND b.user_id=?').get(id, userId);
  if (!m) throw new KnowledgeError('Not found', 404);
  return m;
}
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fingerprint = (s: string) => crypto.createHash('sha256').update(normalize(s)).digest('hex');
function similar(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const A = new Set(normalize(a).split(' ').filter(w => w.length > 2)), B = new Set(normalize(b).split(' ').filter(w => w.length > 2));
  const inter = [...A].filter(w => B.has(w)).length;
  return Math.min(A.size, B.size) >= 3 && inter / Math.min(A.size, B.size) >= .8;
}
const key = (s: MessageRef) => `${s.botId}:${s.generation}:${s.seq}`;
function isSuppressed(botId: string, text: string, evidence: MessageRef[], checkSources = true): boolean {
  const refs = new Set(evidence.map(key));
  return (db.prepare('SELECT text,evidence FROM knowledge_memory_suppressions WHERE bot_id=?').all(botId) as any[])
    .some(s => similar(text, s.text) || (checkSources && (JSON.parse(s.evidence) as MessageRef[]).some(r => refs.has(key(r)))));
}
export function listMemories(userId: string, botId: string, includeInactive = false): MemoryView[] {
  ownedBot(userId, botId);
  return (db.prepare(`SELECT * FROM memories WHERE bot_id=? ${includeInactive ? '' : "AND status='active'"} ORDER BY created_at DESC,id DESC LIMIT 1000`).all(botId) as any[]).map(view);
}
function record(m: any, action: string, userId: string) {
  db.prepare('INSERT INTO knowledge_memory_events(memory_id,bot_id,action,snapshot,actor,created_at) VALUES(?,?,?,?,?,?)').run(m.id, m.bot_id, action, JSON.stringify(view(m)), userId, now());
}
function suppress(m: any) {
  db.prepare('INSERT OR IGNORE INTO knowledge_memory_suppressions(bot_id,fingerprint,text,evidence,created_at) VALUES(?,?,?,?,?)').run(m.bot_id, fingerprint(m.text), m.text, m.evidence, now());
}
// Hermes memory write-approval concept (tools/write_approval.py:201-254, MIT,
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898), adapted to native owner-scoped
// sourced facts. Corrections/suppression are Swarm extensions, not Hermes claims.
export function saveMemory(userId: string, botId: string, input: { text: string; evidence: MessageRef[]; source?: 'chat' | 'learned'; runId?: string }): { memory: MemoryView | null; skipped: 'suppressed' | 'duplicate' | null } {
  return db.transaction(() => {
    ownedBot(userId, botId); const text = boundedText(input.text, 'Memory', 1000);
    const evidence = refsOnly(validateEvidence(userId, botId, input.evidence)); const runId = checkedRun(userId, botId, input.runId);
    if (isSuppressed(botId, text, evidence)) return { memory: null, skipped: 'suppressed' as const };
    const existing = listMemories(userId, botId).find(m => similar(m.text, text));
    if (existing) return { memory: existing, skipped: 'duplicate' as const };
    const id = newId('mem');
    db.prepare('INSERT INTO memories(id,bot_id,text,created_at,source,evidence,run_id) VALUES(?,?,?,?,?,?,?)').run(id, botId, text, now(), input.source === 'learned' ? 'learned' : 'chat', JSON.stringify(evidence), runId);
    const m = ownMemory(userId, id); record(m, 'create', userId); return { memory: view(m), skipped: null };
  })();
}
export function correctMemory(userId: string, id: string, input: { text: string; expectedRevision: number; evidence?: MessageRef[]; runId?: string }): MemoryView {
  return db.transaction(() => {
    const cur = ownMemory(userId, id); expectedRevision(cur.revision, input.expectedRevision);
    if (cur.status !== 'active') throw new KnowledgeError('Memory is no longer active', 409);
    const text = boundedText(input.text, 'Correction', 1000);
    if (normalize(text) === normalize(cur.text)) throw new KnowledgeError('Correction must change the fact');
    const evidence = refsOnly(validateEvidence(userId, cur.bot_id, input.evidence ?? [], false));
    const runId = checkedRun(userId, cur.bot_id, input.runId);
    // Explicit owner correction may reuse a source and update similar wording;
    // the old statement is suppressed only after the replacement is validated.
    if ((db.prepare('SELECT text FROM knowledge_memory_suppressions WHERE bot_id=?').all(cur.bot_id) as any[]).some(s => normalize(s.text) === normalize(text))) throw new KnowledgeError('This fact was previously forgotten or superseded', 409);
    suppress(cur);
    db.prepare("UPDATE memories SET status='superseded',revision=revision+1 WHERE id=?").run(id);
    record(ownMemory(userId, id), 'supersede', userId);
    const nextId = newId('mem');
    db.prepare('INSERT INTO memories(id,bot_id,text,created_at,source,evidence,run_id,supersedes) VALUES(?,?,?,?,?,?,?,?)').run(nextId, cur.bot_id, text, now(), 'chat', JSON.stringify(evidence), runId, id);
    const next = ownMemory(userId, nextId); record(next, 'correction', userId); return view(next);
  })();
}
export function forgetMemory(userId: string, id: string, expected?: number): void {
  db.transaction(() => {
    const cur = ownMemory(userId, id);
    if (expected !== undefined) expectedRevision(cur.revision, expected);
    if (cur.status === 'deleted') return;
    // A correction is a chain. Forgetting its replacement suppresses each prior
    // statement too, so archived source messages cannot resurrect any version.
    let node = cur; const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id); suppress(node);
      if (node.id === id) { db.prepare("UPDATE memories SET status='deleted',revision=revision+1 WHERE id=?").run(id); record(ownMemory(userId, id), 'delete', userId); }
      node = node.supersedes ? db.prepare('SELECT * FROM memories WHERE id=? AND bot_id=?').get(node.supersedes, cur.bot_id) : null;
    }
  })();
}
export function memoryHistory(userId: string, id: string) {
  ownMemory(userId, id);
  return (db.prepare('SELECT * FROM knowledge_memory_events WHERE memory_id=? ORDER BY id DESC LIMIT 100').all(id) as any[]).map(e => ({ action: e.action, actor: e.actor, memory: JSON.parse(e.snapshot), createdAt: e.created_at }));
}
export function recallMemories(userId: string, botId: string, query = '', limit = 20): MemoryView[] {
  if (typeof query !== 'string' || query.length > 500) throw new KnowledgeError('Search query must be at most 500 characters');
  const terms = normalize(query).split(' ').filter(Boolean);
  return listMemories(userId, botId).filter(m => terms.every(t => normalize(m.text).includes(t))).slice(0, Math.max(1, Math.min(50, limit)));
}
