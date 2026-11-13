import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { holdLegacyDatabase, assertLegacyDatabaseFences, registerLegacyFenceFunctions, legacyAccountHeld, legacyWritableRows } from '../server/src/platform/legacy-database-fence.js';
import { LegacyActivityGate } from '../server/src/security/legacy-activity.js';
const a='usr_aaaaaaaa',b='usr_bbbbbbbb',operation='migration-operation-111';
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-source-fence-')),file=path.join(root,'source.db');
 const db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,phone TEXT);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),parent_bot_id TEXT,members TEXT);
 CREATE TABLE rows(bot_id TEXT REFERENCES bots(id),body TEXT);CREATE TABLE private_keys(user_id TEXT,secret TEXT);
 CREATE TABLE history(id INTEGER PRIMARY KEY,user_id TEXT,slug TEXT);CREATE UNIQUE INDEX history_slug ON history(slug COLLATE NOCASE);
 CREATE TABLE messaging_inbox(id TEXT PRIMARY KEY,source TEXT,payload TEXT,status TEXT);
 CREATE TABLE messaging_greeted(phone TEXT PRIMARY KEY);
 CREATE TABLE provider_connections(user_id TEXT REFERENCES users(id),secret TEXT);
 CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
 CREATE TABLE native_attempts(id TEXT PRIMARY KEY,link_session TEXT REFERENCES auth_sessions(token));
 INSERT INTO users VALUES('${a}','a@example.test','15551111111'),('${b}','b@example.test','15552222222');
 INSERT INTO bots VALUES('bot_a','${a}',NULL,NULL),('hidden_a','${a}','bot_a',NULL),('room_a','${a}',NULL,'["bot_a","hidden_a"]'),('bot_b','${b}',NULL,NULL);
 INSERT INTO rows VALUES('bot_a','a-private'),('bot_b','b-private');
 INSERT INTO history VALUES(1,'${a}','Alpha'),(2,'${b}','Beta');
 INSERT INTO auth_sessions VALUES('a-session','${a}'),('b-session','${b}');
 INSERT INTO native_attempts VALUES('native-a','a-session'),('native-b','b-session');`);
 const other=new Database(file);other.pragma('foreign_keys=ON');other.pragma('recursive_triggers=OFF');registerLegacyFenceFunctions(other);
 t.after(()=>{other.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
 return {db,other,file};
}
const event=(phone:string)=>JSON.stringify({event_type:'imessage.received',data:{message:{id:'message',remote_number:phone,content:'hello'}}});

test('activity accounting permits parallel work and drains only the held owner',async t=>{
 const {db}=fixture(t),gate=new LegacyActivityGate(db);const releases:(()=>void)[]=[];
 const tasks=Array.from({length:20},()=>gate.run(a,()=>new Promise<void>(done=>releases.push(done))));
 assert.equal(releases.length,20);assert.equal(gate.count(a),20);
 let otherRelease!:()=>void;const other=gate.run(b,()=>new Promise<void>(done=>{otherRelease=done;}));
 holdLegacyDatabase(db,a,operation,'1');let called=false;
 assert.throws(()=>gate.run(a,()=>{called=true;}),/being migrated/);assert.equal(called,false);
 await assert.rejects(gate.drain(a,5),/have not stopped/);assert.equal(legacyAccountHeld(db,a),true);
 const pending=gate.drain(a,1000);for(const release of releases)release();await Promise.all(tasks);
 assert.deepEqual(await pending,{tenant:a,active:0,boundary:'tracked-usage-only'});assert.equal(gate.count(b),1);
 otherRelease();await other;assert.equal(gate.count(b),0);
});

test('activity accounting releases synchronous and rejected work without changing its result',async t=>{
 const {db}=fixture(t),gate=new LegacyActivityGate(db);
 assert.equal(gate.run(a,()=>42),42);assert.equal(gate.count(a),0);
 assert.throws(()=>gate.run(a,()=>{throw new Error('sync error');}),/sync error/);assert.equal(gate.count(a),0);
 await assert.rejects(gate.run(a,async()=>{throw new Error('async error');}),/async error/);assert.equal(gate.count(a),0);
 await assert.rejects(gate.drain(a),/durable account hold/);
});

test('database hold is durable across connections and blocks late writes without serializing another owner',t=>{
 const {db,other,file}=fixture(t);
 const pending=other.prepare('INSERT INTO rows VALUES(?,?)');
 const receipt=holdLegacyDatabase(db,a,operation,'1');
 assert.equal(receipt.boundary,'database-only');assert.ok(!('filesFrozen' in receipt));
 assert.equal(legacyAccountHeld(other,a),true);assert.equal(legacyAccountHeld(other,b),false);
 assert.throws(()=>pending.run('bot_a','late'),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE users SET email=? WHERE id=?').run('changed',a),/migration_hold/);
 assert.throws(()=>other.prepare('DELETE FROM users WHERE id=?').run(a),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE rows SET bot_id=? WHERE bot_id=?').run('bot_b','bot_a'),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE rows SET bot_id=? WHERE bot_id=?').run('bot_a','bot_b'),/migration_hold/);
 pending.run('bot_b','allowed');other.prepare('UPDATE users SET email=? WHERE id=?').run('changed@example.test',b);
 const reopened=new Database(file);try{assertLegacyDatabaseFences(reopened);assert.throws(()=>reopened.prepare('INSERT INTO private_keys VALUES(?,?)').run(a,'late-key'),/migration_hold/);}finally{reopened.close();}
 assert.equal((db.prepare('SELECT count(*) n FROM rows WHERE bot_id=?').get('bot_b') as any).n,2);
});

test('implicit hidden-bot, room, phone and nested OAuth relationships cannot bypass the hold',t=>{
 const {db,other}=fixture(t);holdLegacyDatabase(db,a,operation,'1');
 for(const bot of ['hidden_a','room_a'])assert.throws(()=>other.prepare('INSERT INTO rows VALUES(?,?)').run(bot,'late'),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE bots SET parent_bot_id=? WHERE id=?').run('bot_a','bot_b'),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE bots SET members=? WHERE id=?').run('["bot_a"]','bot_b'),/migration_hold/);
 assert.throws(()=>other.prepare('INSERT INTO messaging_greeted VALUES(?)').run('15551111111'),/migration_hold/);
 assert.throws(()=>other.prepare('INSERT INTO messaging_inbox VALUES(?,?,?,?)').run('a','inkbox',event('+1 (555) 111-1111'),'pending'),/migration_hold/);
 assert.throws(()=>other.prepare('UPDATE native_attempts SET link_session=? WHERE id=?').run('a-session','native-b'),/migration_hold/);
 assert.throws(()=>other.prepare('DELETE FROM native_attempts WHERE id=?').run('native-a'),/migration_hold/);
 other.prepare('INSERT INTO messaging_inbox VALUES(?,?,?,?)').run('b','inkbox',event('15552222222'),'pending');
 other.prepare('DELETE FROM native_attempts WHERE id=?').run('native-b');
});

test('REPLACE and UPSERT cannot delete a held owner through rowid, unique values or index collation',t=>{
 const {db,other}=fixture(t);holdLegacyDatabase(db,a,operation,'1');
 for(const sql of [
  `INSERT OR REPLACE INTO users VALUES('${b}','a@example.test',NULL)`,
  `UPDATE OR REPLACE users SET email='a@example.test' WHERE id='${b}'`,
  `INSERT OR REPLACE INTO history VALUES(1,'${b}','new')`,
  `INSERT OR REPLACE INTO history VALUES(3,'${b}','aLPHa')`,
  `UPDATE OR REPLACE history SET slug='aLPHa' WHERE id=2`,
  `INSERT INTO history VALUES(3,'${b}','Alpha') ON CONFLICT DO UPDATE SET user_id=excluded.user_id`,
  `INSERT OR REPLACE INTO rows(rowid,bot_id,body) VALUES(1,'bot_b','replace-a')`,
 ])assert.throws(()=>other.exec(sql),/migration_hold/,sql);
 assert.equal((other.prepare('SELECT user_id FROM history WHERE id=1').get() as any).user_id,a);
 other.exec(`INSERT OR REPLACE INTO history VALUES(2,'${b}','Beta-two')`);
});

test('stale, foreign and replayed fences cannot reassign the migration',t=>{
 const {db}=fixture(t);const first=holdLegacyDatabase(db,a,operation,'2');
 assert.deepEqual(holdLegacyDatabase(db,a,operation,'2'),first);
 assert.equal(holdLegacyDatabase(db,a,operation,'3').fence,'3');
 assert.throws(()=>holdLegacyDatabase(db,a,operation,'2'),/superseded/);
 assert.throws(()=>holdLegacyDatabase(db,a,'different-migration-op','4'),/superseded/);
 for(const value of ['0','-1','1.5','9223372036854775808'])assert.throws(()=>holdLegacyDatabase(db,a,operation,value),/Invalid/);
 assert.equal(holdLegacyDatabase(db,b,'migration-operation-222','1').tenant,b);
});

test('missing triggers and schema drift stop startup instead of silently repairing the barrier',t=>{
 const {db}=fixture(t);holdLegacyDatabase(db,a,operation,'1');assertLegacyDatabaseFences(db);
 db.exec('CREATE INDEX unexpected_index ON rows(body)');
 assert.throws(()=>assertLegacyDatabaseFences(db),/schema changed/);
 assert.throws(()=>holdLegacyDatabase(db,b,'migration-operation-222','1'),/schema changed/);
 db.exec('DROP INDEX unexpected_index');assertLegacyDatabaseFences(db);
 const name=(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1").get() as any).name;
 db.exec(`DROP TRIGGER "${name}"`);
 assert.throws(()=>assertLegacyDatabaseFences(db),/missing or changed/);
 assert.throws(()=>holdLegacyDatabase(db,a,operation,'2'),/missing or changed/);
});

test('unmapped extension schemas are refused atomically, even when currently empty',t=>{
 const {db}=fixture(t);db.exec('CREATE TABLE unknown_extension(payload TEXT)');
 assert.throws(()=>holdLegacyDatabase(db,a,operation,'1'),/ownership mapping/);
 assert.equal(legacyAccountHeld(db,a),false);
 assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get() as any).n,0);
 db.exec('DROP TABLE unknown_extension; CREATE UNIQUE INDEX expression_index ON users(lower(email))');
 assert.throws(()=>holdLegacyDatabase(db,a,operation,'1'),/expression unique indexes/);
 assert.equal(legacyAccountHeld(db,a),false);
});

test('unknown virtual tables and spoofed native derived schemas fail closed before installing a hold',t=>{
 const {db}=fixture(t);
 for(const [sql,pattern] of [
  ['CREATE VIRTUAL TABLE unknown_search USING fts5(text,bot_id UNINDEXED)',/virtual tables/],
  ['CREATE VIRTUAL TABLE knowledge_messages_fts USING fts5(text,bot_id UNINDEXED)',/derived search schema/],
  ['CREATE TABLE knowledge_migrations(name TEXT PRIMARY KEY)',/derived search schema/],
 ] as const){
  db.exec(sql);assert.throws(()=>holdLegacyDatabase(db,a,operation,'1'),pattern);
  assert.equal(legacyAccountHeld(db,a),false);
  assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get() as any).n,0);
  db.exec(`DROP TABLE ${sql.split(' ')[sql.includes('VIRTUAL')?3:2].split('(')[0]}`);
 }
});

test('the current application schema can hold one account and refuses its existing sessions',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-source-app-fence-'));
 Object.assign(process.env,{DB_PATH:path.join(root,'app.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'legacy-fence-tests-only',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',SWARM_NO_SCHEDULER:'1'});
 const {db}=await import('../server/src/db.js');
 await import('../server/src/routes.js');await import('../server/src/routes-config.js');
 await import('../server/src/mcp/oauth.js');await import('../server/src/provisioning.js');
 const {initRooms}=await import('../server/src/agent/rooms.js');initRooms();
 const {initSubagents}=await import('../server/src/agent/subagents.js');initSubagents();
 const {createBot}=await import('../server/src/bots.js');
 const {userFromToken}=await import('../server/src/lib/auth.js');
 const {exportTenantDatabase}=await import('../server/src/platform/migration.js');
 const {createSkill}=await import('../server/src/knowledge/skills.js');
 const {searchMessages}=await import('../server/src/knowledge/sessions.js');
 const {createGoal}=await import('../server/src/agent/goals.js');
 const {createWorkflow}=await import('../server/src/agent/workflows.js');
 const {acceptJob}=await import('../server/src/agent/jobs.js');
 await import('../server/src/deliverables/index.js');await import('../server/src/agent/programs.js');
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 for(const owner of [a,b]){
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(owner,owner+'@example.test',owner,Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(owner,owner,Date.now(),Date.now()+60000);
 }
 const owned=createBot(a,{name:'Migrating',isPrimary:true}),other=createBot(b,{name:'Active',isPrimary:true});
 const message=(botId:string,seq:number,text:string)=>db.prepare("INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,'message',?,1)")
  .run(botId,seq,seq,JSON.stringify({type:'message',role:'assistant',text}));
 message(owned.id,100,'heldsearch private source');message(other.id,100,'unheldsearch private source');
 type Seed={job:string;task:string;skill:string;rows:{table:string;key:string;value:string|number;field:string}[]};
 function seed(userId:string,botId:string):Seed{
  const rows:Seed['rows']=[];
  const add=(table:string,values:Record<string,string|number|null>,key:string,field=key)=>{
   const columns=Object.keys(values);db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(values));
   rows.push({table,key,value:values[key]!,field});
  };
  const job=acceptJob(botId,{type:'user',text:'native fence fixture'}).id;
  const goal=createGoal(userId,botId,{title:'Fence goal',criteria:[{description:'Verified',kind:'result'}]});
  rows.push({table:'native_goals',key:'id',value:goal.id,field:'reason'});
  const workflow=createWorkflow(userId,botId,{title:'Fence workflow',goalId:goal.id,tasks:[
   {key:'first',title:'First',instructions:'Verify',criteria:[{description:'Verified',kind:'result'}]},
   {key:'next',title:'Next',instructions:'Verify',parentKey:'first',dependsOn:['first'],criteria:[{description:'Verified',kind:'result'}]},
  ]});
  rows.push({table:'native_workflows',key:'id',value:workflow.id,field:'reason'},
   {table:'native_workflow_tasks',key:'task_id',value:workflow.tasks[0].id,field:'reason'},
   {table:'native_workflow_edges',key:'task_id',value:workflow.tasks[1].id,field:'task_id'});
  add('native_goal_turns',{job_id:job,goal_id:goal.id,bot_id:botId,status:'running',created_at:1},'job_id','status');
  add('native_workflow_runs',{job_id:job,workflow_id:workflow.id,task_id:workflow.tasks[0].id,goal_id:goal.id,bot_id:botId,status:'running',created_at:1},'job_id','status');
  add('native_workflow_delegations',{task_id:workflow.tasks[1].id,parent_bot_id:botId,child_bot_id:botId,parent_task_id:workflow.tasks[0].id,created_at:1},'task_id','created_at');
  const skill=createSkill(userId,botId,{name:'Fence skill',description:'',body:'Preserve history'});
  add('knowledge_skill_proposals',{id:`proposal-${userId}`,bot_id:botId,skill_id:skill.id,base_revision:1,generation:1,snapshot:'{}',reason:'test',evidence:'[]',created_at:1},'id','reason');
  add('knowledge_memory_suppressions',{bot_id:botId,fingerprint:userId,text:'suppressed',evidence:'[]',created_at:1},'bot_id','text');
  add('memories',{id:`memory-${userId}`,bot_id:botId,text:'fact',created_at:1},'id','text');
  add('knowledge_memory_events',{id:userId===a?100:200,memory_id:`memory-${userId}`,bot_id:botId,action:'create',snapshot:'{}',actor:userId,created_at:1},'id','snapshot');
  add('code_runs',{id:`code-${userId}`,user_id:userId,bot_id:botId,job_id:job,binding:'hash',state:'running',created_at:1,updated_at:1},'id','updated_at');
  add('code_steps',{run_id:`code-${userId}`,step:0,call_id:`call-${userId}`,tool:'read',binding:'hash',state:'dispatching'},'run_id','state');
  add('routine_executions',{id:`routine-${userId}`,user_id:userId,bot_id:botId,routine_id:`routine-${userId}`,routine_name:'Report',fire_key:'scheduled:1',kind:'schedule',job_id:job,status:'running',created_at:1},'id','status');
  add('routine_execution_jobs',{job_id:job,run_id:`routine-${userId}`},'job_id','run_id');
  add('output_artifacts',{id:`artifact-${userId}`,user_id:userId,bot_id:botId,run_id:`routine-${userId}`,job_id:job,filename:'report.txt',mime_type:'text/plain',size:0,sha256:'hash',source_key:'one',created_at:1},'id','filename');
  add('artifact_deliveries',{id:`delivery-${userId}`,user_id:userId,artifact_id:`artifact-${userId}`,channel:'library',target_json:'{}',status:'pending',created_at:1,updated_at:1},'id','updated_at');
  add('artifact_delivery_attempts',{id:`attempt-${userId}`,delivery_id:`delivery-${userId}`,number:1,status:'sending',started_at:1,owner_pid:1,owner_birth:'fixture'},'id','status');
  return {job,task:workflow.tasks[0].id,skill:skill.id,rows};
 }
 const held=seed(a,owned.id),active=seed(b,other.id);
 await t.test('native index recognition requires exact maintenance triggers and rejects unknown extensions',async()=>{
  const snapshot=path.join(root,'derived-probe.db');await db.backup(snapshot);
  let sequence=0;const copy=()=>{const file=path.join(root,`derived-probe-${++sequence}.db`);fs.copyFileSync(snapshot,file);return new Database(file);};
  const clone=copy();try{
   clone.exec('DROP TRIGGER knowledge_messages_delete');
   assert.throws(()=>holdLegacyDatabase(clone,a,operation,'1'),/derived search schema/);
   assert.equal(legacyAccountHeld(clone,a),false);
  }finally{clone.close();}
  for(const ddl of ['CREATE VIRTUAL TABLE extra_fts USING fts5(text)',
   'CREATE TABLE knowledge_messages_fts_unreviewed(payload TEXT)']){
   const clone=copy();try{clone.exec(ddl);
    assert.throws(()=>holdLegacyDatabase(clone,a,operation,'1'),/virtual tables|ownership mapping/);
    assert.equal(legacyAccountHeld(clone,a),false);
   }finally{clone.close();}
  }
 });
 assert.equal(userFromToken(a)!.id,a);
 holdLegacyDatabase(db,a,operation,'1');assertLegacyDatabaseFences(db);
 assert.equal(userFromToken(a),null);assert.equal(userFromToken(b)!.id,b);
 assert.throws(()=>db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('late task',owned.id),/migration_hold/);
 db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('other account works',other.id);
 await t.test('held canonical messages stay immutable while another owner updates the shared derived index',()=>{
  assert.throws(()=>message(owned.id,101,'late held message'),/migration_hold/);
  assert.throws(()=>db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=100').run('{}',owned.id),/migration_hold/);
  assert.throws(()=>db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=100').run(owned.id),/migration_hold/);
  assert.throws(()=>db.prepare('UPDATE rows SET bot_id=? WHERE bot_id=? AND seq=100').run(owned.id,other.id),/migration_hold/);
  message(other.id,101,'unheldsearch new report');
  assert.equal(searchMessages(a,owned.id,'heldsearch').messages.length,1);
  assert.equal(searchMessages(b,other.id,'unheldsearch').messages.length,2);
  assert.throws(()=>searchMessages(b,owned.id,'heldsearch'),/Not found/);
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=101').run(JSON.stringify({type:'message',role:'assistant',text:'updatedsearch report'}),other.id);
  assert.equal(searchMessages(b,other.id,'updatedsearch').messages.length,1);
  db.prepare('DELETE FROM rows WHERE bot_id=? AND seq=101').run(other.id);
  assert.equal(searchMessages(b,other.id,'updatedsearch').messages.length,0);
  assert.throws(()=>db.exec("INSERT INTO knowledge_migrations VALUES('unexpected')"),/migration_hold/);
  assert.throws(()=>db.exec("UPDATE knowledge_migrations SET name='changed'"),/migration_hold/);
  assert.throws(()=>db.exec('DELETE FROM knowledge_migrations'),/migration_hold/);
  assert.throws(()=>legacyWritableRows(db,'knowledge_messages_fts_content'),/not legacy housekeeping/);
 });
 await t.test('all native authoritative tables fence direct and nested ownership without blocking the active owner',()=>{
  for(const row of held.rows){
   const update=db.prepare(`UPDATE ${row.table} SET ${row.field}=${row.field} WHERE ${row.key}=?`);
   assert.throws(()=>update.run(row.value),/migration_hold/,row.table);
   assert.equal(update.run(active.rows.find(r=>r.table===row.table)!.value).changes,1,row.table);
  }
  const appendRevision=db.prepare("INSERT INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,created_at) VALUES(?,?,2,'{}','import',?,1)");
  assert.throws(()=>appendRevision.run(held.skill,owned.id,a),/migration_hold/);
  appendRevision.run(active.skill,other.id,b);
  assert.throws(()=>db.prepare('UPDATE native_workflow_tasks SET parent_task_id=? WHERE task_id=?').run(held.task,active.task),/migration_hold/);
  assert.throws(()=>db.prepare('UPDATE native_workflow_tasks SET active_job_id=? WHERE task_id=?').run(held.job,active.task),/migration_hold/);
  assert.throws(()=>db.prepare('UPDATE code_runs SET job_id=? WHERE id=?').run(held.job,`code-${b}`),/migration_hold/);
 });
 const snapshot=path.join(root,'checkpoint.db'),destination=path.join(root,'export.db');
 await db.backup(snapshot);
 await exportTenantDatabase(snapshot,destination,a,'new_volume');
 const exported=new Database(destination);
 try{
  assert.deepEqual(exported.prepare('SELECT id FROM users').all(),[{id:a}]);
  assert.equal((exported.prepare('SELECT count(*) n FROM legacy_owner_fences').get() as any).n,0);
  assert.equal((exported.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'swarm_legacy_fence_%'").get() as any).n,0);
  assert.deepEqual(exported.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_messages_fts%' OR name='knowledge_migrations'").all(),[]);
 }finally{exported.close();}
});
