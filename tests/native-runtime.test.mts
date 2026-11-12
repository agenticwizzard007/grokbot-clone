import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-runtime-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'runtime-test', COMPUTER_PROVIDER: 'local', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'http://127.0.0.1:9/v1', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '' });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { initSubagents } = await import('../server/src/agent/subagents.js'); initSubagents();
const { initRooms } = await import('../server/src/agent/rooms.js'); initRooms();
const { enqueue, settleAgentJobs, resolveApproval, interrupt, turnSignal } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { withUsage } = await import('../server/src/usage.js');
const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
const { testMcpServer, closeMcpSessions } = await import('../server/src/mcp/client.js');
const { listRows, loadHistory } = await import('../server/src/store.js');
const { listRoutineRuns, listArtifacts, readArtifact } = await import('../server/src/deliverables/index.js');
const { createWorkflow, startWorkflow, getWorkflow, controlWorkflow } = await import('../server/src/agent/workflows.js');
const { createGoal, getGoal } = await import('../server/src/agent/goals.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner', 'owner@example.test', 'Owner', Date.now());
let model: (body: any) => any[] | Promise<any[]> = () => [];
let modelUsage: any = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };
let seq = 0;
const message = (text: string) => ({ type: 'message', id: `msg_${++seq}`, role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (name: string, args: any) => ({ type: 'function_call', call_id: `call_${++seq}`, name, arguments: JSON.stringify(args) });
const client = withUsage({ userId: 'owner' }, () => llmClient(360_000));
mock.method(client.responses, 'create', async (body: any) => {
  const output = await model(body);
  return (async function* () {
    for (const item of output) {
      yield { type: 'response.output_item.added', item };
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content[0].text };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output, usage: modelUsage } };
  })();
});
mock.method(Client.prototype, 'connect', async () => {});
mock.method(Client.prototype, 'close', async () => {});
mock.method(Client.prototype, 'listTools', async () => ({ tools: ['read','write'].map(name => ({ name, inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } })) }));
const actions: any[] = [];
mock.method(Client.prototype, 'callTool', async (action: any) => { actions.push(action); return { content: [{ type: 'text', text: JSON.stringify({ value: action.arguments.value }) }] }; });
after(async () => { await settleAgentJobs(); await closeMcpSessions(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function programBot(name: string, withGoal = false) {
  const bot = createBot('owner', { name, isPrimary: true });
  const s = (await testMcpServer(saveMcpServer('owner', { name, transport: 'http', url: 'https://fixture.example/mcp', botIds: [bot.id] })))!;
  const read = mcpToolName(s, 'read'), write = mcpToolName(s, 'write');
  db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run('owner', `${read}:bot:${bot.id}`);
  const args = { tools: [read, write], code: `tools.call(${JSON.stringify(read)},{value:2}); return tools.call(${JSON.stringify(write)},{value:3});` };
  const goal = withGoal ? createGoal('owner', bot.id, { title: 'Tracked program', criteria: [{ kind: 'row', description: 'Verified output' }], maxTurns: 5 }) : undefined;
  model = body => body.input.some((i: any) => i.type === 'function_call_output') ? [message('Finished')] : [call('execute_code', args)];
  enqueue(bot.id, { type: 'user', text: 'Process data and save the result' });
  await settleAgentJobs();
  const approval = db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").get(bot.id) as any;
  assert.ok(approval, JSON.stringify(listRows(bot.id)));
  return { bot, approval, server: s, goal };
}

test('the real dispatcher resumes a program approval without repeating completed calls', async () => {
  actions.length = 0;
  const { bot, approval } = await programBot('Program');
  assert.deepEqual(actions.map(a => a.name), ['read']);
  resolveApproval('owner', approval.id, 'allow');
  await settleAgentJobs();
  assert.deepEqual(actions.map(a => a.name), ['read', 'write']);
  assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id), undefined);
  assert.equal((db.prepare('SELECT state FROM code_runs WHERE bot_id=?').get(bot.id) as any).state, 'completed');
  const outputs = loadHistory(bot.id).filter((i: any) => i.type === 'function_call_output');
  assert.equal(outputs.length, 1, 'nested data is retained in receipts, not inflated into model history');
  assert.match(outputs[0].output, /completed/);
});

test('revoking a paused program tool or stopping the Bot prevents its write', async () => {
  actions.length = 0;
  const revoked = await programBot('Revoked');
  saveMcpServer('owner', { enabled: false }, revoked.server);
  resolveApproval('owner', revoked.approval.id, 'allow');
  await settleAgentJobs();
  assert.deepEqual(actions.map(a => a.name), ['read']);
  const stopped = await programBot('Stopped');
  interrupt(stopped.bot.id);
  await settleAgentJobs();
  assert.equal((db.prepare('SELECT state FROM code_runs WHERE bot_id=?').get(stopped.bot.id) as any).state, 'cancelled');
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(stopped.approval.id) as any).status, 'expired');
  assert.ok(actions.every(a => a.name === 'read'));
});

test('routine question pauses preserve lineage and final files are real immutable downloads', async () => {
  const bot = createBot('owner', { name: 'Routine', isPrimary: true });
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES(?,?,?,?,?,?,?)').run('routine-test',bot.id,'Weekly report','Produce a report','0 8 * * 1',1,Date.now());
  model = () => [call('ask_user', { question: 'Which period?', options: ['This week'] })];
  enqueue(bot.id, { type: 'routine', routineId: 'routine-test', name: 'Weekly report', prompt: 'Produce a report' });
  await settleAgentJobs();
  assert.equal(listRoutineRuns('owner',bot.id)[0].status,'waiting');
  model = body => body.input.at(-1)?.type === 'function_call_output' ? [message('Saved the report')] : [call('save_file',{ filename:'report.md', content:'# Verified report\n42 items' })];
  enqueue(bot.id, {type:'user',text:'This week'});
  await settleAgentJobs();
  const run = listRoutineRuns('owner',bot.id)[0];
  assert.equal(run.status,'completed');
  const files = listArtifacts('owner',bot.id);
  assert.equal(files.length,1); assert.equal(files[0].runId,run.id);
  assert.equal(readArtifact('owner',files[0].id).content.toString(),'# Verified report\n42 items');
});

test('structured dependencies run through native jobs and receive verified predecessor results', async () => {
  const bot = createBot('owner', { name: 'Workflow', isPrimary: true });
  let turns = 0;
  model = body => { turns++; return [message(JSON.stringify({ result: turns }))]; };
  const schema = {type:'object',properties:{result:{type:'integer'}},required:['result'],additionalProperties:false};
  const workflow = createWorkflow('owner',bot.id,{ title:'Two steps',tasks:[
    {key:'first',title:'Research',instructions:'Return first result',criteria:[{kind:'result',description:'Structured research result'}],outputSchema:schema},
    {key:'second',title:'Report',instructions:'Use predecessor result',dependsOn:['first'],criteria:[{kind:'result',description:'Structured report'}],outputSchema:schema},
  ]});
  startWorkflow('owner',workflow.id);
  await settleAgentJobs();
  const completed = getWorkflow('owner',workflow.id);
  assert.equal(completed.status,'completed',JSON.stringify(completed));
  assert.equal(turns,2); assert.ok(completed.tasks.every(t => t.resultValidated));
});

test('tenant export preserves native state and rebuilds search without foreign FTS pages', async () => {
  const { exportTenantDatabase } = await import('../server/src/platform/migration.js');
  const { appendRow } = await import('../server/src/store.js');
  const { default: Database } = await import('better-sqlite3');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('foreign','foreign@example.test','Foreign',Date.now());
  const foreign = createBot('foreign',{name:'Foreign',isPrimary:true});
  appendRow(foreign.id,'message',{type:'message',role:'user',text:'Foreign private indexed content'});
  const snapshot=path.join(root,'snapshot.db'),destination=path.join(root,'tenant.db');
  await db.backup(snapshot);
  await exportTenantDatabase(snapshot,destination,'owner','volume-fixture');
  const target=new Database(destination);
  try {
    assert.equal(target.prepare('SELECT 1 FROM users WHERE id=?').get('foreign'),undefined);
    assert.equal(target.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_messages_fts'").get(),undefined);
    assert.equal(target.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_migrations'").get(),undefined);
    assert.equal((target.prepare('SELECT count(*) n FROM native_workflow_tasks').get() as any).n,2);
    assert.equal((target.prepare('SELECT count(*) n FROM output_artifacts').get() as any).n,1);
    assert.equal(target.prepare('SELECT 1 FROM rows WHERE bot_id=?').get(foreign.id),undefined);
  } finally { target.close(); }
});

test('legacy task updates cannot forge a workflow completion in the task panel', async () => {
  const { toolMap } = await import('../server/src/agent/tools.js');
  const bot=createBot('owner',{name:'Verified tasks',isPrimary:true});
  const w=createWorkflow('owner',bot.id,{title:'Evidence required',tasks:[{key:'check',title:'Check',instructions:'Verify actual work',criteria:[{kind:'row',description:'Expected result',contains:'verified'}]}]});
  const result=await toolMap.get('update_task')!.impl({task_id:w.tasks[0].id,state:'done'},{userId:'owner',botId:bot.id,depth:0,enqueueBotMessage:()=>{}});
  assert.equal(result.isError,true);
  assert.notEqual((db.prepare('SELECT state FROM tasks WHERE id=?').get(w.tasks[0].id) as any).state,'done');
  assert.notEqual(getWorkflow('owner',w.id).tasks[0].status,'completed');
});

test('the real dispatcher blocks direct and deferred delegation outside a native workflow', async () => {
  const { toolMap } = await import('../server/src/agent/tools.js');
  const { toolSchemaHash } = await import('../server/src/agent/tool-catalog.js');
  const bot=createBot('owner',{name:'Scoped work',isPrimary:true});
  const target=createBot('owner',{name:'Untracked recipient',isPrimary:true});
  const send=toolMap.get('send_to_bot')!;
  model=body=>body.input.some((i:any)=>i.type==='function_call_output')
    ? [message('{"result":"verified"}')]
    : [call('spawn_subagent',{goal:'Escape the workflow budget'}),call('tool_call',{
      tool_name:send.name,schema_hash:toolSchemaHash({type:'function',name:send.name,parameters:send.parameters}),
      arguments:{bot_name:target.name,message:'Start untracked work'},
    })];
  const w=createWorkflow('owner',bot.id,{title:'Scoped execution',tasks:[{
    key:'check',title:'Check',instructions:'Complete scoped work',criteria:[{kind:'result',description:'Validated result'}],
    outputSchema:{type:'object',properties:{result:{type:'string'}},required:['result'],additionalProperties:false},
  }]});
  startWorkflow('owner',w.id);
  await settleAgentJobs();
  assert.equal(getWorkflow('owner',w.id).status,'completed');
  const denied=listRows(bot.id).filter(r=>r.body.type==='tool-call');
  assert.equal(denied.length,2);
  assert.ok(denied.every(r=>r.body.type==='tool-call' && r.body.status==='denied'));
  assert.equal(db.prepare('SELECT 1 FROM bots WHERE parent_bot_id=?').get(bot.id),undefined);
  assert.equal(db.prepare('SELECT 1 FROM agent_jobs WHERE bot_id=?').get(target.id),undefined);
  const outputs=loadHistory(bot.id).filter((i:any)=>i.type==='function_call_output');
  assert.ok(outputs.every((o:any)=>o.output.includes('untracked legacy delegation')));
});

test('pausing a queued workflow does not interrupt an unrelated chat on the same Bot', async () => {
  const bot=createBot('owner',{name:'Busy coordinator',isPrimary:true});
  let release!:()=>void, started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}), entered=new Promise<void>(resolve=>{started=resolve;});
  model=async()=>{started();await held;return [message('Ordinary chat completed')];};
  const ordinary=enqueue(bot.id,{type:'user',text:'Continue our conversation'});
  await entered;
  const w=createWorkflow('owner',bot.id,{title:'Later workflow',tasks:[{key:'later',title:'Later',instructions:'Wait for the chat',criteria:[{kind:'row',description:'Evidence'}]}]});
  startWorkflow('owner',w.id);
  const signal=turnSignal(bot.id)!;
  try {controlWorkflow('owner',w.id,'pause');assert.equal(signal.aborted,false);}
  finally {release();await settleAgentJobs();}
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(ordinary) as any).state,'completed');
  assert.equal(getWorkflow('owner',w.id).status,'paused');
});

test('a replacement message cancels the old goal approval without capturing or aborting the new job', async () => {
  actions.length=0;
  const {bot,approval,goal}=await programBot('Superseded goal',true);
  model=()=>[message('Replacement request completed')];
  const replacement=enqueue(bot.id,{type:'user',text:'Cancel that action and answer this new request'});
  await settleAgentJobs();
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(replacement) as any).state,'completed');
  assert.equal(db.prepare('SELECT 1 FROM native_workflow_runs WHERE job_id=?').get(replacement),undefined);
  assert.equal(getGoal('owner',goal!.id).status,'blocked');
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(approval.id) as any).status,'expired');
  assert.deepEqual(actions.map(a=>a.name),['read']);
  assert.ok(listRows(bot.id).some(r=>r.body.type==='message' && r.body.text==='Replacement request completed'));
});

test('compaction usage settles before a finite goal can issue its primary model request', async () => {
  const {memoryConfig}=await import('../server/src/agent/memory.js');
  const {appendHistory}=await import('../server/src/store.js');
  const bot=createBot('owner',{name:'Compaction budget',isPrimary:true});
  const goal=createGoal('owner',bot.id,{title:'Bounded work',criteria:[{kind:'row',description:'Evidence'}],maxTokens:20});
  appendHistory(bot.id,Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',content:'Historical message '.repeat(30)})));
  const previous={...memoryConfig};let summaries=0, primary=0;
  Object.assign(memoryConfig,{compactChars:1000,keepTurns:1,compactMethod:'auto'});
  const compactClient=withUsage({userId:'owner'},()=>llmClient(300_000));
  const post=mock.method(compactClient,'post',async(_path:any,request:any)=>{
    summaries++;assert.equal('max_output_tokens' in request.body,false,'compact endpoint does not accept output limits');
    return {output:[{role:'user',content:'Compact historical summary'}],usage:{input_tokens:20,output_tokens:10,cost:0.01}};
  });
  model=()=>{primary++;return [message('Must not request this')];};
  try {enqueue(bot.id,{type:'user',text:'Continue'});await settleAgentJobs();}
  finally {Object.assign(memoryConfig,previous);post.mock.restore();}
  assert.equal(summaries,1);assert.equal(primary,0);
  assert.equal(getGoal('owner',goal.id).status,'paused');
  assert.equal(getGoal('owner',goal.id).tokensUsed,30);
});

test('missing API usage pauses finite goals before executing any requested tool', async () => {
  const bot=createBot('owner',{name:'Missing counters',isPrimary:true});
  const goal=createGoal('owner',bot.id,{title:'Accounted work',criteria:[{kind:'file',description:'Report'}],maxTokens:100});
  const previous=modelUsage;modelUsage=undefined;
  model=()=>[call('save_file',{filename:'should-not-exist.txt',content:'Unaccounted action'})];
  try {enqueue(bot.id,{type:'user',text:'Make a report within the budget'});await settleAgentJobs();}
  finally {modelUsage=previous;}
  assert.equal(getGoal('owner',goal.id).status,'paused');
  assert.equal(listArtifacts('owner',bot.id).length,0);
  assert.equal(getGoal('owner',goal.id).unknownTokenTurns,1);
});

test('fresh-process job and program recovery preserves a held owner and recovers other accounts', async () => {
  const {acceptJob,beginJob,beginTool}=await import('../server/src/agent/jobs.js');
  const {holdLegacyDatabase}=await import('../server/src/platform/legacy-database-fence.js');
  const seeds=['usr_held_native','usr_open_native'].map(userId=>{
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,userId,Date.now());
    const bot=createBot(userId,{name:userId,isPrimary:true});
    const running=acceptJob(bot.id,{type:'user',text:'In-flight work'}),queued=acceptJob(bot.id,{type:'user',text:'Accepted work'});
    beginJob(running.id);beginTool(bot.id,'uncertain-call','save_file','binding');
    db.prepare("INSERT INTO code_runs(id,user_id,bot_id,job_id,binding,state,created_at,updated_at) VALUES(?,?,?,?,?,'running',1,1)").run(`code-${userId}`,userId,bot.id,running.id,'binding');
    db.prepare("INSERT INTO code_steps(run_id,step,call_id,tool,binding,state) VALUES(?,0,'uncertain-step','save_file','binding','dispatching')").run(`code-${userId}`);
    return {userId,botId:bot.id,running:running.id,queued:queued.id,code:`code-${userId}`};
  });
  const [held,open]=seeds;
  const snapshot=()=>JSON.stringify([
    db.prepare('SELECT * FROM agent_jobs WHERE user_id=? ORDER BY id').all(held.userId),
    db.prepare('SELECT * FROM tool_dispatches WHERE bot_id=?').all(held.botId),
    db.prepare('SELECT * FROM code_runs WHERE user_id=?').all(held.userId),
    db.prepare('SELECT * FROM code_steps WHERE run_id=?').all(held.code),
  ]);
  holdLegacyDatabase(db,held.userId,'native-recovery-hold','1');
  const before=snapshot();
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    const {recoverPrograms}=await import('./server/src/agent/programs.ts');
    const {recoverJobs}=await import('./server/src/agent/jobs.ts');
    recoverPrograms();process.stdout.write(JSON.stringify(recoverJobs().map(job=>job.id)));
    const {db}=await import('./server/src/db.ts');db.close();
  `],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:20_000});
  assert.equal(child.status,0,child.stderr);
  const queued=JSON.parse(child.stdout);
  assert.ok(queued.includes(open.queued));assert.ok(!queued.includes(held.queued));
  assert.equal(snapshot(),before);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(open.running) as any).state,'uncertain');
  assert.equal((db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=?').get(open.botId) as any).state,'uncertain');
  assert.equal((db.prepare('SELECT state FROM code_runs WHERE id=?').get(open.code) as any).state,'unknown');
  assert.equal((db.prepare('SELECT state FROM code_steps WHERE run_id=?').get(open.code) as any).state,'unknown');
});
