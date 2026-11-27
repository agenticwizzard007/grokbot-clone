import { db,enabled,atomic,now } from './db.js';
import { saveOutput } from './outputs.js';
import type { CoordinationFinish } from '../coordination/requests.js';
/** Called in the settlement transaction, before the final text can be lost. */
export function onJobFinished(input:CoordinationFinish) {
 if(!enabled(input.userId))return;
 const job=db.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(input.jobId,input.userId,input.botId) as any;
 if(!job)return;
 atomic(()=>{
  const trigger=JSON.parse(job.trigger);
  const parent=trigger.parentJobId?db.prepare('SELECT trigger FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(trigger.parentJobId,input.userId,input.botId) as any:null;
  const requestId=trigger.coordinationRequestId??(parent?JSON.parse(parent.trigger).coordinationRequestId:undefined);
  if(requestId)db.prepare(`UPDATE handoff_loop_dispatches SET job_id=? WHERE request_id=? AND loop_id IN (SELECT id FROM loops WHERE user_id=?)`).run(input.jobId,requestId,input.userId);
  if(input.status==='completed'&&job.state==='completed'){
   const output=saveOutput({userId:input.userId,botId:input.botId,jobId:input.jobId,body:input.finalText??'',final:true});
   if(trigger.taskId&&db.prepare('SELECT 1 FROM tasks WHERE id=? AND bot_id=?').get(trigger.taskId,input.botId))db.prepare('UPDATE run_outputs SET task_id=? WHERE id=? AND user_id=?').run(trigger.taskId,output.id,input.userId);
  }
 });
 queueMicrotask(()=>{if(db.open)void import('./reconcile.js').then(m=>{m.watchHandoffs(input.userId);m.scheduleReconciliation(input.userId);}).catch(()=>console.error('[handoff] completion deferred for recovery'));});
}
