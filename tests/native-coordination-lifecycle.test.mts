import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Hono } from 'hono';

const storage=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-coordination-lifecycle-'));
Object.assign(process.env,{SWARM_ROLE:'standalone',SWARM_NO_SCHEDULER:'1',NODE_ENV:'test',DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'coordination-lifecycle-test',COMPUTER_PROVIDER:'local',DIRECT_API_KEY:'fixture',DIRECT_BASE_URL:'http://127.0.0.1:9/v1',LLM_PROVIDER:'direct',COMPOSIO_API_KEY:'',ADMIN_EMAILS:'',INKBOX_TUNNEL:'0'});
const {db}=await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const {createBot}=await import('../server/src/bots.js');
const {enqueue,settleAgentJobs,interrupt,turnSignal}=await import('../server/src/agent/loop.js');
const {enqueueInternalMessage,getInternalRequest,listInternalRequests}=await import('../server/src/coordination/index.js');
const {api}=await import('../server/src/routes.js');
const {llmClient}=await import('../server/src/lib/llm.js');
const {withUsage}=await import('../server/src/usage.js');
const {saveMcpServer,mcpToolName}=await import('../server/src/mcp/store.js');
const {testMcpServer,closeMcpSessions}=await import('../server/src/mcp/client.js');
let sequence=0,writes=0,modelCalls=0;
const message=(text:string)=>({type:'message',id:'message-'+(++sequence),role:'assistant',content:[{type:'output_text',text}]});
const call=(name:string,args:unknown)=>({type:'function_call',call_id:'call-'+(++sequence),name,arguments:JSON.stringify(args)});
let model:(body:any)=>any[]|Promise<any[]>=()=>[message('Finished.')];
const client=withUsage({userId:'fixture'},()=>llmClient(360000));
mock.method(client.responses,'create',async(body:any)=>{modelCalls++;const output=await model(body);return(async function*(){for(const item of output){yield{type:'response.output_item.added',item};if(item.type==='message')yield{type:'response.output_text.delta',delta:item.content[0].text};yield{type:'response.output_item.done',item};}yield{type:'response.completed',response:{output,usage:{input_tokens:2,output_tokens:2,total_tokens:4}}};})();});
mock.method(Client.prototype,'connect',async()=>{});mock.method(Client.prototype,'close',async()=>{});
mock.method(Client.prototype,'listTools',async()=>({tools:[{name:'write',inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}]}));
mock.method(Client.prototype,'callTool',async()=>{writes++;return{content:[{type:'text',text:'Saved'}]};});
const app=new Hono().route('/api',api);
after(async()=>{await settleAgentJobs();await closeMcpSessions();mock.restoreAll();db.close();fs.rmSync(storage,{recursive:true,force:true});});
function fixture(label:string){const userId='lifecycle-'+label;db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,userId+'@example.test',label,Date.now());const chief=createBot(userId,{name:'Quinn',isPrimary:true}),worker=createBot(userId,{name:'Nia'});db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(worker.id);const token='session-'+label;db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,userId,Date.now(),Date.now()+60000);return{userId,chief,worker,headers:{cookie:'swarm_session='+token,'content-type':'application/json'}};}
function card(f:ReturnType<typeof fixture>,kind:string){const row=db.prepare("SELECT * FROM rows WHERE bot_id=? AND kind='card' AND json_extract(body,'$.card')=? ORDER BY seq DESC LIMIT 1").get(f.worker.id,kind) as any;assert.ok(row,'Expected '+kind+' card');return{...row,body:JSON.parse(row.body)};}
function jobCount(f:ReturnType<typeof fixture>){return(db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE user_id=?').get(f.userId) as any).n as number;}
function answerCount(f:ReturnType<typeof fixture>){return(db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='user' AND COALESCE(json_extract(body,'$.from.kind'),'human')!='bot'").get(f.worker.id) as any).n as number;}
function postAnswer(f:ReturnType<typeof fixture>,seq:number,answer:string){return app.request(`/api/bots/${f.worker.id}/cards/${seq}/answer`,{method:'POST',headers:f.headers,body:JSON.stringify({answer})});}
async function waitingQuestion(label:string){const f=fixture(label);model=()=>[call('ask_user',{question:'Which source should I use?',options:['Approved source','Alternative']})];const requestId=enqueueInternalMessage(f.chief.id,f.worker.id,'Inspect the assignment and ask which source to use.',0);await settleAgentJobs();assert.equal(getInternalRequest(f.userId,requestId).status,'admitted');return{...f,requestId,question:card(f,'question')};}
async function waitingApproval(label:string){const f=fixture(label);const server=(await testMcpServer(saveMcpServer(f.userId,{name:'Write fixture',transport:'http',url:'https://fixture.example/mcp',botIds:[f.worker.id]})))!;model=()=>[call(mcpToolName(server,'write'),{value:1})];const requestId=enqueueInternalMessage(f.chief.id,f.worker.id,'Save the requested fixture record.',0);await settleAgentJobs();const approval=db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").get(f.worker.id) as any;assert.ok(approval);const pending=db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(f.worker.id) as any;assert.ok(pending);return{...f,requestId,approval,pending:JSON.parse(pending.state)};}

test('HTTP duplicate answers return the first admitted job; conflicts do not enqueue or expose internal output',async()=>{
 const f=await waitingQuestion('answer-retry');model=()=>[message('Internal source selection completed.')];const first=await postAnswer(f,f.question.seq,'Approved source');assert.equal(first.status,200);const admitted=await first.json() as any;assert.ok(admitted.jobId);await settleAgentJobs();const count=jobCount(f),humanRows=answerCount(f);
 const duplicate=await postAnswer(f,f.question.seq,'Approved source');assert.equal(duplicate.status,200);assert.equal((await duplicate.json() as any).jobId,admitted.jobId);const conflict=await postAnswer(f,f.question.seq,'Alternative');assert.equal(conflict.status,409);await settleAgentJobs();assert.equal(jobCount(f),count);assert.equal(answerCount(f),humanRows);assert.equal(humanRows,1);
 const trigger=JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(admitted.jobId) as any).trigger);assert.equal(trigger.parentJobId,f.question.body.jobId);assert.equal(trigger.audience,'internal');assert.equal(trigger.coordinationRequestId,f.requestId);assert.equal((db.prepare('SELECT unread FROM bots WHERE id=?').get(f.worker.id) as any).unread,0);
 assert.equal(getInternalRequest(f.userId,f.requestId).status,'completed');assert.equal(listInternalRequests(f.userId).requests.filter(r=>r.kind==='result').length,1);
});
test('concurrent identical HTTP answers admit exactly one continuation',async()=>{
 const f=await waitingQuestion('answer-race');model=()=>[message('Internal answer processed.')];const responses=await Promise.all([postAnswer(f,f.question.seq,'Approved source'),postAnswer(f,f.question.seq,'Approved source')]);assert.ok(responses.every(r=>r.status===200));const bodies=await Promise.all(responses.map(r=>r.json())) as any[];await settleAgentJobs();assert.equal(bodies[0].jobId,bodies[1].jobId);assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=?").get(f.worker.id,f.question.body.jobId) as any).n,1);assert.equal(answerCount(f),1);
});
test('concurrent conflicting HTTP answers preserve the first admitted answer and reject the other',async()=>{
 const f=await waitingQuestion('answer-conflict-race');model=()=>[message('Internal answer processed.')];const responses=await Promise.all([postAnswer(f,f.question.seq,'Approved source'),postAnswer(f,f.question.seq,'Alternative')]);await settleAgentJobs();assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(answerCount(f),1);assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=?").get(f.worker.id,f.question.body.jobId) as any).n,1);
});
test('HTTP answer admission rolls back job, card and human row when durable card linkage fails',async()=>{
 const f=await waitingQuestion('answer-link-rollback'),before=jobCount(f),questionBefore=card(f,'question').body;model=()=>[message('Accepted after retry.')];
 db.exec(`CREATE TEMP TRIGGER reject_answer_link BEFORE UPDATE ON rows WHEN NEW.bot_id='${f.worker.id}' AND json_extract(NEW.body,'$.answerJobId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected_answer_link_failure'); END`);
 try{const response=await postAnswer(f,f.question.seq,'Approved source');assert.equal(response.status,409);await settleAgentJobs();assert.equal(jobCount(f),before);assert.deepEqual(card(f,'question').body,questionBefore);assert.equal(answerCount(f),0);}finally{db.exec('DROP TRIGGER reject_answer_link');}
 const retry=await postAnswer(f,f.question.seq,'Approved source');assert.equal(retry.status,200);await settleAgentJobs();assert.equal(answerCount(f),1);
});
test('HTTP outer admission rollback cannot leave a scheduled orphan or execute business work',async()=>{
 const f=await waitingQuestion('answer-presentation-rollback'),before=jobCount(f),callsBefore=modelCalls;model=()=>[message('Retry accepted.')];
 db.exec(`CREATE TEMP TRIGGER reject_answer_presentation BEFORE INSERT ON rows WHEN NEW.bot_id='${f.worker.id}' AND NEW.kind='message' AND json_extract(NEW.body,'$.role')='user' BEGIN SELECT RAISE(ABORT,'injected_answer_presentation_failure'); END`);
 try{const response=await postAnswer(f,f.question.seq,'Approved source');assert.equal(response.status,409);await settleAgentJobs();assert.equal(jobCount(f),before);assert.equal(modelCalls,callsBefore);assert.equal(card(f,'question').body.status,'pending');assert.equal(answerCount(f),0);}finally{db.exec('DROP TRIGGER reject_answer_presentation');}
 const retry=await postAnswer(f,f.question.seq,'Approved source');assert.equal(retry.status,200);await settleAgentJobs();assert.equal(answerCount(f),1);
});
test('approval admission rolls back policy and decision when the exact resume cannot be accepted',async()=>{
 const f=await waitingApproval('approval-rollback'),writesBefore=writes,jobsBefore=jobCount(f);model=()=>[message('Approved fixture write finished.')];
 db.exec(`CREATE TEMP TRIGGER reject_approval_resume BEFORE INSERT ON agent_jobs WHEN NEW.bot_id='${f.worker.id}' AND json_extract(NEW.trigger,'$.type')='resume' BEGIN SELECT RAISE(ABORT,'injected_resume_admission_failure'); END`);
 try{const response=await app.request('/api/approvals/'+f.approval.id,{method:'POST',headers:f.headers,body:JSON.stringify({decision:'always'})});assert.ok(response.status>=400);await settleAgentJobs();assert.equal(jobCount(f),jobsBefore);assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(f.approval.id) as any).status,'pending');assert.equal(card(f,'approval').body.status,'pending');assert.equal((db.prepare('SELECT COUNT(*) n FROM policies WHERE user_id=? AND tool=?').get(f.userId,f.approval.tool) as any).n,0);assert.equal(writes,writesBefore);}finally{db.exec('DROP TRIGGER reject_approval_resume');}
 const retry=await app.request('/api/approvals/'+f.approval.id,{method:'POST',headers:f.headers,body:JSON.stringify({decision:'allow'})});assert.equal(retry.status,200);await settleAgentJobs();assert.equal(writes,writesBefore+1);const duplicate=await app.request('/api/approvals/'+f.approval.id,{method:'POST',headers:f.headers,body:JSON.stringify({decision:'allow'})});assert.equal(duplicate.status,200);await settleAgentJobs();assert.equal(writes,writesBefore+1);
});
test('stopping a pending request checkpoints cancellation and returns one failure without executing its write',async()=>{
 const f=await waitingApproval('stop-pending'),writesBefore=writes;model=()=>[message('Cancellation received.')];interrupt(f.worker.id,f.pending.jobId);await new Promise(resolve=>setImmediate(resolve));await settleAgentJobs();assert.equal(writes,writesBefore);assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(f.worker.id),undefined);assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(f.approval.id) as any).status,'expired');assert.equal((db.prepare('SELECT status FROM coordination_job_outcomes WHERE job_id=?').get(f.pending.jobId) as any).status,'interrupted');assert.equal(getInternalRequest(f.userId,f.requestId).status,'failed');const returned=listInternalRequests(f.userId).requests.filter(r=>r.kind==='result');assert.equal(returned.length,1);assert.equal(returned[0].correlationId,f.requestId);
});
test('a stale exact-job cancellation cannot abort a newer live turn',async()=>{
 const f=await waitingApproval('stale-stop'),writesBefore=writes;let release!:()=>void,entered!:()=>void,blocked=false;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});model=async()=>{if(!blocked){blocked=true;entered();await gate;}return[message('New human work completed.')];};
 const newer=enqueue(f.worker.id,{type:'user',text:'New independent human assignment.'});let timeout:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([started,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('New turn did not start')),3000);})]);interrupt(f.worker.id,f.pending.jobId);assert.equal(turnSignal(f.worker.id)?.aborted,false);}finally{if(timeout)clearTimeout(timeout);release();}
 await settleAgentJobs();assert.equal(writes,writesBefore);assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(newer) as any).state,'completed');assert.equal((db.prepare('SELECT status FROM coordination_job_outcomes WHERE job_id=?').get(f.pending.jobId) as any).status,'interrupted');
});
test('computer-change resume cancels exactly the old pending batch and reports interrupted',async()=>{
 const f=await waitingApproval('computer-change'),writesBefore=writes;db.prepare('UPDATE pending_turns SET state=? WHERE bot_id=?').run(JSON.stringify({...f.pending,computerRevision:999999}),f.worker.id);model=()=>[message('Computer-change cancellation received.')];const response=await app.request('/api/approvals/'+f.approval.id,{method:'POST',headers:f.headers,body:JSON.stringify({decision:'allow'})});assert.equal(response.status,200);await settleAgentJobs();assert.equal(writes,writesBefore);assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(f.worker.id),undefined);const resumed=db.prepare("SELECT id FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=? ORDER BY created_at DESC LIMIT 1").get(f.worker.id,f.pending.jobId) as any;assert.ok(resumed);assert.equal((db.prepare('SELECT status FROM coordination_job_outcomes WHERE job_id=?').get(resumed.id) as any).status,'interrupted');assert.equal(getInternalRequest(f.userId,f.requestId).status,'failed');
});
