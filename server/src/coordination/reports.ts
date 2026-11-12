import './schema.js';
import { db, now } from '../db.js';
import { newId, sha256 } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen, legacyWorkHeld } from '../security/legacy-work.js';
import { publishNativeEvent } from '../native/events.js';
import { readArtifact } from '../deliverables/artifacts.js';
import { tableExists } from './state.js';

export function reportSources(userId:string) {
 assertTenant(userId);
 const sources:Array<{id:string;revision:string;kind:string;state:string;title:string}>=[];
 for(const r of db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.id').all(userId) as any[])sources.push({id:`routine:${r.id}`,revision:sha256(JSON.stringify([r.name,r.enabled,r.schedule,r.timezone,r.last_run_at])),kind:'routine',state:r.enabled?'enabled':'disabled',title:r.name});
 if(tableExists('routine_executions'))for(const r of db.prepare('SELECT * FROM routine_executions WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId) as any[])sources.push({id:`run:${r.id}`,revision:sha256(JSON.stringify([r.status,r.finished_at,r.error])),kind:'run',state:r.status,title:r.routine_name});
 if(tableExists('output_artifacts'))for(const r of db.prepare('SELECT * FROM output_artifacts WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId) as any[])sources.push({id:`artifact:${r.id}`,revision:r.sha256,kind:'artifact',state:'available',title:r.filename});
 if(tableExists('artifact_deliveries'))for(const r of db.prepare('SELECT * FROM artifact_deliveries WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(userId) as any[])sources.push({id:`delivery:${r.id}`,revision:sha256(JSON.stringify([r.status,r.updated_at,r.error])),kind:'delivery',state:r.status,title:r.channel});
 return sources;
}
export function dailySynopsisContext(userId:string,period=new Date().toISOString().slice(0,10)) {
 const sources=reportSources(userId);
 const covered=new Set((db.prepare('SELECT source_id,source_revision FROM coordination_reports WHERE user_id=? AND period=?').all(userId,period) as any[]).map(r=>`${r.source_id}:${r.source_revision}`));
 return {period,sources:sources.map(s=>({...s,covered:covered.has(`${s.id}:${s.revision}`)})),instructions:'Use current routine executions, artifacts and delivery receipts. Available artifacts are not proof of human delivery. Failed/unknown/waiting work stays unresolved. Durable report coverage is recorded only after a report artifact is delivered; a final model response alone never covers work. For every source actually discussed, include its exact id@revision reference in the saved report source references. Only those referenced revisions receive coverage.'};
}
export function bindReportIntent(userId:string,jobId:string,period:string,sources=reportSources(userId)) {
 assertTenant(userId);assertLegacyWorkOpen(userId);
 const job=db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=?').get(jobId,userId);if(!job)throw new Error('Report job not found.');
 db.prepare('INSERT OR IGNORE INTO coordination_report_intents(job_id,user_id,period,sources,created_at) VALUES(?,?,?,?,?)').run(jobId,userId,period,JSON.stringify(sources),now());
}
/** Reconcile independently of model success; delivery can happen after the turn. */
export function reconcileReportCoverage() {
 if(!tableExists('artifact_deliveries')||!tableExists('output_artifacts'))return;
 const intents=db.prepare('SELECT * FROM coordination_report_intents WHERE settled_at IS NULL').all() as any[];
 for(const intent of intents){if(legacyWorkHeld(intent.user_id))continue;
 const receipts=db.prepare(`WITH RECURSIVE lineage(id,n) AS (
 SELECT id,0 FROM agent_jobs WHERE id=? AND user_id=? UNION ALL
 SELECT j.id,l.n+1 FROM agent_jobs j JOIN lineage l ON json_extract(j.trigger,'$.parentJobId')=l.id WHERE j.user_id=? AND l.n<32)
 SELECT d.id,a.id AS artifact_id FROM artifact_deliveries d JOIN output_artifacts a ON a.id=d.artifact_id AND a.user_id=d.user_id
 JOIN agent_jobs j ON j.id=a.job_id AND j.user_id=a.user_id JOIN lineage l ON l.id=j.id
 WHERE a.user_id=? AND j.state='completed' AND d.status='delivered' ORDER BY d.updated_at`).all(intent.job_id,intent.user_id,intent.user_id,intent.user_id) as any[];
 const sources=JSON.parse(intent.sources) as Array<{id:string;revision:string}>;
 for(const receipt of receipts) {
 let content:string;try{content=readArtifact(intent.user_id,receipt.artifact_id).content.toString('utf8');}catch{continue;}
 const referenced=sources.filter(s=>content.includes(`${s.id}@${s.revision}`));if(!referenced.length)continue;
 db.transaction(()=>{
 let inserted=0;
 for(const s of referenced)inserted+=db.prepare('INSERT OR IGNORE INTO coordination_reports(id,user_id,period,source_id,source_revision,report_job_id,delivery_id,covered_at) VALUES(?,?,?,?,?,?,?,?)').run(newId('coverage'),intent.user_id,intent.period,s.id,s.revision,intent.job_id,receipt.id,now()).changes;
 const covered=new Set((db.prepare('SELECT source_id,source_revision FROM coordination_reports WHERE user_id=? AND period=?').all(intent.user_id,intent.period) as any[]).map(r=>`${r.source_id}@${r.source_revision}`));
 if(sources.every(s=>covered.has(`${s.id}@${s.revision}`)))db.prepare('UPDATE coordination_report_intents SET settled_at=? WHERE job_id=?').run(now(),intent.job_id);
 if(inserted)publishNativeEvent({userId:intent.user_id,kind:'coordination.report_covered',sourceType:'coordination_report',sourceId:intent.job_id,jobId:intent.job_id,audience:'internal',data:{period:intent.period,deliveryId:receipt.id,sourceCount:inserted}});
 })();
 }
 }
}
