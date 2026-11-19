// Run with node --import tsx --test --test-concurrency=1 tests/native-synopsis.test.mts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, mock, test } from 'node:test';
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-synopsis-'));
Object.assign(process.env,{DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SWARM_ROLE:'standalone',NODE_ENV:'test',SESSION_SECRET:'synopsis-tests-secret',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
mock.method(globalThis,'fetch',async()=>{throw new Error('Synopsis tests forbid network access');});
const {db}=await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const {createBot}=await import('../server/src/bots.js');
await import('../server/src/agent/workflows.js');
await import('../server/src/knowledge/schema.js');
const reports=await import('../server/src/coordination/reports.js');
const p=await import('../server/src/proactive.js');
const artifacts=await import('../server/src/deliverables/artifacts.js');
const delivery=await import('../server/src/deliverables/delivery.js');
const {publishNativeEvent}=await import('../server/src/native/events.js');
const {appendRow}=await import('../server/src/store.js');
const {checkinsApi}=await import('../server/src/routes-proactive.js');
const {Hono}=await import('hono');
const app=new Hono().route('/api/checkins',checkinsApi);
const at=(date:string)=>Date.parse(date);
let seq=0;
function fixture() {
 const userId=`synopsis-${++seq}`;db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,`${userId}@example.test`,userId,Date.now());
 const bot=createBot(userId,{name:'Quinn',isPrimary:true});
 return {userId,bot};
}
type F=ReturnType<typeof fixture>;
function create(f:F,slot:string,time=Date.now()) {return reports.createSynopsis({userId:f.userId,botId:f.bot.id,slotKey:slot,timezone:'UTC',time});}
function count(f:F){return (db.prepare('SELECT COUNT(*) n FROM coordination_synopses WHERE user_id=?').get(f.userId) as any).n;}
function cursor(f:F){return db.prepare('SELECT * FROM coordination_report_cursors WHERE user_id=?').get(f.userId) as any;}
function rows(f:F){return db.prepare('SELECT * FROM coordination_synopses WHERE user_id=? ORDER BY seq').all(f.userId) as any[];}
async function materialize(f:F,id:string){await reports.materializeSynopsis(f.userId,id);return reports.getSynopsis(f.userId,id);}
async function complete(f:F,id:string){await materialize(f,id);await reports.dispatchSynopsis(f.userId,id);return reports.getSynopsis(f.userId,id);}
function schedule(f:F,time:string,settings:Parameters<typeof p.setCheckins>[1]={}) {p.setCheckins(f.userId,{enabled:true,times:['09:00'],timezone:'UTC',...settings},at(time));}
async function tick(time:string){p.tickProactive(at(time));await p.settleProactive();}
function artifactPath(f:F,id:string){const a=artifacts.getArtifact(f.userId,id);return path.join(storage,'files',f.bot.id,'Deliverables',a.id,a.filename);}
after(async()=>{reports.configureSynopsisNarrator();await p.settleProactive();mock.restoreAll();db.close();fs.rmSync(storage,{recursive:true,force:true});});

test('new settings stay disabled, use 09:00/account timezone, and preserve legacy explicit schedules',()=>{
 const f=fixture();assert.deepEqual(p.getCheckins(f.userId),{enabled:false,times:['09:00'],timezone:'UTC',timezoneSource:'utc_fallback',quietHours:[]});
 if(!(db.prepare('PRAGMA table_info(users)').all() as any[]).some(c=>c.name==='timezone'))db.exec('ALTER TABLE users ADD COLUMN timezone TEXT');
 db.prepare('UPDATE users SET timezone=? WHERE id=?').run('America/New_York',f.userId);
 assert.equal(p.getCheckins(f.userId).timezone,'America/New_York');assert.equal(p.getCheckins(f.userId).timezoneSource,'account');
 p.setCheckins(f.userId,{times:['16:30','09:00'],timezone:'Asia/Tokyo',enabled:false,quietHours:[{start:'23:00',end:'07:00'}]});
 p.setCheckins(f.userId,{enabled:true});const current=p.getCheckins(f.userId);
 assert.deepEqual(current.times,['09:00','16:30']);assert.equal(current.timezone,'Asia/Tokyo');assert.equal(current.quietHours.length,1);
 p.setCheckins(f.userId,{enabled:false});assert.equal(p.getCheckins(f.userId).enabled,false);
 assert.throws(()=>p.setCheckins(f.userId,{times:['25:00']}),/HH:MM/);assert.throws(()=>p.setCheckins(f.userId,{enabled:'true' as any}),/boolean/);
});
test('missed days coalesce once, remain pending through quiet hours and do not use model queue',async()=>{
 const f=fixture();schedule(f,'2026-10-01T10:00:00Z',{quietHours:[{start:'00:00',end:'10:00'}]});
 await tick('2026-10-06T09:30:00Z');assert.equal(count(f),0);
 const due=db.prepare('SELECT * FROM proactive_due_slots WHERE user_id=?').get(f.userId) as any;assert.equal(due.slot_count,5);assert.equal(due.first_slot,'2026-10-02 09:00');
 // Leave quiet hours without changing configuration or consuming the due window.
 await tick('2026-10-06T11:00:00Z');assert.equal(count(f),1);
 const report=reports.getSynopsis(f.userId,rows(f)[0].id);assert.equal(report.slotCount,5);assert.equal(report.delivery?.status,'delivered');
 await tick('2026-10-06T11:01:00Z');assert.equal(count(f),1);assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE user_id=?').get(f.userId) as any).n,0);
 p.setCheckins(f.userId,{enabled:false});
});
test('a recent human conversation defers and coalesces; internal messages and pending decisions do not block reporting',async()=>{
 const f=fixture();const t=at('2026-11-18T08:55:00Z');schedule(f,'2026-11-17T10:00:00Z');
 appendRow(f.bot.id,'message',{type:'message',role:'user',text:'Human asks'});db.prepare('UPDATE rows SET created_at=? WHERE bot_id=?').run(t,f.bot.id);
 await tick('2026-11-18T09:00:00Z');assert.equal(count(f),0);
 appendRow(f.bot.id,'card',{type:'card',card:'question',title:'Keep this open',status:'pending'} as any);
 await tick('2026-11-18T09:20:00Z');assert.equal(count(f),1);
 const report=reports.getSynopsis(f.userId,rows(f)[0].id);assert.match(report.content!,/Keep this open/);
 assert.equal(JSON.parse((db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card'").get(f.bot.id) as any).body).status,'pending');p.setCheckins(f.userId,{enabled:false});
});
test('DST repeated local time runs once and nonexistent time fires after the gap',async()=>{
 const repeated=fixture();schedule(repeated,'2026-11-01T04:00:00Z',{times:['01:30'],timezone:'America/New_York'});
 await tick('2026-11-01T05:30:00Z');assert.equal(count(repeated),1);
 await tick('2026-11-01T06:30:00Z');assert.equal(count(repeated),1);assert.equal(rows(repeated)[0].slot_key,'2026-11-01 01:30');p.setCheckins(repeated.userId,{enabled:false});
 const gap=fixture();schedule(gap,'2026-03-08T05:00:00Z',{times:['02:30'],timezone:'America/New_York'});
 await tick('2026-03-08T06:59:00Z');assert.equal(count(gap),0);
 await tick('2026-03-08T07:00:00Z');assert.equal(count(gap),1);assert.equal(rows(gap)[0].slot_key,'2026-03-08 02:30');p.setCheckins(gap.userId,{enabled:false});
});
test('multi-year downtime is one bounded catchup record, never before enable or after disable',async()=>{
 const f=fixture();schedule(f,'2020-01-01T10:00:00Z');await tick('2026-11-18T10:00:00Z');assert.equal(count(f),1);assert.ok(rows(f)[0].slot_count>2000);
 p.setCheckins(f.userId,{enabled:false});await tick('2026-11-20T10:00:00Z');assert.equal(count(f),1);
 schedule(f,'2026-11-23T10:00:00Z');await tick('2026-11-23T11:00:00Z');assert.equal(count(f),1);await tick('2026-11-24T10:00:00Z');assert.equal(count(f),2);p.setCheckins(f.userId,{enabled:false});
});
test('daily no-change report is durable with no model, no task queue and no external channel inference',async()=>{
 const f=fixture(),first=create(f,'manual:one',Date.now()-10000);await complete(f,first);
 const id=create(f,'manual:two');const r=await complete(f,id);assert.equal(r.changedCount,0);assert.match(r.content!,/No changes/);assert.equal(r.delivery?.channel,'library');
 assert.equal(r.delivery?.acknowledgement,'library');assert.equal(cursor(f).materialized_through,cursor(f).delivered_through);
 const d=delivery.getDelivery(f.userId,r.delivery!.id);await reports.dispatchSynopsis(f.userId,id);assert.equal(delivery.getDelivery(f.userId,d.id).attempts.length,1);
});
test('source snapshots and full pagination preserve over 100 rows and the oldest open blocker',async()=>{
 const f=fixture(),stamp=Date.now()-86400000;
 const insert=db.prepare(`INSERT INTO routine_executions(id,user_id,bot_id,routine_id,routine_name,fire_key,kind,status,created_at,finished_at) VALUES(?,?,?,?,?,?,'cron',?,?,?)`);
 db.transaction(()=>{for(let n=0;n<255;n++)insert.run(`run-${f.userId}-${n.toString().padStart(3,'0')}`,f.userId,f.bot.id,`routine-${n}`,`Outcome ${n}`,`slot-${n}`,'completed',stamp,stamp);
 insert.run(`zz-old-${f.userId}`,f.userId,f.bot.id,'ancient','Old blocker must remain','old-slot','failed',1,1);})();
 const id=create(f,'manual:many');const frozen=reports.getSynopsis(f.userId,id);assert.ok(frozen.sourceCount>=257);
 db.prepare("UPDATE routine_executions SET routine_name='Changed after snapshot' WHERE user_id=?").run(f.userId);
 const r=await complete(f,id);assert.equal(r.coverage.summaryComplete,false);assert.match(r.content!,/summary coverage is partial/);assert.match(r.content!,/Old blocker must remain/);assert.doesNotMatch(r.content!,/Changed after snapshot/);
 const all:any[]=[];let after=0;while(true){const page=reports.reportSourcePage(f.userId,id,after,37);all.push(...page.sources);after=page.nextCursor;if(!page.hasMore)break;}
 assert.equal(all.length,r.sourceCount);assert.equal(new Set(all.map(s=>s.id)).size,r.sourceCount);assert.equal(r.pages.length,Math.ceil(r.sourceCount/100));
 for(const page of r.pages as any[]){const text=artifacts.readArtifact(f.userId,page.artifactId).content.toString();assert.ok(text.length<500_000);}
 assert.throws(()=>db.prepare('UPDATE coordination_synopsis_sources SET title=? WHERE report_id=?').run('mutated',id),/immutable/);
 assert.throws(()=>db.prepare('UPDATE coordination_synopses SET window_start=1 WHERE id=?').run(id),/immutable/);
 assert.throws(()=>db.prepare('UPDATE coordination_synopses SET content=? WHERE id=?').run('new version',id),/immutable/);
});
test('optional narrative failure and timeout fall back; a late model result cannot create another version',async t=>{
 const f=fixture();reports.configureSynopsisNarrator(async()=>{throw new Error('Provider offline');});
 const failed=create(f,'manual:offline');const fallback=await complete(f,failed);assert.match(fallback.generationNote,/fallback/);assert.ok(fallback.artifactId);
 let finish:(text:string)=>void=()=>{};let aborted=false;
 reports.configureSynopsisNarrator(({signal})=>{signal.addEventListener('abort',()=>{aborted=true;});return new Promise(resolve=>{finish=resolve;});});
 const id=create(f,'manual:timeout');t.mock.timers.enable({apis:['setTimeout']});
 const pending=reports.materializeSynopsis(f.userId,id);await Promise.resolve();t.mock.timers.tick(120000);await pending;t.mock.timers.reset();
 await reports.dispatchSynopsis(f.userId,id);const before=reports.getSynopsis(f.userId,id);assert.equal(aborted,true);assert.match(before.generationNote,/fallback/);
 finish('Late version must never be delivered');await Promise.resolve();await Promise.resolve();
 const after=reports.getSynopsis(f.userId,id);assert.equal(after.sha256,before.sha256);assert.equal(after.artifactId,before.artifactId);assert.equal(after.delivery!.attempts.length,1);assert.doesNotMatch(after.content!,/Late version/);reports.configureSynopsisNarrator();
});
test('unknown delivery blocks only delivery cursor; later materialization and delivery are independent',async()=>{
 const f=fixture(),first=create(f,'manual:unknown',Date.now()-10000);await complete(f,first);
 let a=reports.getSynopsis(f.userId,first);const d=a.delivery!;
 db.prepare("UPDATE artifact_delivery_attempts SET status='unknown',external_id=NULL WHERE delivery_id=?").run(d.id);
 db.prepare("UPDATE artifact_deliveries SET status='unknown' WHERE id=?").run(d.id);
 db.prepare('UPDATE coordination_synopses SET delivered_at=NULL WHERE id=?').run(first);
 db.prepare('UPDATE coordination_report_cursors SET delivered_through=0,delivered_seq=0 WHERE user_id=?').run(f.userId);
 publishNativeEvent({userId:f.userId,kind:'test.observation',sourceType:'test',sourceId:'later'});
 const later=create(f,'manual:later');await complete(f,later);assert.ok(cursor(f).materialized_through>0);assert.equal(cursor(f).delivered_through,0);
 await reports.dispatchSynopsis(f.userId,first);await assert.rejects(()=>reports.retrySynopsis(f.userId,first),/Unknown/);assert.equal(delivery.getDelivery(f.userId,d.id).attempts.length,1);
 delivery.reconcileDelivery(f.userId,d.id,{outcome:'delivered',evidence:'Fixture receipt confirms acknowledgement',expectedAttemptId:d.attempts[0].id});
 reports.reconcileReportCoverage();assert.equal(cursor(f).delivered_through,cursor(f).materialized_through);assert.equal(cursor(f).delivered_seq,cursor(f).materialized_seq);
});
test('definitely-unsent retry retains exact bytes, artifact, destination and delivery identity',async()=>{
 const f=fixture(),id=create(f,'manual:retry');await complete(f,id);const before=reports.getSynopsis(f.userId,id);
 db.prepare("UPDATE artifact_deliveries SET status='failed' WHERE id=?").run(before.delivery!.id);
 db.prepare('UPDATE coordination_synopses SET delivered_at=NULL WHERE id=?').run(id);
 await reports.dispatchSynopsis(f.userId,id);assert.equal(reports.getSynopsis(f.userId,id).delivery!.status,'failed');
 await reports.retrySynopsis(f.userId,id);const after=reports.getSynopsis(f.userId,id);
 assert.equal(after.sha256,before.sha256);assert.equal(after.artifactId,before.artifactId);assert.equal(after.delivery!.id,before.delivery!.id);assert.equal(after.delivery!.attempts.length,2);
 assert.deepEqual(after.destination,before.destination);
});
test('storage failure between freeze and artifact linkage recovers original bytes without a new report',async()=>{
 const f=fixture(),id=create(f,'manual:storage');await materialize(f,id);const before=reports.getSynopsis(f.userId,id);
 const directory=path.join(storage,'files',f.bot.id),moved=directory+'-held';fs.renameSync(directory,moved);fs.writeFileSync(directory,'storage fault');
 await assert.rejects(()=>reports.dispatchSynopsis(f.userId,id));assert.equal(reports.getSynopsis(f.userId,id).artifactId,null);
 fs.unlinkSync(directory);fs.renameSync(moved,directory);await reports.dispatchSynopsis(f.userId,id);
 const after=reports.getSynopsis(f.userId,id);assert.equal(after.sha256,before.sha256);assert.equal(after.delivery!.status,'delivered');assert.equal(count(f),1);
});
test('fresh process recovers frozen content after loss before dispatch; no model availability needed',()=>{
 const f=fixture(),id=create(f,'manual:restart');
 const child=(program:string)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
 const first=child(`const r=await import('./server/src/coordination/reports.ts');await r.materializeSynopsis(${JSON.stringify(f.userId)},${JSON.stringify(id)});(await import('./server/src/db.ts')).db.close();`);assert.equal(first.status,0,first.stderr);
 const before=reports.getSynopsis(f.userId,id);assert.equal(before.artifactId,null);assert.ok(before.sha256);
 const next=child(`const r=await import('./server/src/coordination/reports.ts');await r.resumeSynopses();(await import('./server/src/db.ts')).db.close();`);assert.equal(next.status,0,next.stderr);
 const after=reports.getSynopsis(f.userId,id);assert.equal(after.sha256,before.sha256);assert.equal(after.delivery!.status,'delivered');assert.equal(after.delivery!.attempts.length,1);
});
test('lost narrative owner recovers with frozen sources after its deadline',async()=>{
 const f=fixture(),id=create(f,'manual:lost');const before=reports.reportSourcePage(f.userId,id);
 db.prepare('UPDATE coordination_synopses SET generation_owner=-1,generation_birth=? WHERE id=?').run('dead-process',id);
 await reports.materializeSynopsis(f.userId,id,Date.now()+120001);await reports.dispatchSynopsis(f.userId,id);
 const r=reports.getSynopsis(f.userId,id);assert.match(r.generationNote,/interrupted|elapsed/);assert.deepEqual(reports.reportSourcePage(f.userId,id),before);
});
test('disabled schedules hold unsent materializations and resume does not silently enable them',async()=>{
 const f=fixture();schedule(f,'2026-11-01T08:00:00Z');const id=create(f,'2026-11-01 09:00');await materialize(f,id);
 p.setCheckins(f.userId,{enabled:false});await reports.resumeSynopses();assert.equal(reports.getSynopsis(f.userId,id).artifactId,null);
 assert.equal(p.getCheckins(f.userId).enabled,false);assert.equal(reports.getSynopsis(f.userId,id).status,'ready');
});
test('saved report or source-page corruption cannot advance delivery coverage',async()=>{
 const f=fixture(),id=create(f,'manual:integrity');await materialize(f,id);const r=reports.getSynopsis(f.userId,id),page=(r.pages[0] as any).artifactId;
 const file=artifactPath(f,page),original=fs.readFileSync(file);fs.chmodSync(file,0o600);fs.writeFileSync(file,'corrupt page');
 await reports.dispatchSynopsis(f.userId,id);assert.equal(cursor(f).delivered_through,0);
 fs.writeFileSync(file,original);reports.reconcileSynopsisReceipts();assert.ok(cursor(f).delivered_through>0);
});
test('authenticated settings/report routes enforce ownership, validation, idempotency and source pagination',async()=>{
 const f=fixture(),other=fixture(),token='synopsis-session-'+seq;
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,f.userId,Date.now(),Date.now()+60000);
 const headers={'cookie':`swarm_session=${token}`,'Content-Type':'application/json','Idempotency-Key':'report-button-request'};
 assert.equal((await app.request('/api/checkins/reports')).status,401);
 assert.equal((await app.request('/api/checkins',{method:'PUT',headers,body:JSON.stringify({enabled:'true',channel:'sms'})})).status,400);
 const first=await app.request('/api/checkins/now',{method:'POST',headers});assert.equal(first.status,202);const {reportId}=await first.json() as any;await p.settleProactive();
 const repeat=await app.request('/api/checkins/now',{method:'POST',headers});assert.equal((await repeat.json() as any).reportId,reportId);await p.settleProactive();assert.equal(count(f),1);
 assert.equal((await app.request('/api/checkins/reports?limit=nan',{headers})).status,400);
 const foreign=create(other,'manual:foreign');assert.equal((await app.request(`/api/checkins/reports/${foreign}`,{headers})).status,404);
 const sources=await app.request(`/api/checkins/reports/${reportId}/sources?limit=1`,{headers});assert.equal(sources.status,200);assert.ok(Array.isArray((await sources.json() as any).sources));
 const list=await app.request('/api/checkins/reports?limit=1',{headers});assert.equal(list.status,200);assert.equal((await list.json() as any).reports.length,1);
});

test('concurrent dispatch and loss between delivery creation and linkage reuse one receipt',async()=>{
 const f=fixture(),id=create(f,'manual:dispatch-race');await materialize(f,id);
 await Promise.all([reports.dispatchSynopsis(f.userId,id),reports.dispatchSynopsis(f.userId,id)]);
 const before=reports.getSynopsis(f.userId,id);assert.equal(before.delivery!.attempts.length,1);
 db.prepare('UPDATE coordination_synopses SET delivery_id=NULL WHERE id=?').run(id);
 await reports.dispatchSynopsis(f.userId,id);const after=reports.getSynopsis(f.userId,id);
 assert.equal(after.delivery!.id,before.delivery!.id);assert.equal(after.artifactId,before.artifactId);assert.equal(after.delivery!.attempts.length,1);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM artifact_deliveries WHERE user_id=?').get(f.userId) as any).n,1);
});
test('a live narrative does not block another user and disable during generation holds its send',async()=>{
 const slow=fixture(),healthy=fixture();schedule(slow,'2026-11-18T08:00:00Z');
 let resolveSlow:(text:string)=>void=()=>{};
 reports.configureSynopsisNarrator(({report})=>report.slotKey==='slow-scheduled'?new Promise(resolve=>{resolveSlow=resolve;}):Promise.resolve('Canonical observations follow.'));
 const id=create(slow,'slow-scheduled'),pending=reports.materializeSynopsis(slow.userId,id);await Promise.resolve();
 const other=create(healthy,'manual:healthy');const delivered=await complete(healthy,other);assert.equal(delivered.delivery!.status,'delivered');
 p.setCheckins(slow.userId,{enabled:false});resolveSlow('Optional narrative for held report.');await pending;await reports.dispatchSynopsis(slow.userId,id);
 assert.equal(reports.getSynopsis(slow.userId,id).artifactId,null);assert.equal(reports.getSynopsis(slow.userId,id).status,'ready');reports.configureSynopsisNarrator();
});
test('a user artifact with a synopsis-like filename is still reported',async()=>{
 const f=fixture();const a=artifacts.recordArtifact({userId:f.userId,botId:f.bot.id,filename:'quinn-synopsis-user-research.md',content:'User research output'});
 const id=create(f,'manual:user-filename'),r=await complete(f,id);assert.match(r.content!,new RegExp(a.id));assert.match(r.content!,/User research|user-research/);
});
test('a lost delivery owner becomes unknown and recovery never attempts another send',async()=>{
 const f=fixture(),id=create(f,'manual:lost-send');await complete(f,id);const before=reports.getSynopsis(f.userId,id),d=before.delivery!;
 db.prepare("UPDATE artifact_deliveries SET status='sending' WHERE id=?").run(d.id);
 db.prepare("UPDATE artifact_delivery_attempts SET status='sending',owner_pid=99999999,owner_birth='lost',finished_at=NULL WHERE delivery_id=?").run(d.id);
 db.prepare('UPDATE coordination_synopses SET delivered_at=NULL WHERE id=?').run(id);
 db.prepare('UPDATE coordination_report_cursors SET delivered_through=0,delivered_seq=0 WHERE user_id=?').run(f.userId);
 assert.ok(delivery.recoverDeliveries()>0);await reports.resumeSynopses();
 const after=reports.getSynopsis(f.userId,id);assert.equal(after.delivery!.status,'unknown');assert.equal(after.delivery!.attempts.length,1);assert.equal(after.sha256,before.sha256);assert.equal(cursor(f).delivered_through,0);
});

test('terminal direct jobs inside the window are execution outcomes, with no implied acceptance',async()=>{
 const f=fixture(),at=Date.now();
 const insert=db.prepare('INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at,finished_at) VALUES(?,?,?,?,?,?,?)');
 insert.run('completed-direct-'+seq,f.userId,f.bot.id,JSON.stringify({type:'user',text:'Private request not copied to report'}),'completed',at-1000,at);
 insert.run('cancelled-direct-'+seq,f.userId,f.bot.id,JSON.stringify({type:'system',text:'Private cancelled work'}),'cancelled',at-1000,at);
 const id=create(f,'manual:direct-jobs',at+1),r=await complete(f,id);
 assert.match(r.content!,/Execution outcomes \(not acceptance\)/);assert.match(r.content!,/completed-direct-/);assert.match(r.content!,/cancelled-direct-/);assert.match(r.content!,/not inferred from execution status/);
 assert.doesNotMatch(r.content!,/Private request|Private cancelled/);
 // After a subsequent materialization boundary, old terminal jobs need not repeat.
 const next=create(f,'manual:direct-jobs-next',at+2);assert.ok(!reports.reportSourcePage(f.userId,next).sources.some(s=>s.kind==='job'));
});
test('deleting an account with immutable synopsis pages preserves normal cascade cleanup',async()=>{
 const f=fixture(),id=create(f,'manual:delete-owner');await complete(f,id);
 assert.doesNotThrow(()=>db.prepare('DELETE FROM users WHERE id=?').run(f.userId));
 assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_synopses WHERE user_id=?').get(f.userId) as any).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM coordination_synopsis_sources WHERE user_id=?').get(f.userId) as any).n,0);
});

test('legacy schedule upgrades respect last admission and preference-only edits preserve times',async()=>{
 const f=fixture();p.getCheckins(f.userId);
 db.prepare('INSERT INTO proactivity(user_id,enabled,times,timezone,last_fired,updated_at) VALUES(?,1,?,?,?,?)').run(f.userId,JSON.stringify(['16:30','09:00']),'UTC','2026-11-17 16:30',at('2026-10-01T00:00:00Z'));
 db.prepare("INSERT INTO proactive_due_slots(user_id,slot_key,status,created_at) VALUES(?,?,'admitted',?)").run(f.userId,'2026-11-17 16:30',at('2026-11-17T16:30:00Z'));
 const prefs=p.setCheckins(f.userId,{quietHours:[]},at('2026-11-18T08:00:00Z'));assert.deepEqual(prefs.times,['16:30','09:00']);
 await tick('2026-11-18T10:00:00Z');assert.equal(count(f),1);assert.equal(rows(f)[0].slot_count,1);assert.equal(rows(f)[0].first_slot,'2026-11-18 09:00');p.setCheckins(f.userId,{enabled:false});
});

test('synopsis freezes pending human-review metadata without raw source text or foreign/history counts',async()=>{
 const f=fixture(),other=fixture();
 appendRow(f.bot.id,'message',{type:'message',role:'user',text:'CONFIDENTIAL_SOURCE_ALPHA supplied only in the conversation.'});
 appendRow(f.bot.id,'message',{type:'message',role:'user',text:'CONFIDENTIAL_SOURCE_BETA supplied only in the conversation.'});
 appendRow(other.bot.id,'message',{type:'message',role:'user',text:'FOREIGN_SOURCE_MUST_NOT_APPEAR'});
 publishNativeEvent({userId:f.userId,botId:f.bot.id,kind:'coordination.human_history',sourceType:'message',sourceId:'historical-context',data:{}});
 const id=create(f,'manual:pending-human'),r=await complete(f,id);assert.ok(r.gaps.some((g:string)=>g.startsWith('2 human conversation source revision(s) await Quinn review')));
 assert.doesNotMatch(r.content!,/CONFIDENTIAL_SOURCE|FOREIGN_SOURCE/);assert.doesNotMatch(JSON.stringify(reports.reportSourcePage(f.userId,id)),/CONFIDENTIAL_SOURCE|FOREIGN_SOURCE/);
 const latest=(db.prepare("SELECT MAX(seq) seq FROM native_events WHERE user_id=? AND kind='coordination.human_source'").get(f.userId) as any).seq;
 db.prepare("INSERT INTO native_consumer_cursors(user_id,consumer,seq,updated_at) VALUES(?,'coordination-human-reviewed',?,?)").run(f.userId,latest,Date.now());
 const next=create(f,'manual:pending-human-reviewed');const after=await complete(f,next);
 assert.ok(!after.gaps.some((g:string)=>g.includes('await Quinn review')));assert.ok(reports.getSynopsis(f.userId,id).gaps.some((g:string)=>g.startsWith('2 human conversation')));
});
