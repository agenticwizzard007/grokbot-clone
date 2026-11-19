import '../agent/jobs.js';
import { db } from '../db.js';
import { sha256 } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { legacyWorkHeld } from '../security/legacy-work.js';
import { publishNativeEvent, readNativeCursor, advanceNativeCursor } from '../native/events.js';

const consumer = 'coordination-human-reviewed';
const humanKinds = new Set(['human', 'user', 'voice', 'imessage', 'sms', 'whatsapp']);
export function isHumanSource(body: any) {
  return body?.type === 'message' && body.role === 'user' && body.audience !== 'internal'
    && humanKinds.has(body.from?.kind ?? 'human') && typeof body.text === 'string';
}

db.exec(`CREATE TABLE IF NOT EXISTS coordination_source_reads (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
 event_seq INTEGER NOT NULL REFERENCES native_events(seq) ON DELETE CASCADE,
 content_hash TEXT NOT NULL, through_chars INTEGER NOT NULL,
 PRIMARY KEY(job_id,event_seq));
 CREATE INDEX IF NOT EXISTS coordination_source_reads_owner ON coordination_source_reads(user_id,event_seq);
 CREATE INDEX IF NOT EXISTS coordination_source_identity ON native_events(user_id,bot_id,source_id,source_revision)
 WHERE kind IN ('coordination.human_source','coordination.human_history');
 CREATE INDEX IF NOT EXISTS coordination_source_pending ON native_events(user_id,kind,seq);`);

/** Called inside the original transcript transaction. Never stores another copy of user text. */
export function recordHumanSource(userId: string, botId: string, generation: number, seq: number, revision: number, body: unknown, historical = false) {
  if (!isHumanSource(body)) return;
  publishNativeEvent({ userId, botId, kind: historical ? 'coordination.human_history' : 'coordination.human_source', sourceType: 'message',
    sourceId: `${generation}:${seq}`, sourceRevision: revision,
    data: { generation, seq, contentHash: sha256((body as any).text) } });
}

/** Index retained history without pretending it is a newly issued instruction. */
export function backfillHumanSources() {
  for (const owner of db.prepare('SELECT id FROM users').all() as {id:string}[]) {
    if (legacyWorkHeld(owner.id)) continue;
    const rows = db.prepare(`SELECT r.*,b.user_id FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.kind='message'
      AND json_extract(r.body,'$.role')='user' AND json_extract(r.body,'$.type')='message'
      AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'
      AND COALESCE(json_extract(r.body,'$.from.kind'),'human') IN ('human','user','voice','imessage','sms','whatsapp')
      AND NOT EXISTS(SELECT 1 FROM native_events e WHERE e.user_id=b.user_id AND e.bot_id=r.bot_id
        AND e.kind IN ('coordination.human_source','coordination.human_history') AND e.source_id=CAST(r.generation AS TEXT)||':'||CAST(r.seq AS TEXT)
        AND e.source_revision=CAST(r.updated_seq AS TEXT)) ORDER BY r.rowid LIMIT 500`).all(owner.id) as any[];
    db.transaction(()=>{for(const r of rows)recordHumanSource(r.user_id,r.bot_id,r.generation,r.seq,r.updated_seq,JSON.parse(r.body),true);})();
  }
}

export function requireCoordinator(userId: string, botId: string) {
  assertTenant(userId);
  const primaries = db.prepare('SELECT id,hidden,parent_bot_id,kind FROM bots WHERE user_id=? AND is_primary=1').all(userId) as any[];
  if (primaries.length !== 1 || primaries[0].id !== botId || primaries[0].hidden || primaries[0].parent_bot_id || primaries[0].kind === 'room') {
    throw new Error('Only the current primary coordinator can inspect team conversation sources.');
  }
}

function sourceRow(userId: string, eventSeq: number) {
  assertTenant(userId);
  const event = db.prepare("SELECT * FROM native_events WHERE user_id=? AND seq=? AND kind IN ('coordination.human_source','coordination.human_history')").get(userId, eventSeq) as any;
  if (!event) throw new Error('Team source not found.');
  const { generation, seq } = JSON.parse(event.data);
  const row = db.prepare(`SELECT r.body,r.updated_seq,b.generation AS current_generation FROM rows r
    JOIN bots b ON b.id=r.bot_id AND b.user_id=? WHERE r.bot_id=? AND r.generation=? AND r.seq=?`).get(userId, event.bot_id, generation, seq) as any;
  const body = row ? JSON.parse(row.body) : null;
  const current = !!row && String(row.updated_seq) === event.source_revision && isHumanSource(body);
  return { event, generation, seq, text: current ? body.text as string : null, contentHash: current ? sha256(body.text) : null };
}

export function humanSourceState(userId: string) {
  assertTenant(userId);
  const reviewedThrough = readNativeCursor(userId, consumer);
  const aggregate = db.prepare("SELECT COUNT(*) total,COALESCE(MAX(seq),0) latest FROM native_events WHERE user_id=? AND kind IN ('coordination.human_source','coordination.human_history')").get(userId) as any;
  const pending = (db.prepare("SELECT COUNT(*) n FROM native_events WHERE user_id=? AND kind='coordination.human_source' AND seq>?").get(userId, reviewedThrough) as any).n;
  return { total: aggregate.total as number, latest: aggregate.latest as number, reviewedThrough, pending: pending as number };
}

/** Stable ordered metadata. Text is available only through the coordinator read boundary. */
export function listHumanSources(userId: string, after = 0, limit = 50, through?: number, pendingOnly = false) {
  assertTenant(userId);
  limit = Math.min(100, Math.max(1, limit));
  const watermark = through ?? humanSourceState(userId).latest;
  const rows = db.prepare(`SELECT seq FROM native_events WHERE user_id=? AND ${pendingOnly ? "kind='coordination.human_source'" : "kind IN ('coordination.human_source','coordination.human_history')"} AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
    .all(userId, after, watermark, Math.min(100, Math.max(1, limit)) + 1) as { seq: number }[];
  const sources = rows.slice(0, limit).map(r => {
    const s = sourceRow(userId, r.seq);
    return { eventSeq: r.seq, botId: s.event.bot_id, generation: s.generation, seq: s.seq,
      revision: s.event.source_revision, contentHash: s.contentHash, recordedAt: s.event.created_at, historical: s.event.kind==='coordination.human_history',
      status: s.text === null ? 'unavailable_or_superseded' : 'available', characters: s.text?.length ?? 0 };
  });
  return { sources, nextCursor: sources.at(-1)?.eventSeq ?? after, through: watermark, hasMore: rows.length > limit };
}

export function readHumanSource(userId: string, botId: string, eventSeq: number, offset = 0, limit = 8000, jobId?: string) {
  requireCoordinator(userId, botId);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error('Invalid source range.');
  const s = sourceRow(userId, eventSeq);
  if (s.text === null) return { eventSeq, status: 'unavailable_or_superseded', text: null, complete: true, nextOffset: null };
  if (offset > s.text.length) throw new Error('Source offset exceeds content length.');
  const end = Math.min(s.text.length, offset + limit);
  if (jobId) {
    const job = db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(jobId, userId, botId);
    if (!job) throw new Error('Source read requires an owned coordinator job.');
    const old = db.prepare('SELECT * FROM coordination_source_reads WHERE job_id=? AND event_seq=?').get(jobId, eventSeq) as any;
    const covered = old?.content_hash === s.contentHash ? old.through_chars : 0;
    const next = offset <= covered ? Math.max(covered, end) : covered;
    db.prepare(`INSERT INTO coordination_source_reads(user_id,job_id,event_seq,content_hash,through_chars) VALUES(?,?,?,?,?)
      ON CONFLICT(job_id,event_seq) DO UPDATE SET content_hash=excluded.content_hash,through_chars=excluded.through_chars`).run(userId, jobId, eventSeq, s.contentHash, next);
  }
  return { eventSeq, status: 'available', source: { botId: s.event.bot_id, generation: s.generation, seq: s.seq, contentHash: s.contentHash },
    text: s.text.slice(offset, end), offset, totalCharacters: s.text.length, complete: end === s.text.length, nextOffset: end < s.text.length ? end : null };
}

/** A successful review acknowledges only contiguous, fully read sources, never omitted input. */
export function settleHumanSources(userId: string, rootJobId: string) {
  const before = readNativeCursor(userId, consumer);
  const jobs = (db.prepare(`WITH RECURSIVE lineage(id) AS (SELECT id FROM agent_jobs WHERE id=? AND user_id=?
    UNION SELECT j.id FROM agent_jobs j JOIN lineage l ON json_extract(j.trigger,'$.parentJobId')=l.id WHERE j.user_id=?) SELECT id FROM lineage`)
    .all(rootJobId, userId, userId) as { id: string }[]).map(r => r.id);
  let after = before;
  for (const r of db.prepare("SELECT seq FROM native_events WHERE user_id=? AND kind='coordination.human_source' AND seq>? ORDER BY seq").all(userId, before) as { seq: number }[]) {
    const s = sourceRow(userId, r.seq);
    if (s.text !== null) {
      const reads = db.prepare('SELECT job_id,through_chars,content_hash FROM coordination_source_reads WHERE user_id=? AND event_seq=?').all(userId, r.seq) as any[];
      if (!reads.some(read => jobs.includes(read.job_id) && read.content_hash === s.contentHash && read.through_chars >= s.text!.length)) break;
    }
    after = r.seq;
  }
  if (after > before) advanceNativeCursor(userId, consumer, before, after);
}
