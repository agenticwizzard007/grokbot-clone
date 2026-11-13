import {db,now} from '../db.js';
import {assertTenant} from '../deployment.js';
import {assertLegacyWorkOpen} from '../security/legacy-work.js';
import {legacyWritableRows} from '../platform/legacy-database-fence.js';
import {publishNativeEvent} from './events.js';

// Stored with job settlement. Independent consumers acknowledge only after their
// own durable idempotent mutation succeeds; restart never repeats business work.
db.exec(`CREATE TABLE IF NOT EXISTS native_job_completions (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 payload TEXT NOT NULL, coordination_done INTEGER NOT NULL DEFAULT 0,
 learning_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);`);
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
 return (db.prepare(`SELECT * FROM native_job_completions WHERE (coordination_done=0 OR learning_done=0) AND (? IS NULL OR job_id=?) AND ${legacyWritableRows(db,'native_job_completions')} ORDER BY created_at,job_id LIMIT 100`).all(jobId??null,jobId??null) as any[]).map(r=>({input:JSON.parse(r.payload) as JobCompletion,coordinationDone:!!r.coordination_done,learningDone:!!r.learning_done}));
}
export function acknowledgeJobCompletion(userId:string,jobId:string,consumer:'learning'|'coordination') {
 assertTenant(userId);assertLegacyWorkOpen(userId);
 db.prepare(`UPDATE native_job_completions SET ${consumer==='learning'?'learning_done':'coordination_done'}=1 WHERE job_id=? AND user_id=?`).run(jobId,userId);
}
