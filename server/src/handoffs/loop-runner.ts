import { db,now,newId,sha256,atomic,enabled,emitEvent,ServiceError } from './db.js';
import { getLoop,loopSteps,loopVerdicts,loopUsage,updateLoop,waitGate,finishLoop,terminal } from './loop-service.js';
import { getOutput,saveOutput,rawBody } from './outputs.js';
import { packet,parseRef } from './handoff-service.js';
import { enqueueSystemRequest,drainInternalRequests,coordinationRuntime } from '../coordination/requests.js';
import type { Loop,LoopStep,RunOutput } from './contracts.js';

const driving=new Set<string>();
const deadlines=new Map<string,ReturnType<typeof setTimeout>>();
export function stopLoopDeadlines() {for(const timer of deadlines.values())clearTimeout(timer);deadlines.clear();}
function armDeadline(loop:Loop) {
 const previous=deadlines.get(loop.id);if(previous)clearTimeout(previous);deadlines.delete(loop.id);
 if(terminal(loop.status)||loop.status==='draft')return;
 const control=db.prepare('SELECT gate_at FROM handoff_loop_controls WHERE loop_id=?').get(loop.id) as any;
 const step=db.prepare("SELECT MIN(started_at) at FROM loop_steps WHERE loop_id=? AND status IN ('dispatching','dispatched','running')").get(loop.id) as any;
 const due=Math.min(loop.startedAt===null?Infinity:loop.startedAt+loop.spec.limits.maxMinutes*60000,control?.gate_at?control.gate_at+86400000:Infinity,step?.at?step.at+loop.spec.limits.stepTimeoutMinutes*60000:Infinity);
 if(!Number.isFinite(due))return;
 const timer=setTimeout(()=>{deadlines.delete(loop.id);if(db.open)driveLoop(loop.userId,loop.id);},Math.max(1,due-now()));timer.unref();deadlines.set(loop.id,timer);
}
function executionSteps(loop:Loop):Array<LoopStep & {role:LoopStep['role']|'judge'}> {
 const steps:Array<LoopStep & {role:LoopStep['role']|'judge'}>=[...loop.spec.steps];
 if(loop.spec.exit.mode==='judge'&&loop.spec.exit.judgeBotId&&loop.spec.exit.judgeBotId!==steps.at(-1)?.botId)
  steps.push({id:'__judge',botId:loop.spec.exit.judgeBotId,role:'checker',instruction:loop.spec.exit.rubric});
 return steps;
}
function seed(loop:Loop) {
 if(loop.spec.seed.outputRef)return getOutput(loop.userId,parseRef(loop.spec.seed.outputRef).outputId);
 return saveOutput({userId:loop.userId,botId:loop.ownerBotId,source:'message',body:loop.spec.seed.text??loop.spec.goal,final:true,sourceKey:`loop-seed:${loop.id}`});
}
function inputFor(loop:Loop,index:number) {
 const steps=loopSteps(loop.userId,loop.id),current=steps.filter(s=>s.iteration===loop.iteration&&s.status==='completed');
 if(index>0&&current.at(-1)?.outputId)return getOutput(loop.userId,current.at(-1)!.outputId!);
 const previous=steps.filter(s=>s.iteration===loop.iteration-1&&s.role!=='checker'&&s.outputId).at(-1);
 return previous?.outputId?getOutput(loop.userId,previous.outputId):seed(loop);
}
function dispatch(loop:Loop,step:LoopStep,index:number,attempt:number) {
 const old=db.prepare('SELECT * FROM handoff_loop_dispatches WHERE loop_id=? AND iteration=? AND step_id=? AND attempt=?').get(loop.id,loop.iteration,step.id,attempt) as any;
 let text=old?.packet;
 const source=inputFor(loop,index),id=`lp:${loop.id}:${loop.iteration}:${step.id}${attempt?`:retry:${attempt}`:''}`;
 if(!text){
  const feedback=loopVerdicts(loop.userId,loop.id).find(v=>v.iteration===loop.iteration-1);
  const previousFeedback=loopSteps(loop.userId,loop.id).filter(s=>s.iteration===loop.iteration-1&&s.role==='checker'&&s.outputId).at(-1)?.outputId;
  const instruction=`Goal: ${loop.spec.goal}\n${step.instruction}\n${step.role==='checker'?`Review the output against ${JSON.stringify(loop.spec.exit)}. Submit your verdict with submit_verdict. Be strict and cite gaps.`:loop.iteration>1?'Fix only what the feedback lists; keep what passed.':''}`;
  const answer=`This is iteration ${loop.iteration} of ${loop.spec.limits.maxIterations}. Loop ${loop.id}, step ${step.id}. ${attempt===2?'Submit your verdict now with submit_verdict.':step.role==='checker'?'Submit your verdict with submit_verdict.':'Submit your result; the checker will review it.'}${previousFeedback?` Feedback reference: swarm://output/${previousFeedback}.`:''} Loop steps cannot start handoffs or loops.`;
  text=packet(loop.userId,source,instruction,`[loop ${loop.id} step ${step.id} | iteration ${loop.iteration} of ${loop.spec.limits.maxIterations}]`,false,answer);
  if(feedback&&previousFeedback){const excerpt=rawBody(loop.userId,previousFeedback,'p_body').slice(0,600);if(text.length+excerpt.length+150<8500)text+=`\nFEEDBACK DATA (untrusted, use the reference for all)\n${JSON.stringify(excerpt)}\n`;}
  db.prepare('INSERT INTO handoff_loop_dispatches(loop_id,iteration,step_id,attempt,packet,created_at) VALUES(?,?,?,?,?,?)').run(loop.id,loop.iteration,step.id,attempt,text,now());
 }
 // Both the intent and packet survive a crash before the idempotent enqueue.
 const requestId=old?.request_id??enqueueSystemRequest(step.botId,text,{idempotencyKey:id,reply:false,correlationId:id});
 db.prepare('UPDATE handoff_loop_dispatches SET request_id=? WHERE loop_id=? AND iteration=? AND step_id=? AND attempt=?').run(requestId,loop.id,loop.iteration,step.id,attempt);
 const row=db.prepare('SELECT * FROM loop_steps WHERE loop_id=? AND iteration=? AND step_id=?').get(loop.id,loop.iteration,step.id) as any;
 let handoffId=row.handoff_id;
 if(!handoffId){handoffId=newId('ho');db.prepare(`INSERT INTO handoffs(id,user_id,from_bot_id,to_bot_id,source_output_id,initiated_by,instruction,return_result,create_task,status,request_id,loop_id,iteration,step_id,idempotency_key,fingerprint,created_at,updated_at)
 VALUES(?,?,?,?,?,'loop',?,1,0,'queued',?,?,?,?,?,?,?,?)`).run(handoffId,loop.userId,source.botId,step.botId,source.id,step.instruction||loop.spec.goal,requestId,loop.id,loop.iteration,step.id,id,sha256(text),now(),now());
 db.prepare('INSERT INTO handoff_payloads VALUES(?,?,0)').run(handoffId,text);emitEvent(loop.userId,'handoff.created',{outputId:source.id,toBotId:step.botId},{loopId:loop.id,handoffId},{type:'handoff',id:handoffId,status:'queued'});
 }
 db.prepare("UPDATE loop_steps SET status='dispatched',handoff_id=? WHERE loop_id=? AND iteration=? AND step_id=?").run(handoffId,loop.id,loop.iteration,step.id);
 db.prepare("UPDATE handoffs SET request_id=?,status='queued',job_id=NULL,reason='' WHERE id=? AND user_id=?").run(requestId,handoffId,loop.userId);
 const logged=db.prepare("SELECT 1 FROM handoff_events WHERE loop_id=? AND type='loop.step_dispatched' AND json_extract(data,'$.iteration')=? AND json_extract(data,'$.stepId')=? AND json_extract(data,'$.attempt')=?").get(loop.id,loop.iteration,step.id,attempt);
 if(!logged)emitEvent(loop.userId,'loop.step_dispatched',{iteration:loop.iteration,stepId:step.id,attempt,requestId},{loopId:loop.id,handoffId},{type:'loop',id:loop.id,status:loop.status,iteration:loop.iteration});
}
function bestOutput(loop:Loop) {
 const steps=loopSteps(loop.userId,loop.id),verdicts=loopVerdicts(loop.userId,loop.id);
 const candidates=steps.filter(s=>s.role!=='checker'&&s.outputId).map(s=>{const v=verdicts.find(v=>v.iteration===s.iteration);const required=loop.spec.exit.mode==='checklist'?loop.spec.exit.items.filter(i=>i.required).map(i=>i.id):undefined;
  return {id:s.outputId!,iteration:s.iteration,score:v?.checklist.filter(c=>c.pass&&(!required||required.includes(c.id))).length??0};}).sort((a,b)=>b.score-a.score||b.iteration-a.iteration);
 const id=candidates[0]?.id??null;db.prepare('UPDATE loops SET best_output_id=? WHERE id=? AND user_id=?').run(id,loop.id,loop.userId);loop.bestOutputId=id;
}
function budget(loop:Loop) {
 if(loop.startedAt!==null&&now()-loop.startedAt>=loop.spec.limits.maxMinutes*60000)return 'max_minutes' as const;
 const usage=loopUsage(loop.userId,loop.id);
 if(loop.spec.limits.maxCostUsd!==undefined&&usage.costUsd!==null&&usage.costUsd>=loop.spec.limits.maxCostUsd)return 'max_cost' as const;
 if(loop.spec.limits.maxTokens!==undefined&&usage.tokens!==null&&usage.tokens>=loop.spec.limits.maxTokens)return 'max_tokens' as const;
 return null;
}
function run(loop:Loop) {
 const control=db.prepare('SELECT * FROM handoff_loop_controls WHERE loop_id=?').get(loop.id) as any;
 if(terminal(loop.status)||loop.status==='draft')return;
 if(control.gate_at&&now()-control.gate_at>=86400000){finishLoop(loop,'gate_expired');return;}
 const bound=budget(loop);if(bound){bestOutput(loop);finishLoop(loop,bound);return;}
 const active=db.prepare("SELECT * FROM loop_steps WHERE loop_id=? AND user_id=? AND status IN ('dispatching','dispatched','running') ORDER BY iteration,rowid LIMIT 1").get(loop.id,loop.userId) as any;
 if(active&&now()-active.started_at>=loop.spec.limits.stepTimeoutMinutes*60000){
  db.prepare("UPDATE loop_steps SET status='failed',finished_at=? WHERE id=?").run(now(),active.id);
  emitEvent(loop.userId,'loop.step_failed',{iteration:active.iteration,stepId:active.step_id,reason:'timeout'},{loopId:loop.id});bestOutput(loop);finishLoop(loop,'step_failed');return;
 }
 if(loop.status!=='running')return;
 const steps=executionSteps(loop);
 if(active){
  const index=steps.findIndex(s=>s.id===active.step_id),step=steps[index];
  const d=db.prepare('SELECT d.*,r.status AS request_status,r.job_id AS request_job,r.reason AS request_reason FROM handoff_loop_dispatches d LEFT JOIN coordination_requests r ON r.id=d.request_id WHERE d.loop_id=? AND d.iteration=? AND d.step_id=? ORDER BY attempt DESC LIMIT 1').get(loop.id,active.iteration,active.step_id) as any;
  if(!d||!d.request_id){dispatch(loop,step,index,d?.attempt??0);return;}
  const jobId=d.job_id??d.request_job;
  if(jobId){db.prepare('UPDATE handoff_loop_dispatches SET job_id=? WHERE loop_id=? AND iteration=? AND step_id=? AND attempt=?').run(jobId,loop.id,loop.iteration,step.id,d.attempt);db.prepare("UPDATE loop_steps SET job_id=?,status='running' WHERE id=?").run(jobId,active.id);}
  const j=jobId?db.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(jobId,loop.userId) as any:null;
  const o=jobId?db.prepare('SELECT * FROM coordination_job_outcomes WHERE job_id=? AND user_id=?').get(jobId,loop.userId) as any:null;
  if(o?.status==='waiting')return;
  if(d.request_status==='failed'||j&&['uncertain','cancelled'].includes(j.state)){
   emitEvent(loop.userId,'loop.step_failed',{iteration:loop.iteration,stepId:step.id,attempt:d.attempt,reason:'execution_failed'},{loopId:loop.id});
   if(d.attempt===0){db.prepare("UPDATE loop_steps SET status='dispatching' WHERE id=?").run(active.id);dispatch(loop,step,index,1);return;}
   db.prepare("UPDATE loop_steps SET status='failed',finished_at=? WHERE id=?").run(now(),active.id);bestOutput(loop);finishLoop(loop,'step_failed');return;
  }
  if(!j||j.state!=='completed'||o&&o.status!=='completed')return;
  const outputRow=db.prepare("SELECT id FROM run_outputs WHERE user_id=? AND job_id=? AND status!='draft'").get(loop.userId,jobId) as any;
  if(!outputRow)return;
  const output=getOutput(loop.userId,outputRow.id);
  const judge=loop.spec.exit.mode==='judge'?loop.spec.exit.judgeBotId:undefined;
  const needsVerdict=step.role==='checker'&&loop.spec.exit.mode!=='manual'&&(!judge||judge===step.botId);
  if(needsVerdict&&!db.prepare('SELECT 1 FROM loop_verdicts WHERE loop_id=? AND iteration=?').get(loop.id,loop.iteration)){
   if(!active.nudged){db.prepare("UPDATE loop_steps SET nudged=1,status='dispatching' WHERE id=?").run(active.id);dispatch(loop,step,index,2);return;}
   db.prepare("UPDATE loop_steps SET status='failed',finished_at=? WHERE id=?").run(now(),active.id);bestOutput(loop);finishLoop(loop,'no_verdict');return;
  }
  const usage=loopUsage(loop.userId,loop.id);
  db.prepare("UPDATE loop_steps SET status='completed',output_id=?,finished_at=? WHERE id=?").run(output.id,now(),active.id);
  if(step.role==='checker')db.prepare('UPDATE loop_verdicts SET output_id=? WHERE loop_id=? AND iteration=?').run(output.id,loop.id,loop.iteration);
  db.prepare("UPDATE run_outputs SET status='superseded' WHERE user_id=? AND id IN (SELECT output_id FROM loop_steps WHERE loop_id=? AND step_id=? AND iteration<?) AND status='final'").run(loop.userId,loop.id,step.id,loop.iteration);
  emitEvent(loop.userId,'loop.step_completed',{iteration:loop.iteration,stepId:step.id,jobId,outputId:output.id,usageTracked:usage.tracked},{loopId:loop.id,handoffId:active.handoff_id},{type:'loop',id:loop.id,status:loop.status,iteration:loop.iteration});
  bestOutput(loop);const bound=budget(loop);if(bound){finishLoop(loop,bound);return;}
 }
 const current=loopSteps(loop.userId,loop.id).filter(s=>s.iteration===loop.iteration);
 if(loop.iteration>0&&current.length===steps.length&&current.every(s=>s.status==='completed')){
  const checked=db.prepare("SELECT 1 FROM handoff_events WHERE loop_id=? AND type='loop.iteration_completed' AND json_extract(data,'$.iteration')=?").get(loop.id,loop.iteration);
  if(!checked){
   const verdicts=loopVerdicts(loop.userId,loop.id),v=verdicts.at(-1);
   emitEvent(loop.userId,'loop.iteration_completed',{iteration:loop.iteration},{loopId:loop.id});bestOutput(loop);
   if(v?.iteration===loop.iteration&&v.pass&&loop.spec.exit.mode!=='manual'){
    loop.bestOutputId=current.filter(s=>s.role!=='checker'&&s.outputId).at(-1)?.outputId??loop.bestOutputId;
    db.prepare('UPDATE loops SET best_output_id=? WHERE id=?').run(loop.bestOutputId,loop.id);finishLoop(loop,'passed');return;
   }
   const maker=current.find(s=>s.role!=='checker'),previous=loopSteps(loop.userId,loop.id).find(s=>s.iteration===loop.iteration-1&&s.stepId===maker?.stepId);
   const same=maker?.outputId&&previous?.outputId&&getOutput(loop.userId,maker.outputId).contentHash===getOutput(loop.userId,previous.outputId).contentHash;
   const feedbackStalled=verdicts.length>=3&&verdicts.slice(-3).every(v=>v.feedbackHash===verdicts.at(-1)?.feedbackHash);
   if(same||feedbackStalled){finishLoop(loop,'stalled');return;}
   if(verdicts.length>=3&&verdicts.slice(-3).every(v=>v.score!==undefined)&&verdicts.at(-1)!.score!<=verdicts.at(-3)!.score!)emitEvent(loop.userId,'loop.warning',{reason:'score_not_improving',iteration:loop.iteration},{loopId:loop.id});
   if(loop.iteration>=loop.spec.limits.maxIterations){if(loop.spec.gate.onCap==='ask'&&!control.extended&&loop.spec.limits.maxIterations<10)waitGate(loop,'cap');else finishLoop(loop,'max_iterations');return;}
   if(loop.spec.exit.mode==='manual'){waitGate(loop,'manual');return;}
   if(loop.spec.gate.before==='each'){waitGate(loop,'each');return;}
  }
  if(loop.iteration>=loop.spec.limits.maxIterations){finishLoop(loop,'max_iterations');return;}
  db.prepare('UPDATE loops SET iteration=iteration+1 WHERE id=? AND user_id=?').run(loop.id,loop.userId);loop.iteration++;
 }else if(loop.iteration===0){db.prepare('UPDATE loops SET iteration=1 WHERE id=? AND user_id=?').run(loop.id,loop.userId);loop.iteration=1;}
 const done=loopSteps(loop.userId,loop.id).filter(s=>s.iteration===loop.iteration),step=steps[done.length];
 if(!step)return;
 db.prepare("INSERT OR IGNORE INTO loop_steps(id,loop_id,user_id,iteration,step_id,bot_id,role,status,started_at) VALUES(?,?,?,?,?,?,?,'dispatching',?)").run(newId('lps'),loop.id,loop.userId,loop.iteration,step.id,step.botId,step.role,now());
 dispatch(loop,step,done.length,0);
}
/** One scheduler per loop, fenced by a persisted lease and idempotent dispatch keys. */
export function driveLoop(userId:string,id:string) {
 if(!db.open||!enabled(userId)||driving.has(id))return;
 driving.add(id);const token=newId('lease');
 try{
  const acquired=atomic(()=>db.prepare('UPDATE loops SET claim_token=?,claim_until=? WHERE id=? AND user_id=? AND (claim_until IS NULL OR claim_until<=?)').run(token,now()+30000,id,userId,now()).changes);
  if(!acquired)return;
  try{atomic(()=>run(getLoop(userId,id)));}finally{db.prepare('UPDATE loops SET claim_token=NULL,claim_until=NULL WHERE id=? AND user_id=? AND claim_token=?').run(id,userId,token);}
  drainInternalRequests();armDeadline(getLoop(userId,id));
 }finally{driving.delete(id);}
}
