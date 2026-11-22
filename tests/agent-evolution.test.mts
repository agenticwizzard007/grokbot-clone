import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after,test} from 'node:test';
import {Hono} from 'hono';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-evolution-'));
Object.assign(process.env,{DB_PATH:path.join(root,'test.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'history-fixture-only',SWARM_ROLE:'standalone',COMPUTER_PROVIDER:'local',INKBOX_TUNNEL:'0',COMPOSIO_API_KEY:'',SWARM_NO_SCHEDULER:'1'});
const {db}=await import('../server/src/db.js');
const {evolutionHistory:history,evolutionChange:change}=await import('../server/src/knowledge/evolution.js');
const {installEvolutionHistory}=await import('../server/src/knowledge/evolution-schema.js');
const {createSkill,updateSkill,rollbackSkill,stageSkillProposal,resolveSkillProposal}=await import('../server/src/knowledge/skills.js');
const {saveMemory,correctMemory,forgetMemory,stageMemoryChange,resolveMemoryChange}=await import('../server/src/knowledge/memory.js');
const {appendRow}=await import('../server/src/store.js');
const {saveSetup}=await import('../server/src/bot-setup.js');
const {patchLearningSettings}=await import('../server/src/knowledge/settings.js');
const {learningApi}=await import('../server/src/routes-learning.js');
const app=new Hono().route('/api/learning',learningApi);
let counter=0;
function fixture(){const user='usr_history_user_'+(++counter),bot='history-bot-'+counter;db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run(user,user+'@example.test',user);db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,1,1)').run(bot,user,'Reporter');return{user,bot};}
function evidence(f:ReturnType<typeof fixture>,text='Keep reports brief.') {const row=appendRow(f.bot,'message',{type:'message',role:'user',text});return [{botId:f.bot,generation:1,seq:row.seq}];}
function skills(f:ReturnType<typeof fixture>){return createSkill(f.user,f.bot,{name:'Report',description:'Reporting procedure',body:'Write a report.'});}
const entries=(f:ReturnType<typeof fixture>)=>history(f.user,f.bot,{limit:100}).entries;
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});

test('skill edits and rollback preserve exact before/after resources and monotonic agent entries',()=>{
 const f=fixture(),s=skills(f);updateSkill(f.user,s.id,{body:'Lead with overdue work.',resources:{'templates/report.md':'# Urgent'}},1);rollbackSkill(f.user,s.id,1,2);
 const ledger=entries(f).filter(e=>e.kind==='skill').reverse();assert.deepEqual(ledger.map(e=>e.sourceRevision),['1','2','3']);
 const edit=change(f.user,f.bot,ledger[1].version);assert.equal((edit.before as any).body,'Write a report.');assert.equal((edit.after as any).resources['templates/report.md'],'# Urgent');
 assert.equal(ledger[2].action,'rollback:1');assert.equal((change(f.user,f.bot,ledger[2].version).after as any).body,'Write a report.');
});
test('canonical mutation and its history roll back together',()=>{
 const f=fixture(),s=skills(f),before=entries(f);assert.throws(()=>db.transaction(()=>{updateSkill(f.user,s.id,{body:'Never committed'},1);throw Error('abort fixture');})(),/abort fixture/);
 assert.deepEqual(entries(f),before);assert.equal((db.prepare('SELECT body FROM skills WHERE id=?').get(s.id) as any).body,'Write a report.');
});
test('failure to persist an audit entry prevents the skill mutation from committing',()=>{
 const f=fixture(),s=skills(f),before=entries(f);
 db.exec("CREATE TRIGGER history_fixture_failure BEFORE INSERT ON agent_evolution WHEN NEW.kind='skill' AND NEW.source_revision='2' BEGIN SELECT RAISE(ABORT,'history storage failure'); END;");
 try{assert.throws(()=>updateSkill(f.user,s.id,{body:'Must not commit'},1),/history storage failure/);}finally{db.exec('DROP TRIGGER history_fixture_failure');}
 assert.equal((db.prepare('SELECT body FROM skills WHERE id=?').get(s.id) as any).body,'Write a report.');assert.deepEqual(entries(f),before);
});
test('memory learning, explicit correction and forgetting retain source evidence and previous states',()=>{
 const f=fixture();const original=saveMemory(f.user,f.bot,{text:'Use brief reports.',evidence:evidence(f)}).memory!;
 const updated=correctMemory(f.user,original.id,{expectedRevision:1,text:'Use detailed reports.',evidence:evidence(f,'Use detailed reports instead.')});forgetMemory(f.user,updated.id,updated.revision);
 const log=entries(f).filter(e=>e.kind==='memory');assert.ok(log.some(e=>e.action==='create'));assert.ok(log.some(e=>e.action==='correction'));
 const creation=change(f.user,f.bot,log.find(e=>e.action==='create')!.version);assert.equal(creation.evidence.length,1);assert.equal((creation.after as any).text,'Use brief reports.');
 const originalHistory=JSON.stringify(creation);installEvolutionHistory(db);assert.equal(JSON.stringify(change(f.user,f.bot,creation.version)),originalHistory);
});
test('pending and approved proposals remain distinct from applied skill revisions',()=>{
 const f=fixture(),s=skills(f);const p=stageSkillProposal(f.user,f.bot,{skillId:s.id,expectedRevision:1,content:{name:s.name,description:s.description,body:'Use three bullets.'},reason:'User requested a shorter report',evidence:evidence(f)});
 let list=entries(f);assert.equal(list.filter(e=>e.kind==='skill').length,1);assert.equal(list.find(e=>e.kind==='skill-proposal')!.action,'pending');
 resolveSkillProposal(f.user,p.id,'approve',1);list=entries(f);assert.deepEqual(list.filter(e=>e.kind==='skill-proposal').map(e=>e.action),['approved','pending']);assert.equal(list.filter(e=>e.kind==='skill').length,2);
 assert.equal(change(f.user,f.bot,list.find(e=>e.kind==='skill-proposal'&&e.action==='pending')!.version).reason,'User requested a shorter report');
});
test('resolved and backfilled memory proposals retain their exact original revision',()=>{
 const f=fixture(),original=saveMemory(f.user,f.bot,{text:'Use brief reports.',evidence:evidence(f)}).memory!;
 const p=stageMemoryChange(f.user,f.bot,{action:'replace',memoryId:original.id,expectedRevision:1,text:'Use detailed reports.',evidence:evidence(f,'Use detailed reports instead.')});
 resolveMemoryChange(f.user,p.id,'approve',1);
 const verify=()=>{const proposalEntries=entries(f).filter(e=>e.kind==='memory-proposal'&&e.sourceId===p.id);assert.equal(proposalEntries.length,2);for(const e of proposalEntries){const d=change(f.user,f.bot,e.version);assert.equal((d.before as any).revision,1);assert.equal((d.before as any).status,'active');assert.equal((d.before as any).text,'Use brief reports.');}};
 verify();
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'evolution_%'").all() as {name:string}[])db.exec(`DROP TRIGGER "${name}"`);
 db.exec('DROP TABLE agent_evolution');installEvolutionHistory(db);verify();
});
test('profile, setup and lifecycle changes are preserved without recording unrelated telemetry',()=>{
 const f=fixture();db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Escalate uncertain totals.',f.bot);
 assert.equal((change(f.user,f.bot,entries(f)[0].version).after as any).instructions,'Escalate uncertain totals.');
 saveSetup(f.bot,{purpose:'Reports',responsibilities:['Summarize'],out_of_scope:[],success_criteria:['Accurate'],context_summary:'Reporting role'},{messages:[]});
 const before=entries(f).length;db.prepare('UPDATE bot_setups SET computer_error=? WHERE bot_id=?').run('Computer asleep',f.bot);assert.equal(entries(f).length,before);
 const s=skills(f);db.prepare("UPDATE skills SET lifecycle='suspended' WHERE id=?").run(s.id);assert.equal(entries(f)[0].kind,'skill-lifecycle');
});
test('account settings changes are attributed to every affected agent without crossing account ownership',()=>{
 const f=fixture(),other=fixture();db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,1,1)').run(f.bot+'-second',f.user,'Second');
 patchLearningSettings(f.user,{expectedRevision:0,settings:{enabled:false}});
 for(const bot of [f.bot,f.bot+'-second'])assert.equal(history(f.user,bot).entries[0].kind,'learning-settings');
 assert.equal(entries(other).some(e=>e.kind==='learning-settings'),false);
});
test('pinned pagination survives new changes and returns every entry once',()=>{
 const f=fixture();for(let i=0;i<7;i++)db.prepare('UPDATE bots SET description=? WHERE id=?').run('Revision '+i,f.bot);
 const first=history(f.user,f.bot,{limit:2}),seen=first.entries.map(e=>e.version);let before=first.nextBefore;
 db.prepare('UPDATE bots SET description=? WHERE id=?').run('Newer than pinned history',f.bot);
 while(before!==null){const p=history(f.user,f.bot,{limit:2,through:first.through,before});seen.push(...p.entries.map(e=>e.version));before=p.nextBefore;}
 assert.equal(seen.length,first.through);assert.equal(new Set(seen).size,seen.length);assert.ok(seen.every(v=>v<=first.through));assert.ok(history(f.user,f.bot).latestVersion>first.through);
});
test('history cannot be updated, deleted or replaced, but account erasure works',()=>{
 const f=fixture();skills(f);
 assert.throws(()=>db.prepare('UPDATE agent_evolution SET actor=? WHERE bot_id=?').run('forged',f.bot),/immutable/);
 assert.throws(()=>db.prepare('DELETE FROM agent_evolution WHERE bot_id=?').run(f.bot),/immutable/);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO agent_evolution SELECT * FROM agent_evolution WHERE bot_id=?').run(f.bot),/immutable/);
 db.prepare('DELETE FROM users WHERE id=?').run(f.user);assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_evolution WHERE bot_id=?').get(f.bot) as any).n,0);
});
test('authenticated history APIs reject foreign owners and malformed cursors',async()=>{
 const f=fixture(),other=fixture();const token='history-cookie-'+counter;db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token,f.user,Date.now(),Date.now()+60000);
 const get=(bot:string,suffix='')=>app.request(`/api/learning/bots/${bot}/history${suffix}`,{headers:{cookie:'swarm_session='+token}});
 assert.equal((await get(f.bot)).status,200);assert.equal((await get(other.bot)).status,404);assert.equal((await get(other.bot,'/1')).status,404);
 assert.equal((await get(f.bot,'?before=NaN')).status,400);assert.equal((await get(f.bot,'?through=-1')).status,400);assert.equal((await app.request(`/api/learning/bots/${f.bot}/history`)).status,401);
});
test('restart backfill is idempotent and does not silently change earlier entries',()=>{
 const f=fixture(),s=skills(f);updateSkill(f.user,s.id,{body:'Current revision'},1);const before=entries(f).map(e=>change(f.user,f.bot,e.version));
 installEvolutionHistory(db);installEvolutionHistory(db);assert.deepEqual(entries(f).map(e=>change(f.user,f.bot,e.version)),before);
});

test('migration recovers retained history with correct earlier snapshots and honest legacy baselines',()=>{
 const f=fixture(),s=skills(f);updateSkill(f.user,s.id,{body:'A later procedure'},1);
 // Simulate a volume created before this feature, retaining the actual domain ledgers.
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'evolution_%'").all() as {name:string}[])db.exec(`DROP TRIGGER "${name}"`);
 db.exec('DROP TABLE agent_evolution');
 db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES(?,?,?,1)').run('legacy-memory',f.bot,'Legacy preference with no retained edit log');
 installEvolutionHistory(db);
 const log=entries(f),edit=log.find(e=>e.kind==='skill'&&e.sourceRevision==='2')!;
 assert.equal(edit.origin,'historical');assert.equal((change(f.user,f.bot,edit.version).before as any).body,'Write a report.');
 assert.equal((change(f.user,f.bot,edit.version).after as any).body,'A later procedure');
 assert.equal(log.find(e=>e.kind==='profile')!.origin,'baseline');assert.equal(log.find(e=>e.sourceId==='legacy-memory')!.origin,'baseline');
 const count=log.length;installEvolutionHistory(db);assert.equal(entries(f).length,count);
});

test('migration-held owners remain untouched during history initialization and canonical writes',async()=>{
 const {holdLegacyDatabase,assertLegacyDatabaseFences}=await import('../server/src/platform/legacy-database-fence.js');
 const f=fixture();skills(f);holdLegacyDatabase(db,f.user,'migration:history:12345678','1');assertLegacyDatabaseFences(db);
 const before=entries(f).map(e=>change(f.user,f.bot,e.version));installEvolutionHistory(db);assert.deepEqual(entries(f).map(e=>change(f.user,f.bot,e.version)),before);
 assert.throws(()=>db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Blocked edit',f.bot),/migration_hold/);
 assertLegacyDatabaseFences(db);
});

test('R2F-012: setup and profile changes record the setup revision they belong to',()=>{
 const f=fixture();
 saveSetup(f.bot,{purpose:'Reports',responsibilities:['Summarize'],out_of_scope:[],success_criteria:['Accurate'],context_summary:'Reporting role'},{messages:[]});
 const created=entries(f).find(e=>e.kind==='setup'&&e.action==='created')!;
 assert.equal(created.sourceRevision,'1');
 db.prepare('UPDATE bot_setups SET revision=revision+1,onboarding_status=? WHERE bot_id=?').run('review',f.bot);
 assert.deepEqual([entries(f)[0].kind,entries(f)[0].action,entries(f)[0].sourceRevision],['setup','updated','2']);
 db.prepare('UPDATE bots SET name=? WHERE id=?').run('Reporter Two',f.bot);
 assert.deepEqual([entries(f)[0].kind,entries(f)[0].sourceRevision],['profile','2']);
 // A Bot without a setup has no revision to name.
 const g=fixture();db.prepare('UPDATE bots SET label=? WHERE id=?').run('Ops',g.bot);
 assert.equal(entries(g)[0].kind,'profile');assert.equal(entries(g)[0].sourceRevision,null);
});

test('R2F-012: databases with configuration triggers from before the change also record the revision, idempotently',()=>{
 const f=fixture();
 saveSetup(f.bot,{purpose:'Reports',responsibilities:['Summarize'],out_of_scope:[],success_criteria:['Accurate'],context_summary:'Reporting role'},{messages:[]});
 // Recreate the earlier trigger bodies, which inserted NULL for source_revision.
 for(const name of ['evolution_profile_update','evolution_setup_update']){
  const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}).sql;
  const legacy=sql.replace('(SELECT revision FROM bot_setups WHERE bot_id=NEW.id)','NULL').replace(/NEW\.revision,'updated'/,"NULL,'updated'");
  assert.notEqual(legacy,sql,name);
  db.exec(`DROP TRIGGER ${name}`);db.exec(legacy);
 }
 installEvolutionHistory(db);installEvolutionHistory(db);
 assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='evolution_config_source_revision'").get() as any).n,1);
 const before=entries(f).length;
 db.prepare('UPDATE bot_setups SET revision=revision+1,onboarding_status=? WHERE bot_id=?').run('review',f.bot);
 db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Escalate uncertain totals.',f.bot);
 const log=entries(f);
 assert.equal(log.length,before+2,'each change is recorded exactly once');
 assert.deepEqual(log.slice(0,2).map(e=>[e.kind,e.sourceRevision]),[['profile','2'],['setup','2']]);
 assert.equal((change(f.user,f.bot,log[0].version).after as any).instructions,'Escalate uncertain totals.');
 assert.deepEqual(log.map(e=>e.version),[...log.map(e=>e.version)].sort((a,b)=>b-a),'versions stay monotonic');
});
