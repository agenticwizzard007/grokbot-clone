import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-job-completions-'));
Object.assign(process.env,{SWARM_ROLE:'standalone',NODE_ENV:'test',DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'native-completion-isolated-tests',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
const {db}=await import('../server/src/db.js');
const {acceptJob,beginJob,finishJob}=await import('../server/src/agent/jobs.js');
const outbox=await import('../server/src/native/job-completions.js');
const {listNativeEvents}=await import('../server/src/native/events.js');
const fences=await import('../server/src/platform/legacy-database-fence.js');
after(()=>{db.close();fs.rmSync(storage,{recursive:true,force:true});});
let sequence=0;
function fixture(ownerId?:string){const userId=ownerId??'usr_completion_'+(++sequence),botId='bot_completion_'+(++sequence);db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,userId+'@example.test',userId,Date.now());db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId,userId,botId,Date.now(),Date.now());const trigger={type:'system',text:'Completion fixture',audience:'internal'};const jobId=acceptJob(botId,trigger).id;beginJob(jobId);return{userId,botId,jobId,trigger,completion:{status:'completed',finalText:'Verified source result',iterations:1,generation:1,model:'fixture',provider:'fixture',temporary:false,messagesSnapshot:[]}};}
function commit(f:ReturnType<typeof fixture>){db.transaction(()=>{finishJob(f.jobId,true);outbox.recordJobCompletion(f);})();}
function child(code:string){return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:process.env,encoding:'utf8'});}
const imports="const {db}=await import('./server/src/db.ts');await import('./server/src/agent/jobs.ts');const o=await import('./server/src/native/job-completions.ts');";

test('job settlement, completion intent and native event roll back as one transaction',()=>{
 const f=fixture();assert.throws(()=>db.transaction(()=>{finishJob(f.jobId,true);outbox.recordJobCompletion(f);throw new Error('Injected crash before commit');})(),/Injected/);assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(f.jobId) as any).state,'running');assert.equal(outbox.pendingJobCompletions(f.jobId).length,0);assert.equal(listNativeEvents(f.userId).length,0);
 commit(f);assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(f.jobId) as any).state,'completed');assert.equal(outbox.pendingJobCompletions(f.jobId).length,1);assert.equal(listNativeEvents(f.userId).filter(e=>e.kind==='job.execution_finished').length,1);
});
test('completion identity is immutable and idempotent; unsettled and mismatched jobs are rejected',()=>{
 const f=fixture(),other=fixture();assert.throws(()=>outbox.recordJobCompletion(f),/settled owned job/);commit(f);outbox.recordJobCompletion(f);assert.equal(outbox.pendingJobCompletions(f.jobId).length,1);assert.equal(listNativeEvents(f.userId).length,1);assert.throws(()=>outbox.recordJobCompletion({...f,completion:{...f.completion,finalText:'Changed result'}}),/identity changed/);assert.throws(()=>outbox.recordJobCompletion({...f,userId:other.userId}),/settled owned job/);assert.throws(()=>outbox.recordJobCompletion({...f,botId:other.botId}),/settled owned job/);
 const sibling='bot_completion_sibling_'+(++sequence);db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(sibling,f.userId,'Sibling',Date.now(),Date.now());assert.throws(()=>outbox.recordJobCompletion({...f,botId:sibling}),/settled owned job/);
});
test('consumer acknowledgement rolls back with its effect and remains independent of other consumers',()=>{
 const f=fixture();commit(f);const prior=(db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name;
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Uncommitted consumer effect',f.botId);outbox.acknowledgeJobCompletion(f.userId,f.jobId,'coordination');throw new Error('Consumer failed');})(),/failed/);assert.equal((db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name,prior);assert.equal(outbox.pendingJobCompletions(f.jobId)[0].coordinationDone,false);
 db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Committed consumer effect',f.botId);outbox.acknowledgeJobCompletion(f.userId,f.jobId,'coordination');})();let pending=outbox.pendingJobCompletions(f.jobId);assert.equal(pending.length,1);assert.equal(pending[0].coordinationDone,true);assert.equal(pending[0].learningDone,false);outbox.acknowledgeJobCompletion(f.userId,f.jobId,'coordination');outbox.acknowledgeJobCompletion(f.userId,f.jobId,'learning');assert.equal(outbox.pendingJobCompletions(f.jobId).length,0);
});
test('process loss before settlement commit leaves the original job running and no completion intent',()=>{
 const f=fixture();const result=child(imports+`const j=await import('./server/src/agent/jobs.ts');db.transaction(()=>{j.finishJob(${JSON.stringify(f.jobId)},true);o.recordJobCompletion(${JSON.stringify(f)});process.exit(71);})();`);assert.equal(result.status,71,result.stderr);assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(f.jobId) as any).state,'running');assert.equal(outbox.pendingJobCompletions(f.jobId).length,0);assert.equal(listNativeEvents(f.userId).length,0);commit(f);assert.equal(outbox.pendingJobCompletions(f.jobId).length,1);
});
test('restart replays only unfinished consumers and never repeats committed effects or business execution',()=>{
 const f=fixture();commit(f);const taskId='consumer_effect_'+(++sequence);
 const consume=(consumer:'coordination'|'learning',exitCode:number,crashBeforeCommit=false)=>imports+`const f=${JSON.stringify(f)};const pending=o.pendingJobCompletions(f.jobId);for(const row of pending){if(row.${consumer==='coordination'?'coordinationDone':'learningDone'})continue;db.transaction(()=>{db.prepare("INSERT OR IGNORE INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'done','Consumer receipt',?,?)").run(${JSON.stringify(taskId+'_'+consumer)},f.botId,${JSON.stringify(consumer+' consumer effect')},Date.now(),Date.now());${crashBeforeCommit?`process.exit(${exitCode});`:''}o.acknowledgeJobCompletion(f.userId,f.jobId,${JSON.stringify(consumer)});})();}process.exit(${exitCode});`;
 let result=child(consume('coordination',72,true));assert.equal(result.status,72,result.stderr);assert.equal(db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId+'_coordination'),undefined);assert.equal(outbox.pendingJobCompletions(f.jobId)[0].coordinationDone,false);
 result=child(consume('coordination',73));assert.equal(result.status,73,result.stderr);assert.ok(db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId+'_coordination'));let pending=outbox.pendingJobCompletions(f.jobId);assert.equal(pending[0].coordinationDone,true);assert.equal(pending[0].learningDone,false);
 result=child(consume('coordination',0));assert.equal(result.status,0,result.stderr);assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks WHERE id=?').get(taskId+'_coordination') as any).n,1);
 result=child(consume('learning',74));assert.equal(result.status,74,result.stderr);assert.equal(outbox.pendingJobCompletions(f.jobId).length,0);assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE user_id=?').get(f.userId) as any).n,1);assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(f.jobId) as any).state,'completed');
});
test('another account cannot acknowledge an owned completion',()=>{
 const f=fixture(),other=fixture();commit(f);outbox.acknowledgeJobCompletion(other.userId,f.jobId,'coordination');outbox.acknowledgeJobCompletion(other.userId,f.jobId,'learning');const pending=outbox.pendingJobCompletions(f.jobId);assert.equal(pending.length,1);assert.equal(pending[0].coordinationDone,false);assert.equal(pending[0].learningDone,false);
});
test('held owners retain completion intents while independent owners resume consumers after restart',()=>{
 const held=fixture('usr_completion_held_0001'),free=fixture();commit(held);commit(free);fences.holdLegacyDatabase(db,held.userId,'native-completion-migration-test','1');assert.equal(outbox.pendingJobCompletions(held.jobId).length,0);assert.throws(()=>outbox.acknowledgeJobCompletion(held.userId,held.jobId,'coordination'),/migrat/);
 const before=db.prepare('SELECT * FROM native_job_completions WHERE job_id=?').get(held.jobId);const result=child(imports+`const f=await import('./server/src/platform/legacy-database-fence.ts');f.assertLegacyDatabaseFences(db);const pending=o.pendingJobCompletions(${JSON.stringify(free.jobId)});if(pending.length!==1)throw Error('Missing free completion');o.acknowledgeJobCompletion(${JSON.stringify(free.userId)},${JSON.stringify(free.jobId)},'coordination');o.acknowledgeJobCompletion(${JSON.stringify(free.userId)},${JSON.stringify(free.jobId)},'learning');db.close();`);assert.equal(result.status,0,result.stderr);assert.equal(outbox.pendingJobCompletions(free.jobId).length,0);assert.deepEqual(db.prepare('SELECT * FROM native_job_completions WHERE job_id=?').get(held.jobId),before);fences.assertLegacyDatabaseFences(db);
});
