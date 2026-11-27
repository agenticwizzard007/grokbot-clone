import { db,now,newId,atomic,enabled,emitEvent } from './db.js';
import { handoffView,packet,syncHandoffRows } from './handoff-service.js';
import { getOutput,saveOutput } from './outputs.js';
import { driveLoop } from './loop-runner.js';
import { drainInternalRequests,pendingDecision } from '../coordination/requests.js';
import { hub } from '../lib/hub.js';
import type { Handoff,HandoffStatus } from './contracts.js';
let reconciling=false;
const subscriptions=new Map<string,()=>void>();
export function watchHandoffs(userId:string) {
 if(subscriptions.has(userId))return;
 subscriptions.set(userId,hub.subscribe(userId,event=>{
  if(event.type==='native')queueMicrotask(()=>{if(db.open&&enabled(userId))reconcileHandoffs(userId);});
 }));
}
export function stopHandoffRecovery() {for(const stop of subscriptions.values())stop();subscriptions.clear();}
function move(h:Handoff,status:HandoffStatus,reason='') {
 if(h.status===status)return;
 db.prepare('UPDATE handoffs SET status=?,reason=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?').run(status,reason,now(),h.id,h.userId);
 const type=status==='running'?'handoff.running':`handoff.${status}`;
 emitEvent(h.userId,type,{jobId:h.jobId,resultOutputId:h.resultOutputId,...(reason?{reason}:{})},{handoffId:h.id,loopId:h.loopId},{type:'handoff',id:h.id,status});
 h.status=status;syncHandoffRows(h);
 db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id IN (SELECT task_id FROM handoff_task_links WHERE handoff_id=?)').run(status==='completed'?'done':['failed','cancelled','expired'].includes(status)?'needs_input':'working',now(),h.id);
}
function resultReturn(h:Handoff) {
 if(!h.returnResult||h.loopId||!h.resultOutputId||!h.requestId)return;
 const existing=db.prepare('SELECT 1 FROM coordination_requests WHERE user_id=? AND idempotency_key=?').get(h.userId,`ho-result:${h.id}`);if(existing)return;
 const output=getOutput(h.userId,h.resultOutputId),parent=db.prepare('SELECT * FROM coordination_requests WHERE id=? AND user_id=?').get(h.requestId,h.userId) as any;
 const id=newId('req'),text=packet(h.userId,output,'Result of your handoff. Read the output and continue if needed.',`[handoff ${h.id} result]`,false,'This is a result receipt. Do not send an automatic acknowledgement.');
 db.prepare(`INSERT INTO coordination_requests(id,user_id,from_bot_id,to_bot_id,text,kind,status,correlation_id,parent_request_id,depth,idempotency_key,reply,created_at,updated_at)
 VALUES(?,?,?,?,?,'result','queued',?,?,?,?,0,?,?)`).run(id,h.userId,h.toBotId,h.fromBotId,text,parent.correlation_id,h.requestId,Math.min(4,parent.depth+1),`ho-result:${h.id}`,now(),now());
}
export function reconcileHandoffs(userId?:string) {
 if(reconciling||!db.open)return;reconciling=true;
 try{
  const rows=db.prepare(`SELECT * FROM handoffs WHERE status IN ('queued','delivered','running') ${userId?'AND user_id=?':''} ORDER BY created_at,id`).all(...(userId?[userId]:[])) as any[];
  for(const row of rows){if(!enabled(row.user_id))continue;
   atomic(()=>{
    const h=handoffView(row),r=db.prepare('SELECT * FROM coordination_requests WHERE id=? AND user_id=?').get(h.requestId,h.userId) as any;
    if(!r){move(h,'failed','request_missing');return;}
    if(!r.job_id){if(now()-h.createdAt>=86400000){db.prepare("UPDATE coordination_requests SET status='failed',reply=0,reason='expired' WHERE id=?").run(r.id);move(h,'expired','not_admitted');}return;}
    const outcome=db.prepare(`SELECT o.* FROM coordination_job_outcomes o JOIN agent_jobs j ON j.id=o.job_id WHERE o.user_id=? AND o.bot_id=? AND
      (json_extract(j.trigger,'$.coordinationRequestId')=? OR o.job_id=?) ORDER BY o.updated_at DESC,j.rowid DESC LIMIT 1`).get(h.userId,h.toBotId,r.id,r.job_id) as any;
    h.jobId=outcome?.job_id??r.job_id;db.prepare('UPDATE handoffs SET job_id=? WHERE id=? AND user_id=?').run(h.jobId,h.id,h.userId);
    if(h.status==='queued')move(h,'delivered');
    const j=db.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(h.jobId,h.userId) as any;
    if(j&&j.state!=='queued'&&h.status==='delivered')move(h,'running');
    if(outcome?.status==='waiting'||pendingDecision(h.toBotId))return;
    if(r.status==='failed'||j&&['uncertain','cancelled'].includes(j.state)){move(h,'failed',r.reason||j.state);return;}
    if(j?.state==='completed'&&(outcome?.status==='completed'||r.status==='completed')){
     const outputRow=db.prepare('SELECT id FROM run_outputs WHERE user_id=? AND job_id=?').get(h.userId,h.jobId) as any;
     const output=outputRow?getOutput(h.userId,outputRow.id):saveOutput({userId:h.userId,botId:h.toBotId,jobId:h.jobId,body:outcome?.final_text??r.result??'',final:true});
     h.resultOutputId=output.id;db.prepare('UPDATE handoffs SET result_output_id=? WHERE id=? AND user_id=?').run(output.id,h.id,h.userId);move(h,'completed');resultReturn(h);
    }
   });
  }
  const loops=db.prepare(`SELECT id,user_id FROM loops WHERE status IN ('running','paused','awaiting_approval') ${userId?'AND user_id=?':''}`).all(...(userId?[userId]:[])) as any[];
  for(const l of loops)if(enabled(l.user_id))driveLoop(l.user_id,l.id);
  drainInternalRequests();
 }finally{reconciling=false;}
}
export function recoverHandoffs() {
 if(!db.open)return;
 const users=db.prepare('SELECT id FROM users').all() as {id:string}[];
 for(const u of users)watchHandoffs(u.id);
 // Outputs are recoverable from durable outcomes even if fan-in was interrupted.
 const jobs=db.prepare(`SELECT o.* FROM coordination_job_outcomes o JOIN agent_jobs j ON j.id=o.job_id LEFT JOIN run_outputs r ON r.job_id=o.job_id
 WHERE j.state='completed' AND o.status='completed' AND (r.id IS NULL OR r.status='draft')`).all() as any[];
 for(const j of jobs)if(enabled(j.user_id))saveOutput({userId:j.user_id,botId:j.bot_id,jobId:j.job_id,body:j.final_text,final:true});
 reconcileHandoffs();
}
