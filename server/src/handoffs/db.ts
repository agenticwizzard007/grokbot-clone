import '../agent/jobs.js';
import '../deliverables/schema.js';
import '../coordination/schema.js';
import { db, now } from '../db.js';
import { DDL } from './schema.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen } from '../security/legacy-work.js';
import { afterCommit, transactionWithEffects } from '../lib/commit-effects.js';
import { hub } from '../lib/hub.js';
import type { ServerEvent } from '../types.js';
import type { HandoffSettings } from './contracts.js';
export { db, now, afterCommit };
export { newId, sha256 } from '../lib/ids.js';
db.exec(DDL);
// Receipts and dispatch attempts preserve identity across retries and restarts.
// Original parts are owner-only; forwarding always uses the redacted display copy.
db.exec(`
CREATE TABLE IF NOT EXISTS handoff_output_sources (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_key TEXT NOT NULL,
 output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE, PRIMARY KEY(user_id,source_key));
CREATE TABLE IF NOT EXISTS handoff_original_parts (
 output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE, part_id TEXT NOT NULL,
 body TEXT NOT NULL, PRIMARY KEY(output_id,part_id));
CREATE TABLE IF NOT EXISTS handoff_payloads (
 handoff_id TEXT PRIMARY KEY REFERENCES handoffs(id) ON DELETE CASCADE, packet TEXT NOT NULL,
 include_sensitive INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS handoff_loop_dispatches (
 loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE, iteration INTEGER NOT NULL,
 step_id TEXT NOT NULL, attempt INTEGER NOT NULL, request_id TEXT REFERENCES coordination_requests(id) ON DELETE SET NULL,
 job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL, packet TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(loop_id,iteration,step_id,attempt));
CREATE TABLE IF NOT EXISTS handoff_loop_controls (
 loop_id TEXT PRIMARY KEY REFERENCES loops(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
 gate_kind TEXT, gate_at INTEGER, extended INTEGER NOT NULL DEFAULT 0, allow_self_check INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS handoff_tool_receipts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,job_id,call_id));
`);
export class ServiceError extends Error {
 constructor(readonly code:string, message:string, readonly status:400|404|409|410|422|429|503=400) { super(message); }
}
export const missing = ():never => { throw new ServiceError('not_found','Not found.',404); };
export function settings(userId:string):HandoffSettings {
 assertTenant(userId);
 const r=db.prepare('SELECT * FROM handoff_user_settings WHERE user_id=?').get(userId) as any;
 return {enabled:r?!!r.enabled:true,agentHandoffs:r?.agent_handoffs??'team'};
}
export function enabled(userId:string) { return process.env.HANDOFFS_DISABLED!=='1'&&settings(userId).enabled; }
export function requireEnabled(userId:string) {
 assertTenant(userId); assertLegacyWorkOpen(userId);
 if(!enabled(userId))throw new ServiceError('disabled','Agent handoffs are disabled.',503);
}
export function ownBot(userId:string,id:string) {
 assertTenant(userId);
 return db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(id,userId) as any || missing();
}
export function targetBot(userId:string,id:string,from?:string) {
 const b=ownBot(userId,id);
 if(b.kind==='room'||b.hidden&&b.parent_bot_id!==from)throw new ServiceError('target_not_allowed','Choose an available agent.',422);
 const s=db.prepare('SELECT onboarding_status FROM bot_setups WHERE bot_id=?').get(id) as any;
 if(s?.onboarding_status!=='active'&&!b.hidden)throw new ServiceError('target_not_allowed','Finish setting up this agent first.',422);
 return b;
}
export function ownJob(userId:string,botId:string,jobId:string) {
 ownBot(userId,botId);
 return db.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(jobId,userId,botId) as any || missing();
}
/** Finish hooks may be inside the runtime's existing SQLite transaction. */
export function atomic<T>(fn:()=>T):T { return db.inTransaction?db.transaction(fn)():transactionWithEffects(fn); }
export function emitEvent(userId:string,type:string,data:Record<string,unknown>={},ids:{loopId?:string|null;handoffId?:string|null}={},sse?:ServerEvent) {
 const seq=Number(db.prepare('INSERT INTO handoff_events(user_id,loop_id,handoff_id,type,data,created_at) VALUES(?,?,?,?,?,?)')
  .run(userId,ids.loopId??null,ids.handoffId??null,type,JSON.stringify(data),now()).lastInsertRowid);
 // Recheck the durable row after an unmanaged outer transaction as well.
 if(sse)afterCommit(()=>queueMicrotask(()=>{if(db.open&&db.prepare('SELECT 1 FROM handoff_events WHERE seq=? AND user_id=?').get(seq,userId))hub.emit(userId,sse);}));
 return seq;
}
export function events(userId:string,ids:{loopId?:string;handoffId?:string},after=0,limit=200) {
 return (db.prepare(`SELECT * FROM handoff_events WHERE user_id=? AND ${ids.loopId?'loop_id':'handoff_id'}=? AND seq>? ORDER BY seq LIMIT ?`)
 .all(userId,ids.loopId??ids.handoffId,after,Math.min(200,Math.max(1,limit))) as any[]).map(r=>({seq:r.seq,userId:r.user_id,loopId:r.loop_id,handoffId:r.handoff_id,type:r.type,data:JSON.parse(r.data),createdAt:r.created_at}));
}
export function pageSize(limit=50) { if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ServiceError('invalid_input','Use a limit from 1 to 50.');return limit; }
export function cursor(after?:string):[number,string]|null {
 if(!after)return null;
 try { const a=JSON.parse(Buffer.from(after,'base64url').toString());if(Array.isArray(a)&&a.length===2&&Number.isSafeInteger(a[0])&&typeof a[1]==='string')return a as [number,string]; }catch{}
 throw new ServiceError('invalid_input','Invalid cursor.');
}
export const nextCursor=(row:{createdAt:number;id:string}|undefined)=>row?Buffer.from(JSON.stringify([row.createdAt,row.id])).toString('base64url'):null;
