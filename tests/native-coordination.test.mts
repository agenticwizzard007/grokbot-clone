import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-coordination-'));
Object.assign(process.env,{DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'coordination-tests-secret',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
const {db}=await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const {acceptJob,beginJob,finishJob}=await import('../server/src/agent/jobs.js');
const {appendRow}=await import('../server/src/store.js');
const c=await import('../server/src/coordination/index.js');
const r=await import('../server/src/coordination/requests.js');
const reports=await import('../server/src/coordination/reports.js');
const w=await import('../server/src/agent/workflows.js');
const {createBot,assertPrimaryRemovalAllowed,transferPrimary}=await import('../server/src/bots.js');
const {initProactive,fireCheckin,setCheckins,tickProactive}=await import('../server/src/proactive.js');
await import('../server/src/deliverables/schema.js');
const awaitImportArtifacts=await import('../server/src/deliverables/artifacts.js');
let seq=0;
const queued:Array<{botId:string;jobId:string;trigger:any}>=[];
let refuse=false;
function enqueue(botId:string,trigger:any) {if(refuse)throw new Error('Queue capacity refused');const job=acceptJob(botId,trigger);queued.push({botId,jobId:job.id,trigger});return job.id;}
beforeEach(()=>{queued.length=0;refuse=false;c.configureCoordinationRuntime({enqueue,interrupt:()=>{}});w.configureWorkflowRuntime({enqueue,interrupt:()=>{}});});
after(()=>{db.close();fs.rmSync(storage,{recursive:true,force:true});});
function fixture(ownerId?:string) {
 const userId=ownerId??`coord-${++seq}`;db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,userId,Date.now());
 const chief=createBot(userId,{name:'Quinn',isPrimary:true}),worker=createBot(userId,{name:'Nia'});
 db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(worker.id);
 return {userId,chief,worker};
}
function settle(f:ReturnType<typeof fixture>,job:typeof queued[number],status='completed',text='Verified facts') {
 if((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(job.jobId) as any).state==='queued')beginJob(job.jobId);
 finishJob(job.jobId,status==='completed'||status==='waiting');c.onCoordinationJobFinished({userId:f.userId,botId:job.botId,jobId:job.jobId,status,finalText:text,trigger:job.trigger});
}
function request(f:ReturnType<typeof fixture>,key='one') {return c.enqueueInternalMessage(f.chief.id,f.worker.id,'Inspect the assignment',0,{idempotencyKey:key});}

test('pending approval, question and connection defer internal requests without altering decisions',()=>{
 for(const kind of ['approval','question','connect']){
 const f=fixture();const card=appendRow(f.worker.id,'card',{type:'card',card:kind,status:'pending',title:'Decision'} as any);
 if(kind==='approval')db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(`approval-${seq}`,f.worker.id,card.seq,'call','save',Date.now());
 const id=request(f);assert.equal(c.getInternalRequest(f.userId,id).status,'deferred');assert.equal(queued.length,0);
 assert.equal((db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(f.worker.id,card.seq) as any).body,JSON.stringify(card.body));
 assert.equal((db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='message'").get(f.worker.id) as any).n,0);
 db.prepare('DELETE FROM rows WHERE bot_id=?').run(f.worker.id);db.prepare('DELETE FROM approvals WHERE bot_id=?').run(f.worker.id);c.drainInternalRequests();assert.equal(c.getInternalRequest(f.userId,id).status,'admitted');queued.length=0;
 }
});
test('queue refusal leaves durable deferred receipt and no delivered-looking transcript',()=>{
 const f=fixture();refuse=true;const id=request(f);const req=c.getInternalRequest(f.userId,id);assert.equal(req.status,'deferred');assert.equal(req.jobId,null);assert.match(req.reason,/capacity/);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(f.worker.id) as any).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_admissions WHERE request_id=?').get(id) as any).n,0);
 refuse=false;c.drainInternalRequests();assert.equal(c.getInternalRequest(f.userId,id).status,'admitted');
});
test('admission binds one owned job and idempotency survives recovery',()=>{
 const f=fixture(),id=request(f);const job=c.getInternalRequest(f.userId,id).jobId;assert.ok(job);
 assert.equal(request(f),id);r.recoverInternalRequests();assert.equal(c.getInternalRequest(f.userId,id).jobId,job);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_admissions WHERE request_id=?').get(id) as any).n,1);
 assert.equal(queued.filter(j=>j.botId===f.worker.id).length,1);assert.equal(queued.at(-1)!.trigger.audience,'internal');
});
test('waiting continuation returns one correlated final result, not result-of-result',()=>{
 const f=fixture(),id=request(f),first=queued.at(-1)!;settle(f,first,'waiting','');assert.equal(c.getInternalRequest(f.userId,id).status,'admitted');
 const continuation=enqueue(f.worker.id,{type:'resume',parentJobId:first.jobId}),next=queued.at(-1)!;
 settle(f,next);assert.equal(c.getInternalRequest(f.userId,id).status,'completed');
 const result=c.listInternalRequests(f.userId).requests.find(r=>r.kind==='result')!;assert.equal(result.parentRequestId,id);assert.equal(result.correlationId,id);assert.equal(result.toBotId,f.chief.id);assert.match(result.text,/Verified facts/);
 c.onCoordinationJobFinished({userId:f.userId,botId:f.worker.id,jobId:continuation,status:'completed',finalText:'Duplicate'});
 assert.equal(c.listInternalRequests(f.userId).requests.filter(r=>r.kind==='result').length,1);
 const returned=queued.find(q=>q.jobId===c.getInternalRequest(f.userId,result.id).jobId)!;settle(f,returned);assert.equal(c.listInternalRequests(f.userId).requests.length,2);
});
test('restart never replays uncertain external execution and reports honest reconciliation',()=>{
 const f=fixture(),id=request(f),job=queued.at(-1)!;beginJob(job.jobId);finishJob(job.jobId,false);r.recoverInternalRequests();
 assert.equal(c.getInternalRequest(f.userId,id).status,'failed');assert.match(c.getInternalRequest(f.userId,id).result!,/reconciliation/);assert.equal(queued.filter(q=>q.botId===f.worker.id).length,1);
});
test('request ownership, pagination and bounded reply ancestry',()=>{
 const f=fixture(),other=fixture(),id=request(f);assert.throws(()=>c.getInternalRequest(other.userId,id),/not found/);
 assert.throws(()=>c.enqueueInternalMessage(f.chief.id,other.worker.id,'foreign',0),/not found/);
 assert.throws(()=>c.enqueueInternalMessage(f.chief.id,f.worker.id,'too deep',5),/limit/);
 assert.throws(()=>c.enqueueInternalMessage(f.worker.id,f.chief.id,'fake parent',0,{parentRequestId:'missing'}),/parent/);
 assert.equal(c.listInternalRequests(other.userId).requests.length,0);
 c.enqueueInternalMessage(f.chief.id,f.worker.id,'Second',0,{idempotencyKey:'two'});const page=c.listInternalRequests(f.userId,0,1);assert.equal(page.hasMore,true);assert.equal(page.requests[0].id,id);assert.equal(c.listInternalRequests(f.userId,page.nextCursor,1).requests.length,1);
});
test('actual human activity suppresses check-ins; bot chatter does not',()=>{
 const f=fixture(),stop=initProactive(enqueue);
 appendRow(f.worker.id,'message',{type:'message',role:'user',text:'Internal',from:{kind:'bot',id:f.chief.id,name:'Quinn'}});
 assert.ok(fireCheckin(f.userId));assert.equal(queued.length,1);assert.match(queued[0].trigger.proactiveSlotKey,/^manual:/);db.prepare("UPDATE agent_jobs SET state='completed' WHERE user_id=?").run(f.userId);
 appendRow(f.worker.id,'message',{type:'message',role:'user',text:'A human asks'});assert.equal(fireCheckin(f.userId),undefined);stop();
});
test('proactive due slots survive refusal and elapsed discovery window until admission',()=>{
 const f=fixture(),stop=initProactive(enqueue);setCheckins(f.userId,{enabled:true,times:['00:01'],timezone:'UTC'});refuse=true;tickProactive(Date.parse('2026-11-12T00:02:00Z'));
 assert.equal((db.prepare('SELECT status FROM proactive_due_slots WHERE user_id=?').get(f.userId) as any).status,'pending');
 assert.equal((db.prepare('SELECT last_fired FROM proactivity WHERE user_id=?').get(f.userId) as any).last_fired,null);
 refuse=false;tickProactive(Date.parse('2026-11-12T00:20:00Z'));assert.equal((db.prepare('SELECT status FROM proactive_due_slots WHERE user_id=?').get(f.userId) as any).status,'admitted');
 const n=queued.filter(q=>q.botId===f.chief.id).length;tickProactive(Date.parse('2026-11-12T00:21:00Z'));assert.equal(queued.filter(q=>q.botId===f.chief.id).length,n);stop();
});
test('sole primary is guarded; transfer requires owned activated permanent worker',()=>{
 const f=fixture(),other=fixture();assert.throws(()=>assertPrimaryRemovalAllowed(f.userId,f.chief.id),/Transfer/);assert.throws(()=>transferPrimary(f.userId,f.chief.id,other.worker.id),/activated/);
 db.prepare("UPDATE bot_setups SET onboarding_status='interviewing' WHERE bot_id=?").run(f.worker.id);assert.throws(()=>transferPrimary(f.userId,f.chief.id,f.worker.id),/activated/);
 db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(f.worker.id);transferPrimary(f.userId,f.chief.id,f.worker.id);assert.doesNotThrow(()=>assertPrimaryRemovalAllowed(f.userId,f.chief.id));assert.throws(()=>assertPrimaryRemovalAllowed(f.userId,f.worker.id),/Transfer/);
});
const criterion={id:'proof',kind:'result' as const,description:'Verified summary',contains:'verified'};
function task(workerBotId:string) {return {key:'research',title:'Research',instructions:'Produce verified research',workerBotId,criteria:[criterion],outputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}};}
test('permanent workflow worker keeps identity, goal lineage, validation and exact-job stop',async()=>{
 const f=fixture();const goal=(await import('../server/src/agent/goals.js')).createGoal(f.userId,f.chief.id,{title:'Review',criteria:[criterion]});
 const wf=w.createWorkflow(f.userId,f.chief.id,{title:'Team research',goalId:goal.id,tasks:[task(f.worker.id)]});w.startWorkflow(f.userId,wf.id);const job=queued.at(-1)!;
 assert.equal(job.botId,f.worker.id);assert.equal((db.prepare('SELECT parent_bot_id FROM bots WHERE id=?').get(f.worker.id) as any).parent_bot_id,null);assert.equal(job.trigger.taskId,wf.tasks[0].id);assert.equal(job.trigger.goalId,goal.id);assert.equal(job.trigger.audience,'internal');
 beginJob(job.jobId);assert.equal(w.workflowPreTurn({userId:f.userId,botId:job.botId,jobId:job.jobId}).allowed,true);
 await w.workflowAfterTurn({userId:f.userId,botId:job.botId,jobId:job.jobId,status:'completed',finalText:'{"summary":"verified research"}',usage:{tokens:0,costUsd:0}});finishJob(job.jobId,true);
 const complete=w.getWorkflow(f.userId,wf.id);assert.equal(complete.status,'completed');assert.equal(complete.tasks[0].workerBotId,f.worker.id);assert.equal(complete.tasks[0].resultValidated,true);assert.equal(complete.tasks[0].status,'completed');
 const returned=c.listInternalRequests(f.userId).requests.find(r=>r.kind==='result')!;assert.ok(returned);assert.equal(returned.toBotId,f.chief.id);assert.equal(returned.correlationId,wf.id);assert.match(returned.text,/verified research/);assert.equal(returned.status,'queued');
 const stopped=w.createWorkflow(f.userId,f.chief.id,{title:'Stop precisely',tasks:[task(f.worker.id)]});w.startWorkflow(f.userId,stopped.id);const bound=queued.at(-1)!;
 const unrelated=acceptJob(f.worker.id,{type:'user',text:'Other work'});const interrupts:any[]=[];w.configureWorkflowRuntime({enqueue,interrupt:(botId,expectedJobId)=>interrupts.push({botId,expectedJobId})});w.controlWorkflow(f.userId,stopped.id,'stop');
 assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(bound.jobId) as any).state,'cancelled');assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(unrelated.id) as any).state,'queued');assert.equal(interrupts.length,0);assert.ok(db.prepare('SELECT 1 FROM bots WHERE id=?').get(f.worker.id));
});
test('workflow rejects foreign, hidden, unapproved or temporary permanent worker choices',()=>{
 const f=fixture(),other=fixture();for(const id of [other.worker.id])assert.throws(()=>w.createWorkflow(f.userId,f.chief.id,{title:'Foreign',tasks:[task(id)]}),/not found/);
 for(const mutation of ["hidden=1","hidden=0,parent_bot_id='"+f.chief.id+"'"]){db.prepare(`UPDATE bots SET ${mutation} WHERE id=?`).run(f.worker.id);assert.throws(()=>w.createWorkflow(f.userId,f.chief.id,{title:'No',tasks:[task(f.worker.id)]}),/activated/);}
 db.prepare('UPDATE bots SET hidden=0,parent_bot_id=NULL WHERE id=?').run(f.worker.id);db.prepare("UPDATE bot_setups SET onboarding_status='interviewing' WHERE bot_id=?").run(f.worker.id);assert.throws(()=>w.createWorkflow(f.userId,f.chief.id,{title:'No',tasks:[task(f.worker.id)]}),/activated/);
});
test('board derives canonical state, source versions and isolates private transcript/account',()=>{
 const f=fixture(),other=fixture();appendRow(f.worker.id,'message',{type:'message',role:'user',text:'PRIVATE NEVER IN BOARD'});request(f);
 const state=c.teamState(f.userId);assert.equal(state.agents.length,2);assert.ok(state.agents.every(a=>[f.worker.id,f.chief.id].includes(a.botId)));assert.equal(state.requests.admitted,1);assert.equal(state.jobs[0].botId,f.worker.id);assert.ok(state.eventCursor>0);assert.doesNotMatch(JSON.stringify(state),/PRIVATE NEVER/);
 assert.equal(c.teamState(other.userId).requests.admitted,0);const version=state.sourceVersions.jobs;settle(f,queued.at(-1)!);assert.notEqual(c.teamState(f.userId).sourceVersions.jobs,version);assert.ok(c.coordinationPrompt(f.userId,f.chief.id).length<25000);assert.equal(c.coordinationPrompt(f.userId,f.worker.id),'');
});
test('Quinn wakes coalesce, persist queue refusal, fence authority and expose independent health',()=>{
 const f=fixture();refuse=true;c.reviewCoordination();let state=c.teamState(f.userId);assert.equal(state.health.runtime,'degraded');assert.ok(state.health.pendingWakes>=1);
 refuse=false;c.reviewCoordination();const wake=db.prepare("SELECT * FROM coordination_wakes WHERE user_id=? AND status='admitted'").get(f.userId) as any;assert.ok(wake);const n=queued.filter(q=>q.botId===f.chief.id).length;c.reviewCoordination();assert.equal(queued.filter(q=>q.botId===f.chief.id).length,n);
 assert.equal(c.coordinationPreTurn({userId:f.userId,botId:f.chief.id,jobId:wake.job_id}).allowed,true);c.setCoordinationEnabled(f.userId,false);assert.equal(c.coordinationPreTurn({userId:f.userId,botId:f.chief.id,jobId:wake.job_id}).allowed,false);assert.equal(c.teamState(f.userId).health.runtime,'disabled');
});
test('daily report coverage requires actual artifact delivery, preserves exact source versions',()=>{
 const f=fixture();db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES(?,?,?,?,?,?)').run('routine-'+seq,f.worker.id,'Current report','Current prompt','0 9 * * *',Date.now());
 const job=acceptJob(f.chief.id,{type:'system',text:'Daily report'});const period='2026-11-12';const before=reports.dailySynopsisContext(f.userId,period);assert.equal(before.sources[0].covered,false);reports.bindReportIntent(f.userId,job.id,period,before.sources);beginJob(job.id);finishJob(job.id,true);reports.reconcileReportCoverage();assert.equal(reports.dailySynopsisContext(f.userId,period).sources[0].covered,false);
 const artifact=(awaitImportArtifacts.recordArtifact)({userId:f.userId,botId:f.chief.id,jobId:job.id,filename:'report.md',content:'Current routine report.\nSource references: '+before.sources.map(s=>`${s.id}@${s.revision}`).join('\n')});
 db.prepare(`INSERT INTO artifact_deliveries(id,user_id,artifact_id,channel,target_json,status,created_at,updated_at) VALUES(?,?,?,'library','{}','unknown',?,?)`).run('delivery-'+seq,f.userId,artifact.id,Date.now(),Date.now());reports.reconcileReportCoverage();assert.equal(reports.dailySynopsisContext(f.userId,period).sources.find(s=>s.kind==='routine')!.covered,false);
 db.prepare("UPDATE artifact_deliveries SET status='delivered' WHERE id=?").run('delivery-'+seq);reports.reconcileReportCoverage();assert.equal(reports.dailySynopsisContext(f.userId,period).sources.find(s=>s.kind==='routine')!.covered,true);
 reports.reconcileReportCoverage();assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_reports WHERE user_id=?').get(f.userId) as any).n,1);
 db.prepare('UPDATE routines SET name=? WHERE id=?').run('Changed report','routine-'+seq);assert.equal(reports.dailySynopsisContext(f.userId,period).sources.find(s=>s.kind==='routine')!.covered,false);
});

test('request admission survives a fresh process and crash rollback without duplicate jobs',()=>{
 const f=fixture(),id=request(f),before=c.getInternalRequest(f.userId,id);
 const program=`const {db}=await import('./server/src/db.ts');const c=await import('./server/src/coordination/index.ts');c.configureCoordinationRuntime({enqueue(){throw Error('Existing admission must not enqueue again')},interrupt(){}});const r=await import('./server/src/coordination/requests.ts');r.recoverInternalRequests();const receipt=c.getInternalRequest(${JSON.stringify(f.userId)},${JSON.stringify(id)});if(receipt.jobId!==${JSON.stringify(before.jobId)}||receipt.status!=='admitted')throw Error('Admission changed');db.close();`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const second=fixture();c.configureCoordinationRuntime({enqueue:(botId,trigger)=>{acceptJob(botId,trigger);throw new Error('Failure after durable admission before receipt');},interrupt:()=>{}});
 const pending=request(second);assert.equal(c.getInternalRequest(second.userId,pending).status,'deferred');assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE user_id=?').get(second.userId) as any).n,0);
 c.configureCoordinationRuntime({enqueue,interrupt:()=>{}});c.drainInternalRequests();assert.equal(c.getInternalRequest(second.userId,pending).status,'admitted');
});
test('explicit idempotency keys are bound to immutable sender, recipient and content',()=>{
 const f=fixture();request(f);assert.throws(()=>c.enqueueInternalMessage(f.chief.id,f.worker.id,'Different assignment',0,{idempotencyKey:'one'}),/already bound/);
});
test('bounded reply ancestry ignores caller attempts to reset depth',()=>{
 const f=fixture();let id=request(f);let from=f.worker.id,to=f.chief.id;
 for(let i=1;i<=4;i++){id=c.enqueueInternalMessage(from,to,'Reply '+i,0,{parentRequestId:id,idempotencyKey:'reply-'+i});assert.equal(c.getInternalRequest(f.userId,id).depth,i);[from,to]=[to,from];}
 assert.throws(()=>c.enqueueInternalMessage(from,to,'Unbounded reply',0,{parentRequestId:id}),/limit/);
});
test('Quinn review coalesces changed state, survives missing completion hook, and does not wake on transcript chatter',()=>{
 const f=fixture();c.reviewCoordination();const wake=db.prepare("SELECT * FROM coordination_wakes WHERE user_id=? AND status='admitted'").get(f.userId) as any;assert.ok(wake);
 const first=queued.find(q=>q.jobId===wake.job_id)!;settle(f,first);const count=queued.filter(q=>q.botId===f.chief.id).length;
 appendRow(f.chief.id,'message',{type:'message',role:'assistant',text:'Internal supervision note'});c.reviewCoordination();assert.equal(queued.filter(q=>q.botId===f.chief.id).length,count);
 // Force a new operational revision while chief is occupied; state revisions coalesce.
 db.prepare('UPDATE coordination_supervision SET last_review_at=NULL WHERE user_id=?').run(f.userId);const busy=acceptJob(f.chief.id,{type:'user',text:'Busy'});
 db.prepare('UPDATE bot_setups SET revision=revision+1 WHERE bot_id=?').run(f.worker.id);c.reviewCoordination();db.prepare('UPDATE bot_setups SET revision=revision+1 WHERE bot_id=?').run(f.worker.id);c.reviewCoordination();
 assert.equal((db.prepare("SELECT COUNT(*) n FROM coordination_wakes WHERE user_id=? AND status='pending'").get(f.userId) as any).n,1);
 db.prepare("UPDATE agent_jobs SET state='completed' WHERE id=?").run(busy.id);c.reviewCoordination();const next=db.prepare("SELECT * FROM coordination_wakes WHERE user_id=? AND status='admitted'").get(f.userId) as any;assert.ok(next);beginJob(next.job_id);finishJob(next.job_id,true);c.reviewCoordination();assert.equal((db.prepare('SELECT status FROM coordination_wakes WHERE id=?').get(next.id) as any).status,'failed');
});
test('team HTTP contracts authenticate, isolate, paginate and reject invalid cursors',async()=>{
 const {Hono}=await import('hono');const {coordinationApi}=await import('../server/src/routes-coordination.js');const app=new Hono().route('/api/team',coordinationApi);
 assert.equal((await app.request('/api/team/state')).status,401);const f=fixture(),other=fixture();request(f);c.enqueueInternalMessage(f.chief.id,f.worker.id,'Second request',0,{idempotencyKey:'second'});
 const token='team-api-'+seq;db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,f.userId,Date.now(),Date.now()+60000);const headers={cookie:'swarm_session='+token};
 const state=await (await app.request('/api/team/state',{headers})).json() as any;assert.equal(state.state.userId,f.userId);assert.equal(state.state.agents.length,2);assert.ok(!JSON.stringify(state).includes(other.userId));
 const page=await (await app.request('/api/team/requests?limit=1',{headers})).json() as any;assert.equal(page.requests.length,1);assert.equal(page.hasMore,true);assert.ok(page.nextCursor>0);
 const events=await (await app.request('/api/team/events?limit=1',{headers})).json() as any;assert.equal(events.events.length,1);assert.ok(events.nextCursor>0);assert.equal(events.events[0].userId,f.userId);
 assert.equal((await app.request('/api/team/events?after=-1',{headers})).status,400);assert.equal((await app.request('/api/team/requests?limit=101',{headers})).status,400);
});
test('report text and unrelated delivered artifacts cannot consume source coverage',()=>{
 const f=fixture();db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES(?,?,?,?,?,?)').run('uncovered-'+seq,f.worker.id,'Unreported routine','Current','0 9 * * *',Date.now());
 const job=acceptJob(f.chief.id,{type:'system',text:'Report'}),period='2026-11-12';reports.bindReportIntent(f.userId,job.id,period);beginJob(job.id);finishJob(job.id,true);
 const a=awaitImportArtifacts.recordArtifact({userId:f.userId,botId:f.chief.id,jobId:job.id,filename:'unrelated.txt',content:'Unrelated output with no exact coverage references'});
 db.prepare("INSERT INTO artifact_deliveries(id,user_id,artifact_id,channel,target_json,status,created_at,updated_at) VALUES(?,?,?,'library','{}','delivered',?,?)").run('unrelated-delivery-'+seq,f.userId,a.id,Date.now(),Date.now());reports.reconcileReportCoverage();
 assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_reports WHERE user_id=?').get(f.userId) as any).n,0);assert.equal(reports.dailySynopsisContext(f.userId,period).sources.find(s=>s.id==='routine:uncovered-'+seq)!.covered,false);
});
test('held migration owners remain unchanged while independent owners recover',async()=>{
 const held=fixture('usr_coordination_held_0001'),active=fixture();refuse=true;const heldId=request(held),activeId=request(active);refuse=false;
 const {holdLegacyDatabase,assertLegacyDatabaseFences}=await import('../server/src/platform/legacy-database-fence.js');holdLegacyDatabase(db,held.userId,'coordination-migration-test','1');
 const snapshot=c.getInternalRequest(held.userId,heldId);r.recoverInternalRequests();c.reviewCoordination();reports.reconcileReportCoverage();assert.deepEqual(c.getInternalRequest(held.userId,heldId),snapshot);assert.equal(c.getInternalRequest(active.userId,activeId).status,'admitted');assert.throws(()=>request(held,'forbidden'),/migrat/);assertLegacyDatabaseFences(db);
});

test('worker activation is revalidated before queued execution and task changes publish durable versions',()=>{
 const f=fixture(),wf=w.createWorkflow(f.userId,f.chief.id,{title:'Activation fence',tasks:[task(f.worker.id)]});w.startWorkflow(f.userId,wf.id);const job=queued.at(-1)!;beginJob(job.jobId);
 db.prepare("UPDATE bot_setups SET onboarding_status='interviewing' WHERE bot_id=?").run(f.worker.id);assert.equal(w.workflowPreTurn({userId:f.userId,botId:f.worker.id,jobId:job.jobId}).allowed,false);
 const event=db.prepare("SELECT * FROM native_events WHERE user_id=? AND source_type='workflow_task' ORDER BY seq DESC LIMIT 1").get(f.userId) as any;assert.ok(event);assert.ok(Number(event.source_revision)>=2);assert.equal(JSON.parse(event.data).status,'queued');
});

test('deleting a former primary preserves other bots, reply chains and canonical coverage cleanup',()=>{
 const f=fixture(),third=createBot(f.userId,{name:'Third'});db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(third.id);
 const original=request(f);c.enqueueInternalMessage(f.worker.id,third.id,'Peer branch',0,{parentRequestId:original,idempotencyKey:'branch'});c.reviewCoordination();
 transferPrimary(f.userId,f.chief.id,f.worker.id);assertPrimaryRemovalAllowed(f.userId,f.chief.id);assert.doesNotThrow(()=>db.prepare('DELETE FROM bots WHERE id=?').run(f.chief.id));
 assert.ok(db.prepare('SELECT 1 FROM bots WHERE id=? AND is_primary=1').get(f.worker.id));const branch=c.listInternalRequests(f.userId).requests.find(r=>r.text==='Peer branch')!;assert.ok(branch);assert.equal(branch.parentRequestId,null);
});

test('atomic final-outcome checkpoint returns original final text once after a fresh-process restart',()=>{
 const f=fixture(),id=request(f),job=queued.at(-1)!;beginJob(job.jobId);
 db.transaction(()=>{finishJob(job.jobId,true);c.recordCoordinationJobOutcome({userId:f.userId,botId:f.worker.id,jobId:job.jobId,status:'completed',finalText:'Durable final research result',trigger:job.trigger});})();
 // Simulate process loss before the after-settlement hook.
 const program=`const {db}=await import('./server/src/db.ts');const r=await import('./server/src/coordination/requests.ts');r.recoverInternalRequests();db.close();`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 assert.equal(c.getInternalRequest(f.userId,id).status,'completed');assert.equal(c.getInternalRequest(f.userId,id).result,'Durable final research result');
 let results=c.listInternalRequests(f.userId).requests.filter(r=>r.kind==='result');assert.equal(results.length,1);assert.match(results[0].text,/Durable final research result/);
 r.recoverInternalRequests();results=c.listInternalRequests(f.userId).requests.filter(r=>r.kind==='result');assert.equal(results.length,1);
});

test('current context remains bounded with large subscription work queues',()=>{
 const f=fixture();const insert=db.prepare("INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at) VALUES(?,?,?,?,'queued',?)");db.transaction(()=>{for(let n=0;n<900;n++)insert.run('large-queue-'+seq+'-'+n,f.userId,f.worker.id,JSON.stringify({type:'system',text:'Queued work'}),Date.now());})();
 const prompt=c.coordinationPrompt(f.userId,f.chief.id);assert.ok(prompt.length<25000,`Operational context grew to ${prompt.length}`);assert.ok(c.teamState(f.userId).agents.find(a=>a.botId===f.worker.id)!.activeJobIds.length===900);
});
test('stable request identity survives more than 32 approval continuations and final-outcome replay',()=>{
 const f=fixture(),id=request(f);let job=queued.at(-1)!;settle(f,job,'waiting','');let parent=job.jobId;
 for(let n=0;n<40;n++){const next=acceptJob(f.worker.id,{type:'resume',parentJobId:parent,coordinationRequestId:id,audience:'internal'});beginJob(next.id);finishJob(next.id,true);c.recordCoordinationJobOutcome({userId:f.userId,botId:f.worker.id,jobId:next.id,status:n===39?'completed':'waiting',finalText:n===39?'Final after long continuation chain':''});parent=next.id;}
 r.recoverInternalRequests();assert.equal(c.getInternalRequest(f.userId,id).status,'completed');assert.equal(c.getInternalRequest(f.userId,id).result,'Final after long continuation chain');assert.equal(c.listInternalRequests(f.userId).requests.filter(r=>r.kind==='result').length,1);
});

test('visible permanent workers without approved setup remain deferred',()=>{
 const f=fixture();db.prepare('DELETE FROM bot_setups WHERE bot_id=?').run(f.worker.id);const id=request(f);assert.equal(c.getInternalRequest(f.userId,id).status,'deferred');assert.match(c.getInternalRequest(f.userId,id).reason,/activated/);assert.equal(queued.length,0);
});
