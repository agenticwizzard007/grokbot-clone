import '../agent/jobs.js';
import './schema.js';
import { db, now } from '../db.js';
import { newId, sha256 } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { legacyWorkHeld, assertLegacyWorkOpen } from '../security/legacy-work.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';
import { publishNativeEvent } from '../native/events.js';

export interface CoordinationTrigger {
 type:'bot'|'system';text:string;fromBotId?:string;fromName?:string;depth?:number;
 audience:'internal';coordinationRequestId?:string;coordinationWakeId?:string;parentJobId?:string;
 workflowId?:string;taskId?:string;goalId?:string;
}
export interface CoordinationRuntime {enqueue:(botId:string,trigger:CoordinationTrigger)=>string;interrupt:(botId:string,expectedJobId?:string)=>unknown}
let runtime:CoordinationRuntime|undefined;
export function configureCoordinationRuntime(value:CoordinationRuntime) { runtime=value; }
export function coordinationRuntime() { return runtime; }
export function ownAgent(userId:string,botId:string) {
 assertTenant(userId);
 const b=db.prepare("SELECT * FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')!='room'").get(botId,userId) as any;
 if(!b)throw new Error('Agent not found.');return b;
}
export function pendingDecision(botId:string) {
 return !!db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId)
 || !!db.prepare("SELECT 1 FROM approvals WHERE bot_id=? AND status='pending'").get(botId)
 || !!db.prepare(`SELECT 1 FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation WHERE r.bot_id=? AND r.kind='card'
 AND json_extract(r.body,'$.card') IN ('question','approval','connect') AND (json_extract(r.body,'$.status')='pending'
 OR EXISTS(SELECT 1 FROM agent_jobs j WHERE j.id=json_extract(r.body,'$.answerJobId') AND j.state IN ('queued','running'))) LIMIT 1`).get(botId);
}
export function botOccupied(botId:string) {return pendingDecision(botId)||!!db.prepare("SELECT 1 FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running') LIMIT 1").get(botId);}
export interface InternalRequest {
 seq:number;id:string;fromBotId:string;toBotId:string;text:string;status:'queued'|'deferred'|'admitted'|'completed'|'failed';
 kind:'request'|'result';correlationId:string;parentRequestId:string|null;depth:number;audience:'internal';jobId:string|null;
 result:string|null;reason:string;revision:number;createdAt:number;updatedAt:number;
}
function view(r:any):InternalRequest {return {seq:r.seq,id:r.id,fromBotId:r.from_bot_id,toBotId:r.to_bot_id,text:r.text,status:r.status,kind:r.kind,
 correlationId:r.correlation_id,parentRequestId:r.parent_request_id,depth:r.depth,audience:'internal',jobId:r.job_id,result:r.result,reason:r.reason,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at};}
export function getInternalRequest(userId:string,id:string) {
 assertTenant(userId);const r=db.prepare('SELECT r.* FROM coordination_requests r JOIN bots f ON f.id=r.from_bot_id AND f.user_id=r.user_id JOIN bots t ON t.id=r.to_bot_id AND t.user_id=r.user_id WHERE r.id=? AND r.user_id=?').get(id,userId);
 if(!r)throw new Error('Request not found.');return view(r);
}
export function listInternalRequests(userId:string,after=0,limit=50,botId?:string) {
 assertTenant(userId);if(botId)ownAgent(userId,botId);limit=Math.max(1,Math.min(100,limit));
 const rows=db.prepare(`SELECT r.* FROM coordination_requests r JOIN bots f ON f.id=r.from_bot_id AND f.user_id=r.user_id JOIN bots t ON t.id=r.to_bot_id AND t.user_id=r.user_id
 WHERE r.user_id=? AND seq>? ${botId?'AND (from_bot_id=? OR to_bot_id=?)':''} ORDER BY seq LIMIT ?`).all(userId,after,...(botId?[botId,botId]:[]),limit+1) as any[];
 const requests=rows.slice(0,limit).map(view);return {requests,nextCursor:requests.at(-1)?.seq??after,hasMore:rows.length>limit};
}
function event(r:any,kind:string) {publishNativeEvent({userId:r.user_id,botId:r.to_bot_id,kind,sourceType:'coordination_request',sourceId:r.id,sourceRevision:r.revision,jobId:r.job_id??undefined,correlationId:r.correlation_id,audience:'internal',data:{status:r.status,fromBotId:r.from_bot_id,toBotId:r.to_bot_id,kind:r.kind}});}
function createRequest(userId:string,from:string,to:string,text:string,depth:number,key:string,parent?:any,kind='request') {
 const existing=db.prepare('SELECT * FROM coordination_requests WHERE user_id=? AND idempotency_key=?').get(userId,key) as any;
 if(existing){if(existing.from_bot_id!==from||existing.to_bot_id!==to||existing.text!==text||existing.kind!==kind)throw new Error('Idempotency key is already bound to another request.');return existing.id as string;}
 const id=newId('req');db.prepare(`INSERT INTO coordination_requests(id,user_id,from_bot_id,to_bot_id,text,kind,status,correlation_id,parent_request_id,depth,idempotency_key,created_at,updated_at)
 VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(id,userId,from,to,text,kind,parent?.correlation_id??id,parent?.id??null,depth,key,now(),now());
 event(db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(id),'coordination.requested');return id;
}
/** Fan-in from a verified permanent workflow task; no automatic reply to a result. */
export function recordWorkflowResult(input:{userId:string;fromBotId:string;toBotId:string;workflowId:string;taskId:string;result:unknown;evidence:unknown[]}) {
 ownAgent(input.userId,input.fromBotId);ownAgent(input.userId,input.toBotId);assertLegacyWorkOpen(input.userId);
 if(input.fromBotId===input.toBotId)return null;
 const text=`[Verified workflow result ${input.workflowId}/${input.taskId}] Acceptance evidence is verified; inspect referenced artifacts for delivery status.\n${JSON.stringify({workflowId:input.workflowId,taskId:input.taskId,result:input.result,evidence:input.evidence}).slice(0,30000)}`;
 // The enclosing verification transaction commits this result intent together
 // with task acceptance. Admission drains after durable settlement or on timer.
 return createRequest(input.userId,input.fromBotId,input.toBotId,text,1,`workflow-result:${input.taskId}`,{correlation_id:input.workflowId},'result');
}
export function enqueueInternalMessage(fromBotId:string,toBotId:string,text:string,depth:number,options:{idempotencyKey?:string;parentRequestId?:string}={}) {
 const from=db.prepare('SELECT * FROM bots WHERE id=?').get(fromBotId) as any;if(!from)throw new Error('Sender not found.');
 ownAgent(from.user_id,fromBotId);ownAgent(from.user_id,toBotId);assertLegacyWorkOpen(from.user_id);
 if(fromBotId===toBotId)throw new Error('Internal requests require a different agent.');
 if(!Number.isInteger(depth)||depth<0||depth>4)throw new Error('Internal reply chain limit reached (4).');
 if(!text.trim()||text.length>32000)throw new Error('Internal message must contain 1–32000 characters.');
 const active=db.prepare("SELECT id,trigger FROM agent_jobs WHERE bot_id=? AND state='running' ORDER BY started_at DESC LIMIT 1").get(fromBotId) as any;
 const parentId=options.parentRequestId??(active?JSON.parse(active.trigger).coordinationRequestId:undefined);
 const parent=parentId?db.prepare('SELECT * FROM coordination_requests WHERE id=? AND user_id=? AND to_bot_id=?').get(parentId,from.user_id,fromBotId) as any:undefined;
 if(parentId&&!parent)throw new Error('Reply parent not found.');
 const actualDepth=parent?Math.max(depth,parent.depth+1):depth;if(actualDepth>4)throw new Error('Internal reply chain limit reached (4).');
 const key=options.idempotencyKey??sha256(`${active?.id??newId('send')}\0${toBotId}\0${text}`);
 const id=db.transaction(()=>createRequest(from.user_id,fromBotId,toBotId,text,actualDepth,key,parent))();
 drainInternalRequests();return id;
}
/** Admission, job binding and receipt commit together. No transcript rows are written. */
export function drainInternalRequests() {
 if(!runtime||!db.open)return;
 const writable=legacyWritableRows(db,'coordination_requests');
 const rows=db.prepare(`SELECT * FROM coordination_requests WHERE status IN ('queued','deferred') AND (${writable}) ORDER BY seq LIMIT 100`).all() as any[];
 for(const row of rows) {
  if(legacyWorkHeld(row.user_id))continue;
  try {db.transaction(()=>{
   const r=db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(row.id) as any;
   if(!['queued','deferred'].includes(r.status)||r.claim_until>now())return;
   ownAgent(r.user_id,r.from_bot_id);const target=ownAgent(r.user_id,r.to_bot_id);
   const setup=db.prepare('SELECT onboarding_status FROM bot_setups WHERE bot_id=?').get(target.id) as any;
   const reason=setup&&setup.onboarding_status!=='active'?'Worker setup is not activated.':botOccupied(r.to_bot_id)?'Worker is busy or waiting for a decision.':'';
   if(reason){if(r.status!=='deferred'||r.reason!==reason){db.prepare("UPDATE coordination_requests SET status='deferred',reason=?,revision=revision+1,updated_at=? WHERE id=?").run(reason,now(),r.id);event({...r,status:'deferred',revision:r.revision+1},'coordination.deferred');}return;}
   const token=newId('claim');if(!db.prepare('UPDATE coordination_requests SET claim_token=?,claim_until=? WHERE id=? AND (claim_until IS NULL OR claim_until<=?)').run(token,now()+30000,r.id,now()).changes)return;
   const from=ownAgent(r.user_id,r.from_bot_id);
   const jobId=runtime!.enqueue(r.to_bot_id,{type:'bot',fromBotId:from.id,fromName:from.name,text:r.text,depth:r.depth,audience:'internal',coordinationRequestId:r.id});
   const job=db.prepare('SELECT user_id,bot_id FROM agent_jobs WHERE id=?').get(jobId) as any;
   if(!job||job.user_id!==r.user_id||job.bot_id!==r.to_bot_id)throw new Error('Queue did not return a durable owned job.');
   db.prepare('INSERT INTO coordination_admissions VALUES(?,?,?,?)').run(r.id,r.user_id,jobId,now());
   db.prepare("UPDATE coordination_requests SET status='admitted',job_id=?,reason='',claim_token=NULL,claim_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND claim_token=?").run(jobId,now(),r.id,token);
   event({...r,status:'admitted',job_id:jobId,revision:r.revision+1},'coordination.admitted');
  })();}catch(e){db.transaction(()=>{db.prepare("UPDATE coordination_requests SET status='deferred',reason=?,claim_token=NULL,claim_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND status IN ('queued','deferred')").run(String((e as Error).message).slice(0,1000),now(),row.id);})();}
 }
}
export interface CoordinationFinish {userId:string;botId:string;jobId:string;status:string;finalText?:string;trigger?:Record<string,unknown>}
/** Root writes this in the same SQLite transaction as finishJob, before the
 * after-settlement hook. A crash between settlement and fan-in then loses no result. */
export function recordCoordinationJobOutcome(input:CoordinationFinish) {
 assertTenant(input.userId);assertLegacyWorkOpen(input.userId);ownAgent(input.userId,input.botId);
 const job=db.prepare('SELECT trigger FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(input.jobId,input.userId,input.botId) as any;
 if(!job)throw new Error('Outcome job not found.');
 const trigger=JSON.parse(job.trigger);
 if(!trigger.coordinationRequestId&&!trigger.coordinationWakeId&&!trigger.workflowId&&!trigger.proactiveSlotKey&&!requestForJob(input))return;
 db.prepare(`INSERT INTO coordination_job_outcomes(job_id,user_id,bot_id,status,final_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,final_text=excluded.final_text,updated_at=excluded.updated_at WHERE coordination_job_outcomes.status='waiting'`).run(input.jobId,input.userId,input.botId,input.status,(input.finalText??'').slice(0,32000),now(),now());
}
function requestForJob(input:CoordinationFinish) {
 // Decisions resume on a new durable job. Follow only same-owner/same-bot lineage.
 return db.prepare(`WITH RECURSIVE lineage(id,parent,depth) AS (
 SELECT id,json_extract(trigger,'$.parentJobId'),0 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?
 UNION ALL SELECT j.id,json_extract(j.trigger,'$.parentJobId'),l.depth+1 FROM agent_jobs j JOIN lineage l ON j.id=l.parent
 WHERE j.user_id=? AND j.bot_id=? AND l.depth<32)
 SELECT r.* FROM coordination_requests r JOIN lineage l ON l.id=r.job_id WHERE r.user_id=? ORDER BY l.depth LIMIT 1`).get(input.jobId,input.userId,input.botId,input.userId,input.botId,input.userId) as any;
}
function settle(r:any,status:string,text:string) {
 if(['completed','failed'].includes(r.status))return;
 const succeeded=status==='completed';
 db.prepare('UPDATE coordination_requests SET status=?,result=?,reason=?,revision=revision+1,updated_at=? WHERE id=?').run(succeeded?'completed':'failed',text.slice(0,32000),succeeded?'':status,now(),r.id);
 event({...r,status:succeeded?'completed':'failed',revision:r.revision+1},'coordination.result');
 // Result receipts never elicit another automatic result (bounded fan-in).
 if(r.kind==='request')createRequest(r.user_id,r.to_bot_id,r.from_bot_id,`[Internal result for request ${r.id}; ${succeeded?'execution finished; acceptance still requires evidence':status}]\n${text.slice(0,30000)}`,Math.min(4,r.depth+1),`result:${r.id}`,r,'result');
}
export function onInternalJobFinished(input:CoordinationFinish) {
 assertTenant(input.userId);if(legacyWorkHeld(input.userId))return;
 ownAgent(input.userId,input.botId);recordCoordinationJobOutcome(input);
 if(['waiting','queued','running'].includes(input.status))return;
 db.transaction(()=>{const r=requestForJob(input);if(r)settle(r,input.status,input.finalText??'No final text recorded.');})();
 drainInternalRequests();
}
export function recoverInternalRequests() {
 const rows=db.prepare("SELECT r.*,j.state AS job_state FROM coordination_requests r JOIN agent_jobs j ON j.id=r.job_id WHERE r.status='admitted'").all() as any[];
 for(const r of rows){if(legacyWorkHeld(r.user_id)||!['uncertain','cancelled','completed'].includes(r.job_state)||pendingDecision(r.to_bot_id))continue;
  // A live continuation may already own this wait; never replay the original.
  const continuation=db.prepare(`WITH RECURSIVE chain(id,depth) AS (SELECT ?,0 UNION ALL SELECT j.id,c.depth+1 FROM agent_jobs j JOIN chain c ON json_extract(j.trigger,'$.parentJobId')=c.id WHERE j.user_id=? AND j.bot_id=? AND c.depth<32)
  SELECT 1 FROM chain c JOIN agent_jobs j ON j.id=c.id WHERE c.depth>0 AND j.state IN ('queued','running') LIMIT 1`).get(r.job_id,r.user_id,r.to_bot_id);
  if(continuation)continue;
  const outcome=db.prepare(`WITH RECURSIVE chain(id,n) AS (SELECT ?,0 UNION ALL SELECT j.id,c.n+1 FROM agent_jobs j JOIN chain c ON json_extract(j.trigger,'$.parentJobId')=c.id WHERE j.user_id=? AND j.bot_id=? AND c.n<32)
  SELECT o.* FROM coordination_job_outcomes o JOIN chain c ON c.id=o.job_id JOIN agent_jobs j ON j.id=o.job_id WHERE o.user_id=? AND o.bot_id=? AND o.status NOT IN ('waiting','queued','running') AND j.state IN ('completed','uncertain','cancelled') ORDER BY c.n DESC,o.updated_at DESC LIMIT 1`).get(r.job_id,r.user_id,r.to_bot_id,r.user_id,r.to_bot_id) as any;
  if(outcome){db.transaction(()=>settle(r,outcome.status,outcome.final_text))();continue;}
  db.transaction(()=>settle(r,r.job_state==='completed'?'result_unavailable_after_restart':r.job_state,'Execution outcome needs reconciliation after restart; no external action was replayed.'))();
 }
 drainInternalRequests();
}
