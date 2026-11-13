import { hub } from '../lib/hub.js';
import { db, now } from '../db.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen } from '../security/legacy-work.js';

// Native transactional outbox. Producers call inside their canonical mutation's
// transaction; consumers keep independent compare-and-swap checkpoints.
db.exec(`
CREATE TABLE IF NOT EXISTS native_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL, kind TEXT NOT NULL,
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, source_revision TEXT,
 job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL, correlation_id TEXT,
 audience TEXT NOT NULL DEFAULT 'internal' CHECK(audience IN ('user','internal')),
 data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS native_events_owner ON native_events(user_id,seq);
CREATE TABLE IF NOT EXISTS native_consumer_cursors (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, consumer TEXT NOT NULL,
 seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,consumer)
);
CREATE TABLE IF NOT EXISTS native_context_receipts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL DEFAULT '',
 hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,kind,source_id,revision,hash)
);`);
export interface NativeEvent {
 seq:number; userId:string; botId:string|null; kind:string; sourceType:string; sourceId:string;
 sourceRevision:string|null; jobId:string|null; correlationId:string|null;
 audience:'user'|'internal'; data:unknown; createdAt:number;
}
function owner(userId:string, botId?:string|null, jobId?:string|null, write=false) {
 assertTenant(userId);
 if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new Error('Account not found.');
 if (botId && !db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId,userId)) throw new Error('Agent not found.');
 if (jobId && !db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND (? IS NULL OR bot_id=?)').get(jobId,userId,botId??null,botId??null)) throw new Error('Job not found.');
 if(write) assertLegacyWorkOpen(userId);
}
export function publishNativeEvent(input:{userId:string;botId?:string|null;kind:string;sourceType:string;sourceId:string;sourceRevision?:string|number|null;jobId?:string|null;correlationId?:string|null;audience?:'user'|'internal';data?:unknown}):number {
 owner(input.userId,input.botId,input.jobId,true);
 if (!input.kind || !input.sourceType || !input.sourceId) throw new Error('Event identity is required.');
 const seq=Number(db.prepare('INSERT INTO native_events(user_id,bot_id,kind,source_type,source_id,source_revision,job_id,correlation_id,audience,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
 input.userId,input.botId??null,input.kind,input.sourceType,input.sourceId,input.sourceRevision==null?null:String(input.sourceRevision),input.jobId??null,input.correlationId??null,input.audience??'internal',JSON.stringify(input.data??{}),now()).lastInsertRowid);
 // Fan out only after the outer synchronous transaction commits. The event
 // itself is durable; reconnecting consumers resume from their saved cursor.
 queueMicrotask(()=>{if(db.open&&db.prepare('SELECT 1 FROM native_events WHERE seq=? AND user_id=?').get(seq,input.userId))hub.emit(input.userId,{type:'native',cursor:seq});});
 return seq;
}
export function listNativeEvents(userId:string,after=0,limit=100):NativeEvent[] {
 owner(userId);
 return (db.prepare('SELECT * FROM native_events WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?').all(userId,Math.max(0,after),Math.max(1,Math.min(1000,limit))) as any[]).map(r=>({seq:r.seq,userId:r.user_id,botId:r.bot_id,kind:r.kind,sourceType:r.source_type,sourceId:r.source_id,sourceRevision:r.source_revision,jobId:r.job_id,correlationId:r.correlation_id,audience:r.audience,data:JSON.parse(r.data),createdAt:r.created_at}));
}
export function latestNativeEventSeq(userId:string):number {
 owner(userId); return (db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM native_events WHERE user_id=?').get(userId) as {seq:number}).seq;
}
export function readNativeCursor(userId:string,consumer:string):number {
 owner(userId); return (db.prepare('SELECT seq FROM native_consumer_cursors WHERE user_id=? AND consumer=?').get(userId,consumer) as {seq:number}|undefined)?.seq??0;
}
export function advanceNativeCursor(userId:string,consumer:string,expected:number,through:number):boolean {
 return db.transaction(()=>{
  owner(userId,undefined,undefined,true);
  if(!consumer || !Number.isSafeInteger(expected) || !Number.isSafeInteger(through) || through<expected || through>latestNativeEventSeq(userId)) throw new Error('Invalid event checkpoint.');
  if(readNativeCursor(userId,consumer)!==expected) return false;
  db.prepare('INSERT INTO native_consumer_cursors(user_id,consumer,seq,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,consumer) DO UPDATE SET seq=excluded.seq,updated_at=excluded.updated_at').run(userId,consumer,through,now());
  return true;
 })();
}
export function recordContextReceipt(input:{userId:string;botId:string;jobId:string;kind:string;sourceId:string;revision?:string|number|null;hash?:string|null}):void {
 owner(input.userId,input.botId,input.jobId,true);
 db.prepare('INSERT OR IGNORE INTO native_context_receipts(user_id,bot_id,job_id,kind,source_id,revision,hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(input.userId,input.botId,input.jobId,input.kind,input.sourceId,String(input.revision??''),input.hash??'',now());
}
