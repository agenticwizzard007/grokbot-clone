import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'ho-b-fixture-'));
Object.assign(process.env,{SWARM_ROLE:'standalone',SWARM_NO_SCHEDULER:'1',NODE_ENV:'test',DB_PATH:path.join(storage,'fixture.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'placeholder-handoff-secret',COMPUTER_PROVIDER:'local',DIRECT_API_KEY:'fixture',DIRECT_BASE_URL:'http://127.0.0.1:9/v1',LLM_PROVIDER:'direct',COMPOSIO_API_KEY:'',ADMIN_EMAILS:'',INKBOX_TUNNEL:'0'});
export const {db}=await import('../../server/src/db.js');
(await import('../../server/src/agent/subagents.js')).initSubagents();
(await import('../../server/src/agent/rooms.js')).initRooms();
export const {createBot}=await import('../../server/src/bots.js');
export const jobs=await import('../../server/src/agent/jobs.js');
export const requests=await import('../../server/src/coordination/requests.js');
export const outputs=await import('../../server/src/handoffs/outputs.js');
export const handoffs=await import('../../server/src/handoffs/handoff-service.js');
export const loops=await import('../../server/src/handoffs/loop-service.js');
export const runner=await import('../../server/src/handoffs/loop-runner.js');
export const reconcile=await import('../../server/src/handoffs/reconcile.js');
export const hooks=await import('../../server/src/handoffs/hooks.js');
export const links=await import('../../server/src/handoffs/link-service.js');
export const hdb=await import('../../server/src/handoffs/db.js');
export const {hub}=await import('../../server/src/lib/hub.js');
export const {recordArtifact}=await import('../../server/src/deliverables/artifacts.js');
await import('../../server/src/usage.js');
const {handoffsApi}=await import('../../server/src/routes-handoffs.js');
export const app=new Hono().route('/api',handoffsApi);
let n=0;
export const interrupted:string[]=[];
requests.configureCoordinationRuntime({enqueue:(botId,trigger)=>jobs.acceptJob(botId,trigger).id,interrupt:(_botId,jobId)=>{if(jobId){interrupted.push(jobId);db.prepare("UPDATE agent_jobs SET state='cancelled',finished_at=? WHERE id=? AND state IN ('queued','running')").run(Date.now(),jobId);}}});
export function fixture() {
 const userId=`fixture-user-${++n}`,at=Date.now();db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,'QA-Temp-Handoff',at);
 const maker=createBot(userId,{name:'Maker fixture'}),checker=createBot(userId,{name:'Checker fixture'});
 db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id IN (?,?)").run(maker.id,checker.id);
 const token=`fixture-session-${n}`;db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,userId,at,at+3600000);
 return {userId,maker,checker,headers:{cookie:`swarm_session=${token}`,'content-type':'application/json'}};
}
export type Fixture=ReturnType<typeof fixture>;
export function spec(f:Fixture,overrides:any={}) {
 return {name:'Release notes fixture',goal:'Write three release note bullets with a version, fewer than 60 words, and a final call to action.',kind:'maker_checker',steps:[{id:'maker',botId:f.maker.id,role:'maker',instruction:'Draft the release notes.'},{id:'checker',botId:f.checker.id,role:'checker',instruction:'Check every required item.'}],seed:{text:'Placeholder release brief.'},exit:{mode:'checklist',items:[{id:'version',text:'Mentions the version',required:true},{id:'short',text:'Fewer than 60 words',required:true},{id:'action',text:'Ends with a call to action',required:true}]},limits:{maxIterations:3,maxMinutes:30,stepTimeoutMinutes:10},gate:{before:'none',onCap:'stop'},...overrides} as any;
}
export function makeLoop(f:Fixture,overrides:any={},start=true) {return loops.createLoop(f.userId,{spec:spec(f,overrides),idempotencyKey:`loop-${++n}`,start}).loop;}
export function finish(f:Fixture,jobId:string,text:string,status='completed') {
 jobs.beginJob(jobId);const job=db.prepare('SELECT bot_id FROM agent_jobs WHERE id=? AND user_id=?').get(jobId,f.userId) as any;
 hdb.atomic(()=>{jobs.finishJob(jobId,status==='completed');const input={userId:f.userId,botId:job.bot_id,jobId,status,finalText:text};requests.recordCoordinationJobOutcome(input);hooks.onJobFinished(input);});
 requests.onInternalJobFinished({userId:f.userId,botId:job.bot_id,jobId,status,finalText:text});reconcile.reconcileHandoffs(f.userId);
}
export async function flush(f?:Fixture) {for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));if(f)reconcile.reconcileHandoffs(f.userId);}}
export async function runLoop(f:Fixture,id:string,mode:'converge'|'cap'|'stall'|'no-verdict'|'fail'='converge') {
 for(let count=0;count<80;count++){
  await flush(f);runner.driveLoop(f.userId,id);const loop=loops.getLoop(f.userId,id);if(loops.terminal(loop.status)||['paused','awaiting_approval'].includes(loop.status))return loop;
  const job=db.prepare("SELECT * FROM agent_jobs WHERE user_id=? AND state IN ('queued','running') ORDER BY rowid LIMIT 1").get(f.userId) as any;
  if(!job)throw new Error(`No job: ${JSON.stringify(loops.loopSteps(f.userId,id))}`);
  const step=loops.loopSteps(f.userId,id).find(s=>s.jobId===job.id)??loops.loopSteps(f.userId,id).at(-1)!;
  jobs.beginJob(job.id);
  if(step.role==='checker'&&mode!=='no-verdict'&&mode!=='fail')loops.submitVerdict({userId:f.userId,botId:job.bot_id,jobId:job.id,toolCallId:`verdict-${count}`},{pass:mode==='converge'&&loop.iteration>=3,score:loop.iteration/10,checklist:['version','short','action'].map((key,index)=>({id:key,pass:mode==='converge'?index<loop.iteration:index===0,note:'Fixture evidence.'})),feedback:`Fixture feedback pass ${loop.iteration}: fix item ${loop.iteration+1}.`});
  const text=step.role==='checker'?`Feedback for pass ${loop.iteration}.`:mode==='stall'?'Same fixture output.':`- Version ${loop.iteration}.0\n- Placeholder change for pass ${loop.iteration}.\n- ${loop.iteration>=3?'Try the release.':'More details soon.'}`;
  finish(f,job.id,text,mode==='fail'?'failed':'completed');
 }
 throw new Error('Fixture loop exceeded driver bound.');
}
export function output(f:Fixture,body='Fixture output.') {const job=jobs.acceptJob(f.maker.id,{type:'user',text:'Fixture request'});finish(f,job.id,body);return outputs.outputByJob(f.userId,job.id);}
export function cleanup(){runner.stopLoopDeadlines();reconcile.stopHandoffRecovery();if(db.open)db.close();fs.rmSync(storage,{recursive:true,force:true});}
