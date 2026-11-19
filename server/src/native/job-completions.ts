import {db,now} from '../db.js';
import {assertTenant} from '../deployment.js';
import {assertLegacyWorkOpen} from '../security/legacy-work.js';
import {legacyWritableRows} from '../platform/legacy-database-fence.js';
import {publishNativeEvent} from './events.js';
import {legacyWorkHeld} from '../security/legacy-work.js';

// Stored with job settlement. Independent consumers acknowledge only after their
// own durable idempotent mutation succeeds; restart never repeats business work.
db.exec(`CREATE TABLE IF NOT EXISTS native_job_completions (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 payload TEXT NOT NULL, coordination_done INTEGER NOT NULL DEFAULT 0,
 learning_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);`);
const completionColumns=new Set((db.prepare('PRAGMA table_info(native_job_completions)').all() as {name:string}[]).map(c=>c.name));
for(const name of ['coordination_next_at','learning_next_at','coordination_failures','learning_failures'])if(!completionColumns.has(name))db.exec(`ALTER TABLE native_job_completions ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
export interface JobCompletion {userId:string;botId:string;jobId:string;trigger:Record<string,any>;completion:Record<string,any>}
export function recordJobCompletion(input:JobCompletion) {
 assertTenant(input.userId);assertLegacyWorkOpen(input.userId);
 const job=db.prepare('SELECT state FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(input.jobId,input.userId,input.botId) as {state:string}|undefined;
 if(!job||!['completed','uncertain','cancelled'].includes(job.state))throw new Error('Completion requires a settled owned job.');
 const payload=JSON.stringify(input);
 const prior=db.prepare('SELECT payload FROM native_job_completions WHERE job_id=?').get(input.jobId) as {payload:string}|undefined;
 if(prior){if(prior.payload!==payload)throw new Error('Completion identity changed.');return;}
 db.prepare('INSERT INTO native_job_completions(job_id,user_id,bot_id,payload,created_at) VALUES(?,?,?,?,?)').run(input.jobId,input.userId,input.botId,payload,now());
 publishNativeEvent({userId:input.userId,botId:input.botId,jobId:input.jobId,kind:'job.execution_finished',sourceType:'job',sourceId:input.jobId,data:{status:input.completion.status}});
}
export function pendingJobCompletions(jobId?:string) {
 const time=now(),rows=new Map<string,any>();
 // Independent bounded batches keep a failed learning backlog from preventing
 // coordination delivery, and vice versa. Backoff lets healthy later rows pass.
 for(const consumer of ['coordination','learning'] as const){
  for(const row of db.prepare(`SELECT * FROM native_job_completions WHERE ${consumer}_done=0 AND ${consumer}_next_at<=?
    AND (? IS NULL OR job_id=?) AND ${legacyWritableRows(db,'native_job_completions')} ORDER BY created_at,job_id LIMIT 100`).all(time,jobId??null,jobId??null) as any[])rows.set(row.job_id,row);
 }
 return [...rows.values()].map(r=>({input:JSON.parse(r.payload) as JobCompletion,
  coordinationDone:!!r.coordination_done,learningDone:!!r.learning_done,
  coordinationReady:!r.coordination_done&&r.coordination_next_at<=time,learningReady:!r.learning_done&&r.learning_next_at<=time}));
}
export function deferJobCompletion(userId:string,jobId:string,consumer:'learning'|'coordination') {
 assertTenant(userId);if(legacyWorkHeld(userId))return;
 const row=db.prepare(`SELECT ${consumer}_failures failures FROM native_job_completions WHERE user_id=? AND job_id=?`).get(userId,jobId) as any;
 if(!row)return;
 db.prepare(`UPDATE native_job_completions SET ${consumer}_next_at=?,${consumer}_failures=${consumer}_failures+1 WHERE user_id=? AND job_id=? AND ${consumer}_done=0`)
  .run(now()+Math.min(60000,2000*2**Math.min(row.failures,5)),userId,jobId);
}
export function acknowledgeJobCompletion(userId:string,jobId:string,consumer:'learning'|'coordination') {
 assertTenant(userId);assertLegacyWorkOpen(userId);
 db.prepare(`UPDATE native_job_completions SET ${consumer==='learning'?'learning_done':'coordination_done'}=1 WHERE job_id=? AND user_id=?`).run(jobId,userId);
}
