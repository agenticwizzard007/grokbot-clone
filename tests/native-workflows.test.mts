import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-native-workflows-'));
Object.assign(process.env,{DB_PATH:path.join(root,'test.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'workflow-test-secret',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
const {db}=await import('../server/src/db.js');
const goals=await import('../server/src/agent/goals.js');
const workflows=await import('../server/src/agent/workflows.js');
const {acceptJob,beginJob,finishJob}=await import('../server/src/agent/jobs.js');
const {initSubagents}=await import('../server/src/agent/subagents.js');
const {appendRow}=await import('../server/src/store.js');
initSubagents();
db.exec(`CREATE TABLE IF NOT EXISTS usage_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,bot_id TEXT,kind TEXT,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,token_fields TEXT,usage_status TEXT DEFAULT 'complete',cost_usd REAL,cost_source TEXT)`);
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
let sequence=0;
const queued:{botId:string;jobId:string;trigger:any}[]=[],interrupted:string[]=[],interruptionCalls:{botId:string;expectedJobId?:string}[]=[];
beforeEach(()=>{
  queued.length=0;interrupted.length=0;interruptionCalls.length=0;
  workflows.configureWorkflowRuntime({enqueue:(botId,trigger)=>{const job=acceptJob(botId,trigger);queued.push({botId,jobId:job.id,trigger});return job.id;},interrupt:(botId,expectedJobId)=>{interrupted.push(botId);interruptionCalls.push({botId,expectedJobId});}});
});
function fixture(ownerId?:string) {
  const n=++sequence,userId=ownerId??`wf-user-${n}`,botId=`wf-bot-${n}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.com`,userId,Date.now());
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId,userId,botId,Date.now(),Date.now());
  return {userId,botId};
}
const criterion={id:'proof',description:'Verified summary',kind:'result' as const,contains:'verified'};
const outputSchema={type:'object',properties:{summary:{type:'string',minLength:1}},required:['summary'],additionalProperties:false};
function task(key:string,dependsOn:string[]=[],delegate=false) {return {key,title:key,instructions:`Produce verified ${key}.`,dependsOn,delegate,criteria:[criterion],outputSchema};}
function create(f:ReturnType<typeof fixture>,tasks=[task('a')],goalId?:string) {return workflows.createWorkflow(f.userId,f.botId,{title:'Native workflow',tasks,goalId});}
function admit(f:ReturnType<typeof fixture>,job=queued.at(-1)!) {
  assert.ok(beginJob(job.jobId));const ctx={userId:f.userId,botId:job.botId,jobId:job.jobId};assert.equal(workflows.workflowPreTurn(ctx).allowed,true);return ctx;
}
async function finish(ctx:ReturnType<typeof admit>,finalText='{"summary":"verified output"}',status:'completed'|'waiting'|'interrupted'|'failed'='completed') {
  await workflows.workflowAfterTurn({...ctx,status,finalText,usage:{tokens:5,costUsd:0.01}});finishJob(ctx.jobId,status!=='failed'&&status!=='interrupted');
}
function usage(f:ReturnType<typeof fixture>,botId:string,extra:{tokens?:number;cost?:number|null;source?:string;unavailable?:boolean}={}) {
  db.prepare(`INSERT INTO usage_events(user_id,bot_id,kind,input_tokens,output_tokens,token_fields,usage_status,cost_usd,cost_source) VALUES(?,?,'chat',?,?,?, ?,?,?)`)
    .run(f.userId,botId,extra.tokens??3,0,extra.unavailable?'[]':null,extra.unavailable?'unavailable':'complete',extra.cost===undefined?0.01:extra.cost,extra.source??'provider');
}

test('graph port rejects dependency/hierarchy cycles and malformed graphs atomically',()=>{
  const f=fixture();
  assert.throws(()=>create(f,[task('a',['b']),task('b',['a'])]),/Cyclic/);
  assert.throws(()=>create(f,[task('a',['missing'])]),/Unknown/);
  assert.throws(()=>create(f,[task('a'),task('a')]),/unique/);
  assert.throws(()=>workflows.createWorkflow(f.userId,f.botId,{title:'cycle',tasks:[{...task('a'),parentKey:'b'},{...task('b'),parentKey:'a'}]}),/Cyclic parent/);
  assert.equal(workflows.listWorkflows(f.userId).length,0);
  assert.equal((db.prepare('SELECT count(*) n FROM tasks WHERE bot_id=?').get(f.botId) as any).n,0);
});
test('owner checks protect goals, workflows, dependency links and job hooks',()=>{
  const f=fixture(),other=fixture(),w=create(f),g=goals.createGoal(f.userId,f.botId,{title:'Scoped',criteria:[{description:'Evidence',kind:'row'}]});
  for(const fn of [()=>goals.getGoal(other.userId,g.id),()=>goals.controlGoal(other.userId,g.id,'stop'),()=>workflows.getWorkflow(other.userId,w.id),()=>workflows.startWorkflow(other.userId,w.id),()=>workflows.addWorkflowDependency(other.userId,w.id,w.tasks[0].id,w.tasks[0].id)])assert.throws(fn,/not found/i);
  assert.throws(()=>goals.createGoal(other.userId,f.botId,{title:'foreign',criteria:[{description:'x',kind:'row'}]}),/not found/);
  workflows.startWorkflow(f.userId,w.id);const q=queued[0];assert.throws(()=>workflows.workflowPreTurn({userId:other.userId,botId:other.botId,jobId:q.jobId}),/not found/);
});
test('goal acceptance inspects actual assistant evidence and preserves a digest',()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Proof',criteria:[{id:'proof',description:'Verified output',kind:'row',contains:'verified'}]});
  assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:999}]),/does not exist/);
  const user=appendRow(f.botId,'message',{type:'message',role:'user',text:'verified'});
  assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:user.seq}]),/assistant/);
  const assistant=appendRow(f.botId,'message',{type:'message',role:'assistant',text:'Actual verified output.'});
  const completed=goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:assistant.seq}]);
  assert.equal(completed.status,'completed');assert.match((completed.evidence[0] as any).sha256,/^[a-f0-9]{64}$/);
});
test('file evidence is owner-contained and refuses symlinks/traversal',()=>{
  const f=fixture(),dir=path.join(root,'files',f.botId,'Deliverables','report');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'report.txt'),'verified report');
  const g=goals.createGoal(f.userId,f.botId,{title:'File',criteria:[{id:'proof',description:'Report exists',kind:'file',contains:'verified'}]});
  fs.writeFileSync(path.join(root,'outside.txt'),'verified');fs.symlinkSync(path.join(root,'outside.txt'),path.join(dir,'escape.txt'));
  for(const file of ['../outside.txt','Deliverables/report/escape.txt'])assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'file',path:file}]),/outside your storage/);
  const other=fixture();assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'file',botId:other.botId,path:'Deliverables/report/report.txt'}]),/not found/);
  assert.equal(goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'file',path:'Deliverables/report/report.txt'}]).status,'completed');
});
test('row evidence selects explicit/current generation and rejects streaming or unsuccessful tools',()=>{
  const f=fixture(),generation=(db.prepare('SELECT generation FROM bots WHERE id=?').get(f.botId) as any).generation;
  const old=appendRow(f.botId,'message',{type:'message',role:'assistant',text:'verified historical result'});
  db.prepare('UPDATE bots SET generation=generation+1 WHERE id=?').run(f.botId);
  db.prepare(`INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)`).run(f.botId,generation+1,old.seq,old.seq,'message',JSON.stringify({type:'message',role:'assistant',text:'current incomplete',streaming:true}),Date.now());
  const g=goals.createGoal(f.userId,f.botId,{title:'Generation',criteria:[{id:'proof',description:'verified',kind:'row',contains:'verified'}]});
  assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:old.seq}]),/finished/);
  assert.equal(goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:old.seq,generation}]).status,'completed');
  for(const status of ['error','denied','queued','running','awaiting-approval','done'] as const) {
    const t=appendRow(f.botId,'tool-call',{type:'tool-call',callId:`call-${status}`,name:'example',label:'Read',status,summary:'verified summary'});
    const check=goals.createGoal(f.userId,f.botId,{title:'Tool receipt',criteria:[{id:'proof',description:'Tool result',kind:'row',contains:'actual verified output'}]});
    assert.throws(()=>goals.verifyGoal(f.userId,check.id,[{criterionId:'proof',kind:'row',rowSeq:t.seq}]),/finished|persisted output/);
    if(status==='done') {
      db.prepare("INSERT INTO tool_dispatches(bot_id,call_id,tool,arguments_hash,state,created_at) VALUES(?,?,?,'hash','completed',?)").run(f.botId,'call-done','example',Date.now());
      db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES(?,?,?,?)').run(f.botId,generation+1,0,JSON.stringify({type:'function_call_output',call_id:'call-done',output:'actual verified output'}));
      assert.equal(goals.verifyGoal(f.userId,check.id,[{criterionId:'proof',kind:'row',rowSeq:t.seq}]).status,'completed');
    }
  }
});
test('readiness admits prerequisites first, validates results and gives followers persisted evidence',async()=>{
  const f=fixture(),w=create(f,[task('a'),task('b',['a'])]);workflows.startWorkflow(f.userId,w.id);
  assert.equal(queued.length,1);assert.equal(workflows.getWorkflow(f.userId,w.id).tasks[1].status,'waiting');
  assert.throws(()=>workflows.completeWorkflowTask(f.userId,w.id,w.tasks[1].id,[{criterionId:'proof',kind:'result',taskId:w.tasks[0].id}]),/dependencies/);
  const first=admit(f,queued[0]);await finish(first);assert.equal(queued.length,2);
  assert.match(queued[1].trigger.text,/verified output/);assert.match(queued[1].trigger.text,/sha256/);
  const second=admit(f,queued[1]);await finish(second);
  const final=workflows.getWorkflow(f.userId,w.id);assert.equal(final.status,'completed');assert.ok(final.tasks.every(t=>t.status==='completed'&&t.resultValidated));
  assert.equal((db.prepare("SELECT count(*) n FROM tasks WHERE bot_id=? AND state='done'").get(f.botId) as any).n,2);
});
test('adding a dependency re-gates readiness and rejects cross-workflow or cyclic links',()=>{
  const f=fixture(),w=create(f,[task('a'),task('b')]),other=create(f);
  workflows.addWorkflowDependency(f.userId,w.id,w.tasks[0].id,w.tasks[1].id);
  assert.equal(workflows.getWorkflow(f.userId,w.id).tasks[0].status,'waiting');
  assert.throws(()=>workflows.addWorkflowDependency(f.userId,w.id,w.tasks[1].id,w.tasks[0].id),/Cyclic/);
  assert.throws(()=>workflows.addWorkflowDependency(f.userId,w.id,w.tasks[0].id,other.tasks[0].id),/not found/);
});
test('delegated child uses native bot/job lineage, one correction and validated fan-in',async()=>{
  const f=fixture(),w=create(f,[task('a',[],true)]);workflows.startWorkflow(f.userId,w.id);
  const child=queued[0];assert.notEqual(child.botId,f.botId);assert.equal((db.prepare('SELECT parent_bot_id FROM bots WHERE id=?').get(child.botId) as any).parent_bot_id,f.botId);
  const one=admit(f,child);await finish(one,'{"summary":false}');
  assert.equal(queued.length,2);assert.equal(workflows.getWorkflow(f.userId,w.id).tasks[0].correctionCount,1);
  assert.equal(queued[1].botId,child.botId);assert.equal(queued[1].trigger.parentJobId,one.jobId);assert.match(queued[1].trigger.text,/single correction/);
  await finish(admit(f,queued[1]));assert.equal(workflows.getWorkflow(f.userId,w.id).status,'completed');
  const result=db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC LIMIT 1").get(f.botId) as any;assert.match(result.body,/Delegated task verified/);
});
test('invalid correction blocks and never schedules an unbounded third attempt',async()=>{
  const f=fixture(),w=create(f);workflows.startWorkflow(f.userId,w.id);
  await finish(admit(f,queued[0]),'not json');await finish(admit(f,queued[1]),'still not json');
  const t=workflows.getWorkflow(f.userId,w.id).tasks[0];assert.equal(t.status,'blocked');assert.equal(t.resultValidated,false);assert.equal(t.correctionCount,1);assert.equal(queued.length,2);
});
test('schema extraction port keeps arrays and validation fails closed on unsupported constraints',()=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}};
  const result=workflows.validateChildResult('```json\n[{"value":1},{"value":2}]\n```',schema);assert.equal(result.valid,true);assert.deepEqual(result.value,[{value:1},{value:2}]);
  assert.equal(workflows.validateChildResult('{"summary":"ok","extra":true}',outputSchema).valid,false);
  assert.throws(()=>workflows.compileOutputSchema({type:'string',pattern:'x+'}),/Unsupported/);
  assert.throws(()=>workflows.compileOutputSchema({$ref:'https://example.com/schema'}),/references are not supported/);
});
test('recursive schema references and deep/wide child results are rejected before recursive validation',()=>{
  assert.throws(()=>workflows.compileOutputSchema({$defs:{node:{type:'object',properties:{next:{$ref:'#/$defs/node'}}}},$ref:'#/$defs/node'}),/references are not supported/);
  assert.throws(()=>workflows.compileOutputSchema({$defs:{a:{$ref:'#/$defs/b'},b:{$ref:'#/$defs/a'}},$ref:'#/$defs/a'}),/references are not supported/);
  const deep='['.repeat(1000)+'0'+']'.repeat(1000);
  assert.match(workflows.validateChildResult(deep,{}).errors[0],/maximum depth/);
  assert.match(workflows.validateChildResult(JSON.stringify(Array(10_001).fill(0)),{}).errors[0],/node count/);
  assert.equal(workflows.validateChildResult(JSON.stringify({a:[1,2,3]}),{}).valid,true);
  const cyclic:any={type:'object'};cyclic.const=cyclic;
  assert.throws(()=>workflows.compileOutputSchema(cyclic),/JSON is too complex/);
});
test('native tool gate blocks untracked delegation but preserves ordinary chats and inherited workflow budgets',async()=>{
  const f=fixture(),ordinary=acceptJob(f.botId,{type:'user',text:'Ordinary work'}).id;
  for(const name of ['spawn_subagent','message_subagent','send_to_bot','post_to_group'])assert.equal(workflows.workflowToolGate({...f,jobId:ordinary},name).allowed,true);
  const g=goals.createGoal(f.userId,f.botId,{title:'Shared budget',criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);
  for(const name of ['spawn_subagent','message_subagent','send_to_bot','post_to_group','create_goal'])assert.equal(workflows.workflowToolGate(ctx,name).allowed,false);
  assert.equal(workflows.workflowToolGate(ctx,'delegate_workflow_task').allowed,true);
  const {WORKFLOW_TOOLS}=await import('../server/src/agent/workflow-tools.js'),createTool=WORKFLOW_TOOLS.find(t=>t.name==='create_workflow')!;
  const toolCtx={...ctx,depth:0,enqueueBotMessage:()=>{}};
  const inherited=await createTool.impl({title:'Inherited',tasks:[task('a')]},toolCtx);
  assert.equal(inherited.isError,undefined);assert.equal(JSON.parse(inherited.output as string).goalId,g.id);
  const other=goals.createGoal(f.userId,f.botId,{title:'Other goal',criteria:[{description:'Proof',kind:'row'}]});
  const mismatch=await createTool.impl({title:'Escape',goalId:other.id,tasks:[task('a')]},toolCtx);assert.equal(mismatch.isError,true);assert.match(mismatch.output as string,/must match/);
  const unrelated=create(f),startTool=WORKFLOW_TOOLS.find(t=>t.name==='start_workflow')!;
  const escaped=await startTool.impl({workflow_id:unrelated.id},toolCtx);assert.equal(escaped.isError,true);assert.match(escaped.output as string,/existing goal\/workflow scope/);
  const foreign=fixture();assert.equal(workflows.workflowToolGate({...foreign,jobId:ctx.jobId},'save_file').allowed,false);
});
test('structured children cannot create independent goal/workflow scopes even in ordinary child chats',async()=>{
  const f=fixture(),w=create(f,[task('a',[],true)]);workflows.startWorkflow(f.userId,w.id);const child=queued[0];
  const {WORKFLOW_TOOLS}=await import('../server/src/agent/workflow-tools.js');
  const childJob=acceptJob(child.botId,{type:'user',text:'Do more'}).id,ctx={userId:f.userId,botId:child.botId,jobId:childJob,depth:0,enqueueBotMessage:()=>{}};
  const goal=await WORKFLOW_TOOLS.find(t=>t.name==='create_goal')!.impl({title:'Escape goal',criteria:[{kind:'row',description:'Proof'}]},ctx);
  const graph=await WORKFLOW_TOOLS.find(t=>t.name==='create_workflow')!.impl({title:'Escape graph',tasks:[task('a')]},ctx);
  assert.equal(goal.isError,true);assert.equal(graph.isError,true);assert.equal(goals.listGoals(f.userId,child.botId).length,0);assert.equal(workflows.listWorkflows(f.userId,child.botId).length,0);
});
test('finite turns reserve idempotently, include real user turns, and pause without replay',async()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Bounded',maxTurns:1,criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);
  assert.equal(workflows.workflowPreTurn(ctx).allowed,true);assert.equal(goals.getGoal(f.userId,g.id).turnsUsed,1);
  await finish(ctx);assert.equal(goals.getGoal(f.userId,g.id).status,'paused');assert.equal(queued.length,1);
  await workflows.workflowAfterTurn({...ctx,status:'completed',usage:{tokens:999,costUsd:999}});assert.equal(goals.getGoal(f.userId,g.id).tokensUsed,5);
  assert.throws(()=>goals.controlGoal(f.userId,g.id,'resume'),/budget exhausted/);
});
test('step budget sees awaited measured usage, permits zero before calls and pauses on unknown tokens',()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Token cap',maxTokens:10,criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);
  assert.deepEqual(workflows.checkWorkflowBudget(ctx),{allowed:true,remainingTokens:10});usage(f,f.botId,{tokens:3});assert.equal(workflows.checkWorkflowBudget(ctx).remainingTokens,7);
  usage(f,f.botId,{unavailable:true});assert.equal(workflows.checkWorkflowBudget(ctx).allowed,false);assert.match(goals.getGoal(f.userId,g.id).reason,/accounting unavailable/);
});
test('spend cap fails closed for estimated/missing prices and enforces actual spend',()=>{
  for(const value of [{cost:0.01,source:'estimate'},{cost:null},{cost:0.6}]) {
    const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Spend',maxSpendUsd:0.5,criteria:[{description:'Proof',kind:'row'}]});
    workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);assert.equal(workflows.checkWorkflowBudget(ctx).allowed,true);
    usage(f,f.botId,value);assert.equal(workflows.checkWorkflowBudget(ctx).allowed,false);assert.equal(goals.getGoal(f.userId,g.id).status,'paused');
  }
});
test('approval waits do not validate results; resumed descendants release the prior waiting receipt',async()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Waiting',maxTurns:4,criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const first=admit(f);await finish(first,'','waiting');assert.equal(queued.length,1);
  const resumeId=acceptJob(f.botId,{type:'resume',parentJobId:first.jobId}).id;
  const next=admit(f,{botId:f.botId,jobId:resumeId,trigger:{}});
  assert.equal((db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=?').get(first.jobId) as any).status,'continued');
  await finish(next,'done','interrupted');assert.equal(goals.getGoal(f.userId,g.id).status,'blocked');
  goals.controlGoal(f.userId,g.id,'resume');assert.equal(queued.length,2,'a stale wait must not prevent an explicit new execution');
});
test('finishPending can interrupt waiting runs without charging their usage twice',async()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Wait then stop',criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);await finish(ctx,'','waiting');
  await workflows.workflowAfterTurn({...ctx,status:'interrupted',usage:{tokens:100,costUsd:100}});
  const final=goals.getGoal(f.userId,g.id);assert.equal(final.status,'blocked');assert.equal(final.tokensUsed,5);assert.equal(final.spendUsd,0.01);
  assert.equal((db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=?').get(ctx.jobId) as any).status,'interrupted');
});
test('queue-capacity failure blocks continuation without throwing from the terminal hook',async()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Queue pressure',criteria:[{description:'Proof',kind:'row'}]});
  workflows.startGoalExecution(f.userId,g.id);const ctx=admit(f);
  workflows.configureWorkflowRuntime({enqueue:()=>{throw new Error('Your task queue is full.');},interrupt:botId=>{interrupted.push(botId);}});
  await assert.doesNotReject(()=>workflows.workflowAfterTurn({...ctx,status:'completed',usage:{tokens:1,costUsd:0}}));
  const blocked=goals.getGoal(f.userId,g.id);assert.equal(blocked.status,'blocked');assert.match(blocked.reason,/Could not queue goal continuation.*queue is full/);
});
test('verified goal completion cancels queued continuation receipts before they can execute',()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Already delivered',criteria:[{id:'proof',description:'Delivered',kind:'row'}]});
  const queuedId=workflows.startGoalExecution(f.userId,g.id),row=appendRow(f.botId,'message',{type:'message',role:'assistant',text:'Actual delivered result'});
  goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:row.seq}]);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(queuedId) as any).state,'cancelled');
  assert.equal((db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=?').get(queuedId) as any).status,'cancelled');
  assert.equal(workflows.workflowPreTurn({userId:f.userId,botId:f.botId,jobId:queuedId}).allowed,false);
});
test('goal completion cannot bypass unfinished dependent work or accept an arbitrary boolean',()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Must wait',criteria:[{id:'proof',description:'Proof',kind:'row'}]});create(f,[task('a')],g.id);
  const row=appendRow(f.botId,'message',{type:'message',role:'assistant',text:'Actual output'});
  assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',rowSeq:row.seq}]),/not all verified/);
  assert.throws(()=>goals.verifyGoal(f.userId,g.id,[{criterionId:'proof',kind:'row',complete:true} as any]));
});
test('stop cancels bound child jobs and task projections while preserving unrelated child work',()=>{
  const f=fixture(),w=create(f,[task('a',[],true),task('b',['a'])]);workflows.startWorkflow(f.userId,w.id);const child=queued[0];
  const stray=acceptJob(child.botId,{type:'system',text:'child follow-up'}).id;
  workflows.controlWorkflow(f.userId,w.id,'stop');
  assert.ok(workflows.getWorkflow(f.userId,w.id).tasks.every(t=>t.status==='cancelled'));
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(stray) as any).state,'queued');assert.equal(interruptionCalls.length,0,'cancelling never-started jobs must not interrupt the bot');
  assert.equal(workflows.workflowPreTurn({userId:f.userId,botId:child.botId,jobId:child.jobId}).allowed,false);
});
test('pausing/stopping queued workflows never interrupts an unrelated running chat on the same bot',()=>{
  for(const action of ['pause','stop'] as const) {
    const f=fixture(),chat=acceptJob(f.botId,{type:'user',text:'Unrelated chat'}).id;beginJob(chat);
    const w=create(f);workflows.startWorkflow(f.userId,w.id);const taskJob=queued.at(-1)!.jobId;
    workflows.controlWorkflow(f.userId,w.id,action);
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(taskJob) as any).state,'cancelled');
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(chat) as any).state,'running');
  }
  assert.equal(interruptionCalls.length,0);
});
test('goal interruption is job-fenced and queued goal work cannot abort a different running chat',async()=>{
  const f=fixture(),g=goals.createGoal(f.userId,f.botId,{title:'Goal stop scope',criteria:[{description:'Proof',kind:'row'}]});
  const goalJob=workflows.startGoalExecution(f.userId,g.id),chat=acceptJob(f.botId,{type:'user',text:'Other chat'}).id;beginJob(chat);
  goals.controlGoal(f.userId,g.id,'pause');assert.equal(interruptionCalls.length,0);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(goalJob) as any).state,'cancelled');
  goals.controlGoal(f.userId,g.id,'resume');const ctx=admit(f);await finish(ctx,'','waiting');
  goals.controlGoal(f.userId,g.id,'stop');
  assert.deepEqual(interruptionCalls,[{botId:f.botId,expectedJobId:ctx.jobId}]);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(chat) as any).state,'running');
});
test('workflow waiting approval cleanup names its old job, never a newer same-bot chat',async()=>{
  const f=fixture(),w=create(f);workflows.startWorkflow(f.userId,w.id);const ctx=admit(f);await finish(ctx,'','waiting');
  const chat=acceptJob(f.botId,{type:'user',text:'New unrelated work'}).id;beginJob(chat);
  workflows.controlWorkflow(f.userId,w.id,'pause');
  assert.deepEqual(interruptionCalls,[{botId:f.botId,expectedJobId:ctx.jobId}]);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(chat) as any).state,'running');
});
test('nested cancellation follows bound job ancestry and fences every running interruption',async()=>{
  const f=fixture(),w=create(f,[task('a',[],true)]);workflows.startWorkflow(f.userId,w.id);const parent=admit(f);
  const {createSubagent}=await import('../server/src/agent/subagents.js');const nested=createSubagent(parent.botId,'Nested task','Nested',{structured:true});
  const nestedJob=acceptJob(nested.id,{type:'system',text:'Bound nested continuation',parentJobId:parent.jobId}).id;beginJob(nestedJob);
  db.prepare("INSERT INTO native_workflow_runs(job_id,bot_id,parent_job_id,status,created_at) VALUES(?,?,?,'running',?)").run(nestedJob,nested.id,parent.jobId,Date.now());
  const unrelated=acceptJob(nested.id,{type:'user',text:'Unrelated descendant chat'}).id;
  workflows.controlWorkflow(f.userId,w.id,'stop');
  assert.ok(interruptionCalls.some(c=>c.botId===parent.botId&&c.expectedJobId===parent.jobId));
  assert.ok(interruptionCalls.some(c=>c.botId===nested.id&&c.expectedJobId===nestedJob));
  assert.ok(interruptionCalls.every(c=>!!c.expectedJobId));
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(unrelated) as any).state,'queued');
});
test('recovery blocks lost running work, preserves never-started jobs, and persists across a fresh process',async()=>{
  const f=fixture(),w=create(f,[task('a'),task('b',['a'])]);workflows.startWorkflow(f.userId,w.id);const ctx=admit(f);
  const idle=fixture(),pending=create(idle);workflows.startWorkflow(idle.userId,pending.id);const idleJob=queued.at(-1)!;
  const recovered=workflows.recoverWorkflows();assert.ok(recovered.interruptedRuns>=1);
  assert.equal(workflows.getWorkflow(f.userId,w.id).tasks[0].status,'blocked');assert.equal(workflows.getWorkflow(f.userId,w.id).tasks[1].status,'waiting');
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(idleJob.jobId) as any).state,'queued');
  const fresh=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`const {getWorkflow}=await import('./server/src/agent/workflows.ts');const w=getWorkflow(${JSON.stringify(f.userId)},${JSON.stringify(w.id)});process.stdout.write(JSON.stringify({status:w.status,task:w.tasks[0].status}));`],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,encoding:'utf8'});
  assert.equal(fresh.status,0,fresh.stderr);assert.deepEqual(JSON.parse(fresh.stdout),{status:'blocked',task:'blocked'});
  assert.equal(workflows.workflowPreTurn(ctx).allowed,false);
});
test('HTTP routes require auth, enforce owner scope and reject invalid completion bodies',async()=>{
  const {Hono}=await import('hono'),{workflowApi}=await import('../server/src/routes-workflows.js');
  const app=new Hono();app.route('/api/workflows',workflowApi);const f=fixture(),other=fixture(),w=create(f);
  const token='workflow-session';db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,other.userId,Date.now(),Date.now()+60_000);
  assert.equal((await app.request('/api/workflows')).status,401);
  const headers={cookie:`swarm_session=${token}`,'content-type':'application/json',origin:'http://localhost:1'};
  assert.equal((await app.request(`/api/workflows/${w.id}`,{headers})).status,404);
  assert.equal((await app.request('/api/workflows',{headers})).status,200);
  assert.equal((await app.request('/api/workflows/goals',{method:'POST',headers,body:JSON.stringify({botId:other.botId,title:'Bad',criteria:[],complete:true})})).status,400);
});
test('recovery skips held owner/FK scopes without weakening fences and recovers the other owner',async()=>{
  const {holdLegacyDatabase,assertLegacyDatabaseFences}=await import('../server/src/platform/legacy-database-fence.js');
  workflows.recoverWorkflows(); // Settle earlier fixtures before this two-owner boundary.
  function seed(owner:string) {
    const f=fixture(owner),g=goals.createGoal(f.userId,f.botId,{title:'Restarted goal',criteria:[{description:'Proof',kind:'row'}]});
    const w=create(f,[task('a',[],true),task('b',['a'])],g.id);workflows.startWorkflow(f.userId,w.id);
    const running=admit(f);usage(f,running.botId,{tokens:7,cost:0.02});
    const standalone=goals.createGoal(f.userId,f.botId,{title:'Standalone restart',criteria:[{description:'Proof',kind:'row'}]});
    workflows.startGoalExecution(f.userId,standalone.id);const goalRun=admit(f);
    const uncertain=create(f);workflows.startWorkflow(f.userId,uncertain.id);const uncertainJob=queued.at(-1)!.jobId;
    db.prepare("UPDATE agent_jobs SET state='uncertain' WHERE id=?").run(uncertainJob);
    const idle=create(f);workflows.startWorkflow(f.userId,idle.id);const idleJob=queued.at(-1)!.jobId;
    return {...f,g,w,running,standalone,goalRun,uncertain,uncertainJob,idle,idleJob};
  }
  const held=seed('usr_workflows_held_0001'),free=seed('usr_workflows_free_0001');
  const ownBots='SELECT id FROM bots WHERE user_id=?',ownWorkflows='SELECT id FROM native_workflows WHERE user_id=?';
  function snapshot(userId:string) {
    const where={users:'id=?',bots:'user_id=?',native_goals:'user_id=?',native_workflows:'user_id=?',agent_jobs:'user_id=?',
      native_goal_turns:'goal_id IN (SELECT id FROM native_goals WHERE user_id=?)',
      native_workflow_tasks:`workflow_id IN (${ownWorkflows})`,
      native_workflow_edges:`task_id IN (SELECT task_id FROM native_workflow_tasks WHERE workflow_id IN (${ownWorkflows}))`,
      native_workflow_delegations:`task_id IN (SELECT task_id FROM native_workflow_tasks WHERE workflow_id IN (${ownWorkflows}))`,
      native_workflow_runs:`bot_id IN (${ownBots})`,tasks:`bot_id IN (${ownBots})`,rows:`bot_id IN (${ownBots})`,usage_events:'user_id=?'};
    return Object.fromEntries(Object.entries(where).map(([table,condition])=>[table,db.prepare(`SELECT * FROM ${table} WHERE ${condition} ORDER BY rowid`).all(userId)]));
  }
  holdLegacyDatabase(db,held.userId,'workflow-recovery-hold-0001','1');
  const before=snapshot(held.userId);
  assert.deepEqual(workflows.recoverWorkflows(),{interruptedRuns:3,blockedGoals:2});
  assert.deepEqual(snapshot(held.userId),before,'held goals, usage receipts, child runs, jobs and projections must be unchanged');
  assert.equal(goals.getGoal(free.userId,free.g.id).status,'blocked');
  assert.equal(goals.getGoal(free.userId,free.standalone.id).status,'blocked');
  assert.equal(goals.getGoal(free.userId,free.g.id).tokensUsed,7);
  assert.equal((db.prepare('SELECT status FROM native_goal_turns WHERE job_id=?').get(free.running.jobId) as any).status,'settled');
  assert.equal(workflows.getWorkflow(free.userId,free.w.id).status,'blocked');
  assert.equal(workflows.getWorkflow(free.userId,free.w.id).tasks[0].status,'blocked','goal blocking must not reset a recovered task to ready');
  assert.equal(workflows.getWorkflow(free.userId,free.uncertain.id).tasks[0].status,'blocked');
  for(const id of [free.running.jobId,free.goalRun.jobId,free.uncertainJob])assert.equal((db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=?').get(id) as any).status,'interrupted');
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(free.idleJob) as any).state,'queued');
  assert.equal((db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=?').get(free.idleJob) as any).status,'queued');
  assert.throws(()=>db.prepare("UPDATE native_workflow_runs SET status='interrupted' WHERE job_id=?").run(held.running.jobId),/legacy_account_migration_hold/);
  assertLegacyDatabaseFences(db);
  const fresh=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`const {recoverWorkflows}=await import('./server/src/agent/workflows.ts');process.stdout.write(JSON.stringify(recoverWorkflows()));`],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,encoding:'utf8'});
  assert.equal(fresh.status,0,fresh.stderr);assert.deepEqual(JSON.parse(fresh.stdout),{interruptedRuns:0,blockedGoals:0});
  assert.deepEqual(snapshot(held.userId),before,'fresh-process recovery must also preserve the held owner');
});
