import './schema.js';
import { db, now } from '../db.js';
import { sha256 } from '../lib/ids.js';
import { latestNativeEventSeq, recordContextReceipt } from '../native/events.js';
import { assertTenant } from '../deployment.js';
import { listWorkflows } from '../agent/workflows.js';
import { botOccupied, pendingDecision } from './requests.js';

export function tableExists(table:string) {return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
export const eventCursor=latestNativeEventSeq;
export function teamState(userId:string) {
 assertTenant(userId);
 return db.transaction(()=>{
 const bots=db.prepare(`SELECT b.id,b.name,b.is_primary,b.updated_at,b.generation,s.onboarding_status,s.revision FROM bots b LEFT JOIN bot_setups s ON s.bot_id=b.id
 WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND b.parent_bot_id IS NULL AND COALESCE(b.kind,'agent')!='room' ORDER BY b.id`).all(userId) as any[];
 const rawJobs=db.prepare(`SELECT j.id,j.bot_id,j.state,j.created_at,j.finished_at,j.trigger,r.workflow_id,r.task_id,r.goal_id FROM agent_jobs j
 LEFT JOIN native_workflow_runs r ON r.job_id=j.id WHERE j.user_id=? AND EXISTS(SELECT 1 FROM bots b WHERE b.id=j.bot_id AND b.user_id=j.user_id)
 ORDER BY j.created_at DESC,j.id DESC LIMIT 200`).all(userId) as any[];
 const jobs=rawJobs.map(j=>({id:j.id,botId:j.bot_id,state:j.state,createdAt:j.created_at,parentJobId:JSON.parse(j.trigger).parentJobId??null,workflowId:j.workflow_id??null,taskId:j.task_id??null,goalId:j.goal_id??null}));
 const workflows=listWorkflows(userId).map(w=>({id:w.id,botId:w.botId,goalId:w.goalId,title:w.title,status:w.status,reason:w.reason,updatedAt:w.updatedAt,tasks:w.tasks.map(t=>({id:t.id,title:t.title,status:t.status,assignedBotId:t.assignedBotId,workerBotId:t.workerBotId,dependsOn:t.dependsOn,reason:t.reason,resultValidated:t.resultValidated,evidence:t.evidence,activeJobId:t.activeJobId}))}));
 const artifacts=tableExists('output_artifacts')?(db.prepare(`SELECT a.* FROM output_artifacts a JOIN bots b ON b.id=a.bot_id AND b.user_id=a.user_id WHERE a.user_id=? ORDER BY a.created_at DESC,a.id LIMIT 100`).all(userId) as any[]).map(a=>({id:a.id,botId:a.bot_id,status:'available',title:a.filename,revision:a.sha256})):[];
 const deliveries=tableExists('artifact_deliveries')?(db.prepare(`SELECT d.*,a.bot_id FROM artifact_deliveries d JOIN output_artifacts a ON a.id=d.artifact_id AND a.user_id=d.user_id JOIN bots b ON b.id=a.bot_id AND b.user_id=d.user_id WHERE d.user_id=? ORDER BY d.updated_at DESC,d.id LIMIT 100`).all(userId) as any[]).map(d=>({id:d.id,botId:d.bot_id,artifactId:d.artifact_id,status:d.status,revision:sha256(JSON.stringify([d.status,d.updated_at,d.error]))})):[];
 const requests={queued:0,deferred:0,admitted:0,completed:0,failed:0};
 for(const r of db.prepare('SELECT status,COUNT(*) n FROM coordination_requests WHERE user_id=? GROUP BY status').all(userId) as any[])requests[r.status as keyof typeof requests]=r.n;
 const agents=bots.map(b=>({botId:b.id,name:b.name,isPrimary:!!b.is_primary,setupStatus:b.onboarding_status??'missing',setupRevision:b.revision??0,
 status:b.onboarding_status!=='active'?'setup':pendingDecision(b.id)?'waiting':botOccupied(b.id)?'working':'idle',pendingDecision:pendingDecision(b.id),activeJobIds:(db.prepare("SELECT id FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running') ORDER BY created_at,id").all(b.id) as any[]).map(j=>j.id)}));
 const supervision=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(userId) as any;
 const pendingWakes=(db.prepare("SELECT COUNT(*) n FROM coordination_wakes WHERE user_id=? AND status IN ('pending','admitted')").get(userId) as any).n;
 const health={runtime:!supervision?'not_started':!supervision.enabled?'disabled':supervision.last_error?'degraded':supervision.last_tick_at&&now()-supervision.last_tick_at<120000?'healthy':'stale',lastTickAt:supervision?.last_tick_at??null,lastError:supervision?.last_error??null,pendingWakes};
 const sourceVersions={agents:sha256(JSON.stringify(bots.map(b=>({id:b.id,name:b.name,is_primary:b.is_primary,generation:b.generation,onboarding_status:b.onboarding_status,revision:b.revision})))),jobs:sha256(JSON.stringify(jobs)),workflows:sha256(JSON.stringify(workflows)),artifacts:sha256(JSON.stringify(artifacts)),deliveries:sha256(JSON.stringify(deliveries)),requests:sha256(JSON.stringify(db.prepare('SELECT id,status,revision FROM coordination_requests WHERE user_id=? ORDER BY seq').all(userId)))};
 return {userId,generatedAt:now(),eventCursor:eventCursor(userId),sourceVersions,primaryBotId:bots.find(b=>b.is_primary)?.id??null,agents,jobs,workflows,artifacts,deliveries,requests,health};
 })();
}
/** Bounded operational facts; no private messages, instructions, memories or results. */
export function coordinationPrompt(userId:string,botId:string,jobId?:string) {
 const state=teamState(userId);if(state.primaryBotId!==botId)return '';
 if(jobId)for(const [kind,revision] of Object.entries(state.sourceVersions))recordContextReceipt({userId,botId,jobId,kind:'coordination',sourceId:kind,revision,hash:revision});
 const compact={eventCursor:state.eventCursor,sourceVersions:state.sourceVersions,agents:state.agents.slice(0,24).map(a=>({...a,activeJobIds:a.activeJobIds.slice(0,8)})),
 jobs:state.jobs.filter(j=>['queued','running','uncertain'].includes(j.state)).slice(0,24),
 workflows:state.workflows.filter(w=>!['completed','cancelled'].includes(w.status)).slice(0,12).map(w=>({...w,tasks:w.tasks.slice(0,20).map(t=>({...t,title:t.title.slice(0,160),reason:t.reason.slice(0,160),evidence:t.evidence.map((e:any)=>({kind:e.kind,sha256:e.sha256})).slice(0,4)}))})),
 artifacts:state.artifacts.slice(0,12),deliveries:state.deliveries.slice(0,12),requests:state.requests,health:state.health};
 const text=JSON.stringify(compact);
 if(text.length<=24000)return `Current operational team state (execution finished is not acceptance or user delivery):\n${text}`;
 // Keep valid bounded JSON instead of silently truncating a source snapshot.
 return `Current operational team state (bounded summary; inspect team board for details):\n${JSON.stringify({eventCursor:state.eventCursor,sourceVersions:state.sourceVersions,agents:state.agents.slice(0,12).map(a=>({...a,activeJobIds:a.activeJobIds.slice(0,4)})),requests:state.requests,health:state.health,omittedDetails:true})}`;
}
