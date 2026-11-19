import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'quinn-awareness-'));
Object.assign(process.env,{DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'quinn-awareness-fixture',SWARM_ROLE:'standalone',SWARM_NO_SCHEDULER:'1',NODE_ENV:'test',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
const {db}=await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const jobs=await import('../server/src/agent/jobs.js');
const {createBot,transferPrimary}=await import('../server/src/bots.js');
const {appendRow,updateRow}=await import('../server/src/store.js');
const c=await import('../server/src/coordination/index.js');
const sources=await import('../server/src/coordination/sources.js');
const {getTeamRecords}=await import('../server/src/coordination/records.js');
await import('../server/src/deliverables/schema.js');
const enqueued:{botId:string;jobId:string;trigger:any}[]=[];
c.configureCoordinationRuntime({enqueue:(botId,trigger)=>{const job=jobs.acceptJob(botId,trigger);enqueued.push({botId,jobId:job.id,trigger});return job.id;},interrupt:()=>{}});
let serial=0;
function fixture(){const userId=`aware-${++serial}`;db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,userId,Date.now());const chief=createBot(userId,{name:'Quinn',isPrimary:true}),worker=createBot(userId,{name:'Nia'});db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(worker.id);return {userId,chief,worker};}
function human(f:ReturnType<typeof fixture>,text:string){return appendRow(f.worker.id,'message',{type:'message',role:'user',text});}
function parsed(f:ReturnType<typeof fixture>,jobId?:string){const prompt=c.coordinationPrompt(f.userId,f.chief.id,jobId);return JSON.parse(prompt.slice(prompt.indexOf('\n')+1));}
function review(f:ReturnType<typeof fixture>){db.prepare('UPDATE coordination_supervision SET last_review_at=NULL WHERE user_id=?').run(f.userId);c.reviewCoordination();return enqueued.filter(j=>j.botId===f.chief.id).at(-1)!;}
function finish(f:ReturnType<typeof fixture>,job:ReturnType<typeof review>){jobs.beginJob(job.jobId);jobs.finishJob(job.jobId,true);c.onCoordinationJobFinished({userId:f.userId,botId:f.chief.id,jobId:job.jobId,status:'completed',finalText:'Reviewed sources',trigger:job.trigger});}
after(()=>{db.close();fs.rmSync(storage,{recursive:true,force:true});});

test('all 27 coworkers have coverage and stable paginated retrieval despite bounded context',()=>{
 const f=fixture();for(let i=0;i<25;i++)createBot(f.userId,{name:`Worker ${i}`});const p=parsed(f);
 assert.equal(p.coverage.agents.total,27);assert.equal(p.coverage.agents.returned,24);assert.equal(p.coverage.agents.omitted,3);assert.equal(p.omittedDetails,true);
 const first=getTeamRecords(f.userId,{kind:'agents',limit:10});createBot(f.userId,{name:'Added after page'});let ids=first.records.map((r:any)=>r.id),page=first;
 while(page.hasMore){page=getTeamRecords(f.userId,{kind:'agents',after:page.nextCursor,through:page.through,limit:10});ids.push(...page.records.map((r:any)=>r.id));}
 assert.equal(new Set(ids).size,27);
});
test('older running work is prioritized and every historical job remains retrievable',()=>{
 const f=fixture(),old=jobs.acceptJob(f.worker.id,{type:'user',text:'Still working'});jobs.beginJob(old.id);db.prepare('UPDATE agent_jobs SET created_at=1 WHERE id=?').run(old.id);
 for(let i=0;i<205;i++){const j=jobs.acceptJob(f.worker.id,{type:'user',text:'Finished'});jobs.beginJob(j.id);jobs.finishJob(j.id,true);}
 const state=c.teamState(f.userId);assert.ok(state.jobs.some(j=>j.id===old.id));assert.equal(state.coverage.jobs.total,206);assert.equal(state.coverage.jobs.omitted,6);
 let page=getTeamRecords(f.userId,{kind:'jobs',limit:100}),count=page.records.length;while(page.hasMore){page=getTeamRecords(f.userId,{kind:'jobs',after:page.nextCursor,through:page.through,limit:100});count+=page.records.length;}assert.equal(count,206);
});
test('hidden temporary helpers are visible through their parent lineage',()=>{
 const f=fixture(),helper=createBot(f.userId,{name:'Helper'});db.prepare('UPDATE bots SET hidden=1,parent_bot_id=? WHERE id=?').run(f.worker.id,helper.id);
 assert.equal(c.teamState(f.userId).agents.find(a=>a.botId===helper.id)?.parentBotId,f.worker.id);
});
test('a direct specialist instruction durably wakes Quinn and enters attributed context',()=>{
 const f=fixture(),initial=review(f);finish(f,initial);human(f,'From now on target founder-led SaaS with 10–50 employees.');
 const next=review(f);assert.notEqual(next.jobId,initial.jobId);const p=parsed(f,next.jobId);assert.match(p.sources[0].text,/founder-led SaaS/);assert.equal(p.sources[0].source.botId,f.worker.id);
 finish(f,next);assert.equal(sources.humanSourceState(f.userId).pending,0);
});
test('direct job state changes wake Quinn even when no artifact is produced',()=>{
 const f=fixture(),initial=review(f);finish(f,initial);const work=jobs.acceptJob(f.worker.id,{type:'user',text:'Investigate'});jobs.beginJob(work.id);jobs.finishJob(work.id,false);
 const next=review(f);assert.notEqual(next.jobId,initial.jobId);assert.ok(parsed(f).jobs.some((j:any)=>j.id===work.id&&j.state==='uncertain'));
});
test('internal messages and assistant narration never become human source evidence',()=>{
 const f=fixture();appendRow(f.worker.id,'message',{type:'message',role:'user',text:'Peer',from:{kind:'bot',id:f.chief.id,name:'Quinn'}});
 appendRow(f.worker.id,'message',{type:'message',role:'assistant',text:'Generated claim'});assert.equal(sources.humanSourceState(f.userId).total,0);
});
test('source and transcript admission roll back in one transaction',()=>{
 const f=fixture();assert.throws(()=>db.transaction(()=>{human(f,'Rolled back');throw new Error('fault');})());assert.equal(sources.humanSourceState(f.userId).total,0);
});
test('noncoordinators and foreign accounts cannot read another conversation source',()=>{
 const f=fixture(),other=fixture();human(f,'Private to authorized team');const event=sources.listHumanSources(f.userId).sources[0].eventSeq;
 assert.throws(()=>sources.readHumanSource(f.userId,f.worker.id,event),/coordinator/);assert.throws(()=>sources.readHumanSource(other.userId,other.chief.id,event),/not found/);
 assert.equal(getTeamRecords(other.userId,{kind:'sources'}).records.length,0);
});
test('source contents never leak into the ordinary team board',()=>{
 const f=fixture();human(f,'ONLY_COORDINATOR_SOURCE');assert.doesNotMatch(JSON.stringify(c.teamState(f.userId)),/ONLY_COORDINATOR_SOURCE/);
});
test('successful review advances only through fully presented sources',()=>{
 const f=fixture();for(let i=0;i<9;i++)human(f,`User requirement ${i}`);const j=review(f);const p=parsed(f,j.jobId);assert.equal(p.sources.length,6);assert.equal(p.sourcePage.hasMore,true);
 finish(f,j);assert.equal(sources.humanSourceState(f.userId).pending,3);const next=review(f);parsed(f,next.jobId);finish(f,next);assert.equal(sources.humanSourceState(f.userId).pending,0);
});
test('long sources stay pending until every contiguous fragment is actually presented',()=>{
 const f=fixture();human(f,'x'.repeat(12000));const j=review(f),p=parsed(f,j.jobId),event=p.sources[0].eventSeq;
 assert.equal(p.sources[0].complete,false);sources.readHumanSource(f.userId,f.chief.id,event,8000,4000,j.jobId);finish(f,j);assert.equal(sources.humanSourceState(f.userId).pending,1);
 const next=review(f);parsed(f,next.jobId);sources.readHumanSource(f.userId,f.chief.id,event,2000,8000,next.jobId);sources.readHumanSource(f.userId,f.chief.id,event,10000,2000,next.jobId);finish(f,next);assert.equal(sources.humanSourceState(f.userId).pending,0);
});
test('source edits invalidate already-read content before review settlement',()=>{
 const f=fixture(),r=human(f,'Old instruction');const j=review(f);parsed(f,j.jobId);updateRow(f.worker.id,r.seq,{type:'message',role:'user',text:'New instruction'});finish(f,j);
 assert.equal(sources.humanSourceState(f.userId).pending,1);assert.match(JSON.stringify(parsed(f).sources),/New instruction/);
});
test('deleted sources are reported unavailable rather than resurrected from event payloads',()=>{
 const f=fixture(),r=human(f,'Erase this source');const event=sources.listHumanSources(f.userId).sources[0].eventSeq;db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=?').run(f.worker.id,r.seq);
 assert.equal(sources.readHumanSource(f.userId,f.chief.id,event).status,'unavailable_or_superseded');assert.doesNotMatch(JSON.stringify(sources.readHumanSource(f.userId,f.chief.id,event)),/Erase this source/);
});
test('retained historical messages remain inspectable across a conversation reset',()=>{
 const f=fixture();human(f,'Retained original');const event=sources.listHumanSources(f.userId).sources[0].eventSeq;db.prepare('UPDATE bots SET generation=generation+1 WHERE id=?').run(f.worker.id);
 assert.equal(sources.readHumanSource(f.userId,f.chief.id,event).text,'Retained original');
});
test('primary transfer immediately revokes old coordinator source access',()=>{
 const f=fixture();human(f,'Scoped evidence');const event=sources.listHumanSources(f.userId).sources[0].eventSeq;transferPrimary(f.userId,f.chief.id,f.worker.id);
 assert.throws(()=>sources.readHumanSource(f.userId,f.chief.id,event),/coordinator/);assert.equal(sources.readHumanSource(f.userId,f.worker.id,event).text,'Scoped evidence');
});
test('historical backfill is idempotent and does not fabricate fresh user requests',()=>{
 const f=fixture();db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,100,100,?,?,1)').run(f.worker.id,'message',JSON.stringify({type:'message',role:'user',text:'Historical context'}));
 sources.backfillHumanSources();sources.backfillHumanSources();assert.equal(sources.humanSourceState(f.userId).total,1);assert.equal(sources.humanSourceState(f.userId).pending,0);assert.equal(sources.listHumanSources(f.userId).sources[0].historical,true);
});
test('large active queues disclose omitted nested job IDs and remain bounded',()=>{
 const f=fixture();for(let i=0;i<900;i++)db.prepare("INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at) VALUES(?,?,?,'{}','queued',?)").run(`queue-${f.userId}-${i}`,f.userId,f.worker.id,Date.now());
 const p=parsed(f);assert.ok(JSON.stringify(p).length<24000);assert.equal(p.omittedDetails,true);assert.equal(p.agents.find((a:any)=>a.botId===f.worker.id).activeJobCount,900);assert.equal(p.coverage.jobs.total,900);
});
test('no recent progress is explicit and does not cancel a long-running job',()=>{
 const f=fixture(),j=jobs.acceptJob(f.worker.id,{type:'user',text:'Long task'});jobs.beginJob(j.id);db.prepare('UPDATE bots SET updated_at=1 WHERE id=?').run(f.worker.id);
 assert.equal(c.teamState(f.userId).agents.find(a=>a.botId===f.worker.id)?.observation,'no_recent_progress_observed');assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(j.id) as any).state,'running');
});
test('team record HTTP requires authentication and pages only the owner',async()=>{
 const {coordinationApi}=await import('../server/src/routes-coordination.js');const {Hono}=await import('hono');const app=new Hono().route('/api/team',coordinationApi);const f=fixture();
 assert.equal((await app.request('/api/team/records?kind=jobs')).status,401);
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('aware-session',f.userId,Date.now(),Date.now()+60000);
 const response=await app.request('/api/team/records?kind=agents&limit=1',{headers:{cookie:'swarm_session=aware-session'}});assert.equal(response.status,200);const body=await response.json() as any;assert.equal(body.records.length,1);assert.equal(body.hasMore,true);
});
test('invalid paging and source offsets fail before data access',()=>{
 const f=fixture();human(f,'Example');const event=sources.listHumanSources(f.userId).sources[0].eventSeq;
 assert.throws(()=>getTeamRecords(f.userId,{kind:'jobs',after:-1}));assert.throws(()=>getTeamRecords(f.userId,{kind:'jobs',limit:101}));assert.throws(()=>sources.readHumanSource(f.userId,f.chief.id,event,100));
});

test('canonical cancellation and restart uncertainty wake Quinn without a model completion',()=>{
 const f=fixture(),work=jobs.acceptJob(f.worker.id,{type:'user',text:'Work awaiting recovery'});jobs.beginJob(work.id);
 let reviewJob=review(f);parsed(f,reviewJob.jobId);finish(f,reviewJob);
 jobs.recoverJobs();const recovered=review(f);assert.notEqual(recovered.jobId,reviewJob.jobId);
 assert.ok(parsed(f).jobs.some((j:any)=>j.id===work.id&&j.state==='uncertain'));finish(f,recovered);
 db.prepare("UPDATE agent_jobs SET state='cancelled',finished_at=? WHERE id=?").run(Date.now(),work.id);
 assert.notEqual(review(f).jobId,recovered.jobId);
});
test('ambiguous primary identity fails closed for source access and automatic supervision',()=>{
 const f=fixture();human(f,'Private source');const source=sources.listHumanSources(f.userId).sources[0];
 db.prepare('UPDATE bots SET is_primary=1 WHERE id=?').run(f.worker.id);
 assert.equal(c.teamState(f.userId).primaryBotId,null);
 assert.throws(()=>sources.readHumanSource(f.userId,f.chief.id,source.eventSeq),/coordinator/);
 assert.throws(()=>sources.readHumanSource(f.userId,f.worker.id,source.eventSeq),/coordinator/);
 c.reviewCoordination();assert.equal(enqueued.filter(j=>j.botId===f.chief.id||j.botId===f.worker.id).length,0);
});

test('coordinator reads complete direct specialist results with agent attribution, independently of delivery',async()=>{
 const f=fixture(),other=fixture(),j=jobs.acceptJob(f.worker.id,{type:'user',text:'Analyze supplied figures'});jobs.beginJob(j.id);jobs.finishJob(j.id,true);
 const {recordJobCompletion}=await import('../server/src/native/job-completions.js');
 const {readTeamJob}=await import('../server/src/coordination/records.js');
 const result='Agent finding: '+('Detailed source analysis. '.repeat(600));
 recordJobCompletion({userId:f.userId,botId:f.worker.id,jobId:j.id,trigger:{type:'user'},completion:{status:'completed',finalText:result,generation:1}});
 assert.equal((getTeamRecords(f.userId,{kind:'jobs'}).records[0] as any).has_recorded_result,1);
 const first=readTeamJob(f.userId,f.chief.id,j.id);assert.equal(first.status,'recorded_agent_output');assert.equal(first.complete,false);
 const rest=readTeamJob(f.userId,f.chief.id,j.id,first.nextOffset!);assert.equal(first.text!+rest.text!,result);assert.equal(rest.complete,true);
 assert.match(first.instructions,/not a human instruction/);assert.match(first.instructions,/Verify acceptance and delivery independently/);
 assert.equal((first as any).source.botId,f.worker.id);
 assert.throws(()=>readTeamJob(other.userId,other.chief.id,j.id),/not found/);
 assert.throws(()=>readTeamJob(f.userId,f.worker.id,j.id),/coordinator/);
 assert.throws(()=>readTeamJob(f.userId,f.chief.id,j.id,result.length+1),/offset/);
 assert.doesNotMatch(JSON.stringify(c.teamState(f.userId)),/Detailed source analysis/);
});
test('finished work without a result never fabricates an outcome',async()=>{
 const f=fixture(),j=jobs.acceptJob(f.worker.id,{type:'user',text:'Lost result'});jobs.beginJob(j.id);jobs.finishJob(j.id,false);
 const {readTeamJob}=await import('../server/src/coordination/records.js');const result=readTeamJob(f.userId,f.chief.id,j.id);
 assert.equal(result.status,'result_unavailable');assert.equal(result.job.state,'uncertain');assert.equal(result.text,null);
});

test('changes outside bounded artifact and delivery previews still wake coordinator review',()=>{
 const f=fixture();
 for(let i=0;i<105;i++){
  const id=`artifact-${f.userId}-${i}`;
  db.prepare('INSERT INTO output_artifacts(id,user_id,bot_id,filename,mime_type,size,sha256,source_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(id,f.userId,f.worker.id,`result-${i}.txt`,'text/plain',1,'a'.repeat(64),id,i+1);
  db.prepare("INSERT INTO artifact_deliveries(id,user_id,artifact_id,channel,target_json,status,created_at,updated_at) VALUES(?,?,?,'library','{}','pending',?,?)")
   .run(`delivery-${f.userId}-${i}`,f.userId,id,i+1,i+1);
 }
 const initial=review(f);finish(f,initial);const before=c.teamState(f.userId);
 assert.equal(before.coverage.artifacts.omitted,5);assert.equal(before.coverage.deliveries.omitted,5);
 assert.ok(!before.artifacts.some(a=>a.id===`artifact-${f.userId}-0`));
 db.prepare('UPDATE output_artifacts SET filename=? WHERE id=?').run('Corrected old artifact.txt',`artifact-${f.userId}-0`);
 const after=c.teamState(f.userId);assert.notEqual(after.sourceVersions.artifacts,before.sourceVersions.artifacts);
 const next=review(f);assert.notEqual(next.jobId,initial.jobId);finish(f,next);
 db.prepare("UPDATE artifact_deliveries SET status='unknown' WHERE id=?").run(`delivery-${f.userId}-0`);
 assert.notEqual(c.teamState(f.userId).sourceVersions.deliveries,before.sourceVersions.deliveries);
 assert.notEqual(review(f).jobId,next.jobId);
});

test('an admitted review loses authority immediately when the primary becomes ambiguous',()=>{
 const f=fixture(),j=review(f);assert.equal(c.coordinationPreTurn({userId:f.userId,botId:f.chief.id,jobId:j.jobId}).allowed,true);
 db.prepare('UPDATE bots SET is_primary=1 WHERE id=?').run(f.worker.id);
 assert.equal(c.coordinationPreTurn({userId:f.userId,botId:f.chief.id,jobId:j.jobId}).allowed,false);
});
test('pinned record pages exclude later insertions even after SQLite reuses a deleted tail rowid',()=>{
 const f=fixture(),tail=createBot(f.userId,{name:'Last at snapshot'});
 const rowid=(db.prepare('SELECT rowid n FROM bots WHERE id=?').get(tail.id) as any).n;
 const first=getTeamRecords(f.userId,{kind:'agents',limit:1});
 db.prepare('DELETE FROM bots WHERE id=?').run(tail.id);
 const replacement=createBot(f.userId,{name:'Created after snapshot'});
 assert.equal((db.prepare('SELECT rowid n FROM bots WHERE id=?').get(replacement.id) as any).n,rowid);
 const rest=getTeamRecords(f.userId,{kind:'agents',after:first.nextCursor,through:first.through,limit:100});
 assert.ok(!rest.records.some((r:any)=>r.id===replacement.id));
 assert.ok(getTeamRecords(f.userId,{kind:'agents',limit:100}).records.some((r:any)=>r.id===replacement.id));
});

test('standalone specialist goals, legacy tasks and routines remain visible and wake review without a workflow',async()=>{
 const f=fixture(),other=fixture();const {createGoal}=await import('../server/src/agent/goals.js');
 const initial=review(f);finish(f,initial);
 const goal=createGoal(f.userId,f.worker.id,{title:'Independent objective',criteria:[{kind:'result',description:'Verified outcome'}]});
 db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'working','Waiting for input',?,?)")
  .run(`task-${f.userId}`,f.worker.id,'Independent task',Date.now(),Date.now());
 db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES(?,?,?,?,?,?,0,?)')
  .run(`routine-${f.userId}`,f.worker.id,'Daily research','Use approved scope','0 9 * * *','UTC',Date.now());
 const next=review(f);assert.notEqual(next.jobId,initial.jobId);
 const state=parsed(f);assert.equal(state.coverage.goals.total,1);assert.equal(state.coverage.routines.total,1);assert.equal(state.coverage.tasks.total,1);
 assert.equal(state.goals[0].id,goal.id);assert.equal(state.routines[0].enabled,0);
 for(const kind of ['goals','tasks','routines'] as const){assert.equal(getTeamRecords(f.userId,{kind}).records.length,1);assert.equal(getTeamRecords(other.userId,{kind}).records.length,0);}
 finish(f,next);db.prepare('UPDATE routines SET enabled=1 WHERE id=?').run(`routine-${f.userId}`);
 assert.notEqual(review(f).jobId,next.jobId);
});
