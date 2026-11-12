import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after,beforeEach,mock,test} from 'node:test';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-learning-lifecycle-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'test.db'),FILES_DIR:path.join(dir,'files'),SESSION_SECRET:'learning-lifecycle-test-only',SWARM_ROLE:'standalone',NODE_ENV:'test',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',ADMIN_EMAILS:'',ADMIN_PHONES:'',INKBOX_TUNNEL:'0',DIRECT_API_KEY:'test-only',LLM_PROVIDER:'direct'});
mock.method(globalThis,'fetch',async()=>{throw new Error('No external network/sends in learning tests');});
const {db}=await import('../server/src/db.js');await import('../server/src/db-config.js');
const jobs=await import('../server/src/agent/jobs.js');
const learning=await import('../server/src/agent/learning.js');
const settings=await import('../server/src/knowledge/settings.js');
const skills=await import('../server/src/knowledge/skills.js');
const memory=await import('../server/src/knowledge/memory.js');
const access=await import('../server/src/knowledge/access.js');
const sessions=await import('../server/src/knowledge/sessions.js');
const curator=await import('../server/src/knowledge/curator.js');
const {LEARNING_TOOLS}=await import('../server/src/agent/learning-tools.js');
const {KNOWLEDGE_TOOLS}=await import('../server/src/agent/knowledge-tools.js');
for(const id of ['owner','other'])db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id,`${id}@test.invalid`,id,1);
const seed={name:'Research workflow',description:'Research and cite sources',body:'Verify sources before writing.'};
let seq=0;
function message(text:string,role='user',botId='alpha',extra:any={}){const n=++seq;db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,\'message\',?,?)').run(botId,n,n,JSON.stringify({type:'message',role,text,...extra}),Date.now());return sessions.refsOnly(sessions.validateEvidence('owner',botId,[{botId,generation:1,seq:n}]))[0];}
function patch(value:any,botId?:string){const cur=settings.learningSettings('owner',botId);return settings.patchLearningSettings('owner',{botId,expectedRevision:cur.revision,settings:value});}
function turn(overrides:any={}){const j=jobs.acceptJob('alpha',{type:'user',text:'Do research'});jobs.beginJob(j.id);jobs.finishJob(j.id,true);return learning.onLearningTurn({userId:'owner',botId:'alpha',jobId:j.id,triggerType:'user',depth:0,generation:1,model:'grok-test',provider:'direct',finalText:'Research complete',iterations:1,status:'completed',messagesSnapshot:[{role:'user',content:'A frozen task'},{role:'assistant',content:'Research complete'}],...overrides});}
const usage={input_tokens:20,output_tokens:4};
const call=(name:string,args:any,id='call')=>({output:[{type:'function_call',name,call_id:id,arguments:JSON.stringify(args)}],usage});
const final=()=>({output_text:'Nothing else to save.',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Nothing else to save.'}]}],usage});
function management(unattended=true){return{userId:'owner',botId:'alpha',unattended,actor:'background_review',reads:new Map<string,string>()};}
function jobCtx(jobId:string){return{userId:'owner',botId:'alpha',jobId,depth:0,enqueueBotMessage:()=>{throw new Error('No sends');}};}
beforeEach(()=>{db.exec('DELETE FROM bots;DELETE FROM knowledge_learning_settings');seq=0;for(const [id,owner]of[['alpha','owner'],['beta','owner'],['foreign','other']])db.prepare('INSERT INTO bots(id,user_id,name,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,owner,id,'grok-test',1,1);learning.configureLearningModelExecutor(async()=>final());});
after(()=>{learning.configureLearningModelExecutor();mock.restoreAll();db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('upstream defaults, account inheritance, independent revisions and reset-all overrides',()=>{
 const base=settings.learningSettings('owner','alpha');assert.equal(base.settings.skillApproval,false);assert.equal(base.settings.memoryTurnInterval,10);assert.equal(base.settings.maxIterations,16);assert.equal(base.settings.curatorConsolidate,false);
 patch({skillApproval:true,maxInputTokens:500});patch({skillApproval:false,maxInputTokens:200,auxiliaryModel:'custom'},'alpha');assert.equal(settings.learningSettings('owner','alpha').settings.skillApproval,false);assert.equal(settings.learningSettings('owner','beta').settings.skillApproval,true);
 patch({},'alpha');const inherited=settings.learningSettings('owner','alpha');assert.equal(inherited.settings.skillApproval,true);assert.equal(inherited.settings.maxInputTokens,500);assert.equal(inherited.settings.auxiliaryModel,null);assert.deepEqual(inherited.overrides,{});
 assert.throws(()=>settings.patchLearningSettings('owner',{botId:'alpha',expectedRevision:0,settings:{enabled:false}}),/changed/);
});
test('counter triggers persist and reset, callback replay is idempotent, snapshots detach from live history',async()=>{
 message('Always verify every source.');for(let i=0;i<9;i++)turn();assert.equal(learning.listLearningReviews('owner').reviews.length,0);
 const snapshot=[{role:'user',content:'Original frozen evidence'}];const review=turn({messagesSnapshot:snapshot})!;assert.equal(review.reviewMemory,true);assert.equal(review.reviewSkills,true);snapshot[0].content='MUTATED';
 const state=db.prepare('SELECT * FROM knowledge_learning_state WHERE bot_id=\'alpha\'').get()as any;assert.equal(state.memory_turns,0);assert.equal(state.skill_iterations,0);
 let captured:any;learning.configureLearningModelExecutor(async b=>{captured=b;return final();});const result=await learning.runLearningReview(review.id);assert.equal(result?.status,'completed');assert.equal(captured.input[0].content,'Original frozen evidence');assert.equal(JSON.stringify(captured.input).includes('MUTATED'),false);assert.match(captured.input.at(-1).content,/Read-before-write/);
 const parent=db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(review.parentJobId)as any;learning.onLearningTurn({userId:'owner',botId:'alpha',jobId:parent.id,triggerType:'user',depth:0,generation:1,model:'grok-test',finalText:'Done',iterations:100,status:'completed'});assert.equal(learning.listLearningReviews('owner').reviews.length,1);
});
test('finalization exclusions and explicit refinement bypass automatic counters and disabled automatic review',()=>{
 patch({memoryTurnInterval:1,skillIterationInterval:1});
 for(const value of [{status:'waiting'},{status:'interrupted'},{finalText:''},{depth:1},{temporary:true},{oneShot:true},{skipBackgroundReview:true},{triggerType:'routine'},{triggerType:'learning-review'}])turn(value);
 assert.equal(learning.listLearningReviews('owner').reviews.length,0);patch({automaticReview:false,memoryTurnInterval:0,skillIterationInterval:0});assert.equal(turn(),undefined);
 const refine=learning.refineLearning('owner','alpha');assert.equal(refine.reason,'refine');assert.equal(refine.reviewMemory,true);assert.equal(refine.reviewSkills,true);
});
test('multi-step detached reviewer applies guarded skills directly but stages unattended memory replacements',async()=>{
 const evidence=[message('Always verify the original source and prefer concise reports.')];const skill=skills.createSkill('owner','alpha',seed);const mem=memory.saveMemory('owner','alpha',{text:'User prefers lengthy reports.',evidence}).memory!;
 patch({memoryTurnInterval:1,skillIterationInterval:1});const review=turn()!;let n=0;
 learning.configureLearningModelExecutor(async b=>{n++;if(n===1)return call('read_skill',{skill_id:skill.id},'read');if(n===2){assert.equal(b.input.at(-1).type,'function_call_output');return call('manage_skill',{action:'update',skill_id:skill.id,expected_revision:1,name:seed.name,body:'Verify original sources and write concise reports.',reason:'Standing preference',evidence},'write');}if(n===3)return call('manage_memory',{action:'replace',memory_id:mem.id,expected_revision:1,text:'User prefers concise reports.',evidence},'memory');return final();});
 const result=await learning.runLearningReview(review.id);assert.equal(result?.status,'completed');assert.equal(n,4);assert.equal(skills.getSkill('owner',skill.id).revision,2);assert.equal(memory.listMemories('owner','alpha')[0].text,mem.text);assert.equal(memory.listMemoryChanges('owner','alpha')[0].status,'pending');
 assert.equal((db.prepare('SELECT count(*) n FROM knowledge_use_receipts WHERE job_id=? AND kind=\'skill\'').get(review.jobId)as any).n,1);
 assert.equal((db.prepare('SELECT kind FROM usage_events WHERE review_id=? LIMIT 1').get(review.id)as any).kind,'background_review');
 assert.equal((db.prepare('SELECT count(*) n FROM native_context_receipts WHERE job_id=? AND kind=\'skill\'').get(review.jobId)as any).n,1);
});
test('approval-on skill management stages, existing proposals stay pending when approval turns off',async()=>{
 const evidence=[message('Always cite primary sources.')];const skill=skills.createSkill('owner','alpha',seed);patch({skillApproval:true,memoryTurnInterval:1});const review=turn({iterations:10})!;let n=0;
 learning.configureLearningModelExecutor(async()=>++n===1?call('read_skill',{skill_id:skill.id}):n===2?call('manage_skill',{action:'patch',skill_id:skill.id,expected_revision:1,old_text:seed.body,new_text:'Cite primary sources.',reason:'Correction',evidence}):final());
 assert.equal((await learning.runLearningReview(review.id))?.status,'completed');assert.equal(skills.getSkill('owner',skill.id).revision,1);const proposal=skills.listSkillProposals('owner','alpha')[0];assert.equal(proposal.status,'pending');patch({skillApproval:false});assert.equal(skills.listSkillProposals('owner','alpha')[0].status,'pending');
 assert.equal(skills.resolveSkillProposal('owner',proposal.id,'approve',1).skill?.revision,2);
});
test('dispatcher denies business actions and fresh-read guards reject transcript-only or stale reads',async()=>{
 const evidence=[message('Always check sources.')];const skill=skills.createSkill('owner','alpha',seed);patch({memoryTurnInterval:1,skillIterationInterval:1});const review=turn()!;let n=0;
 learning.configureLearningModelExecutor(async b=>{n++;if(n===1)return call('send_email',{to:'nobody@test.invalid'});if(n===2){assert.match(b.input.at(-1).output,/denied/);return call('manage_skill',{action:'update',skill_id:skill.id,expected_revision:1,body:'Unsafe rewrite',reason:'test',evidence});}if(n===3){assert.match(b.input.at(-1).output,/Read the current target/);return final();}throw new Error('Unexpected call');});
 assert.equal((await learning.runLearningReview(review.id))?.status,'completed');assert.equal(skills.getSkill('owner',skill.id).revision,1);
 const ctx=management();access.withManagement(ctx,()=>{skills.readSkillForBot('owner','alpha',skill.id);skills.updateSkill('owner',skill.id,{body:'Owner edit'},1);assert.throws(()=>skills.manageSkill('owner','alpha',{action:'update',skillId:skill.id,expectedRevision:2,body:'Stale read',reason:'test',evidence}),/Read the current target/);});
});
test('foreground cancellation fences in-flight output and stale cleanup leaves newer foreground job intact',async()=>{
 message('Always verify sources.');patch({memoryTurnInterval:1});const review=turn()!;let release!:(v:any)=>void;let entered!:(v?:any)=>void;const started=new Promise(r=>entered=r);
 learning.configureLearningModelExecutor(()=>{entered();return new Promise(r=>release=r);});const pending=learning.runLearningReview(review.id);await started;
 await learning.beforeForegroundTurn('owner','alpha');const foreground=jobs.acceptJob('alpha',{type:'user',text:'New foreground work'});jobs.beginJob(foreground.id);release(final());assert.equal((await pending)?.status,'cancelled');assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(foreground.id)as any).state,'running');
 assert.equal(skills.listSkills('owner','alpha').length,0);
});
test('source edits, settings edits, resets and ownership changes fence publication',async()=>{
 for(const mutation of ['source','settings','generation','owner']){
  // Separate Bots keep each stale attempt independent.
  const evidence=[message('Always preserve original source.')];patch({memoryTurnInterval:1});const review=turn()!;
  learning.configureLearningModelExecutor(async()=>{if(mutation==='source'){db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify({type:'message',role:'user',text:'Changed'}),'alpha',evidence[0].seq);}else if(mutation==='settings')patch({skillApproval:true});else if(mutation==='generation')db.prepare('UPDATE bots SET generation=2 WHERE id=\'alpha\'').run();else db.prepare('UPDATE bots SET user_id=\'other\' WHERE id=\'alpha\'').run();return final();});
  await learning.runLearningReview(review.id);assert.notEqual(learning.listLearningReviews('owner').reviews.find(r=>r.id===review.id)?.status,'completed');
  db.prepare('UPDATE bots SET generation=1,user_id=\'owner\' WHERE id=\'alpha\'').run();
  const current=db.prepare('SELECT status FROM knowledge_learning_reviews WHERE id=?').get(review.id)as any;if(current.status==='running')learning.cancelLearningReview('owner',review.id);
 }
});
test('restart cancels abandoned running reviews without replay; queued intent survives',async()=>{
 message('Always cite sources.');patch({memoryTurnInterval:1});const abandoned=turn()!;db.prepare("UPDATE knowledge_learning_reviews SET status='running',claim='dead-host' WHERE id=?").run(abandoned.id);jobs.beginJob(abandoned.jobId);learning.recoverLearningReviews();assert.equal(learning.listLearningReviews('owner').reviews[0].status,'cancelled');
 const queued=turn()!;learning.recoverLearningReviews();assert.equal(learning.listLearningReviews('owner').reviews[0].status,'queued');assert.equal((await learning.runLearningReview(queued.id))?.status,'completed');
});
test('review limits use upstream context fraction/cap/fallback and stop multi-step work',async()=>{
 assert.equal(learning.reviewInputBudget(settings.LEARNING_DEFAULTS,1000000),600000);assert.equal(learning.reviewInputBudget(settings.LEARNING_DEFAULTS,200000),150000);assert.equal(learning.reviewInputBudget(settings.LEARNING_DEFAULTS,null),120000);assert.equal(learning.reviewInputBudget({...settings.LEARNING_DEFAULTS,maxInputTokens:-1},200000),0);
 message('Always verify.');patch({memoryTurnInterval:1,maxInputTokens:10});const review=turn()!;let calls=0;learning.configureLearningModelExecutor(async()=>{calls++;return call('list_skills',{});});const result=await learning.runLearningReview(review.id);assert.equal(calls,1);assert.equal(result?.status,'cancelled');assert.match(result?.error??'',/input budget/);
});
test('auxiliary routing is explicit, digests only when changed and never falls back across providers',async()=>{
 message('Always verify.');patch({memoryTurnInterval:1,auxiliaryProvider:'openrouter'});const rejected=turn()!;let calls=0;learning.configureLearningModelExecutor(async()=>{calls++;return final();});assert.equal((await learning.runLearningReview(rejected.id))?.status,'cancelled');assert.equal(calls,0);
 patch({auxiliaryProvider:null,auxiliaryModel:'explicit-test-model'});const snapshot=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',content:`Message ${i}`}));const routed=turn({messagesSnapshot:snapshot})!;let body:any;learning.configureLearningModelExecutor(async b=>{body=b;return final();});assert.equal((await learning.runLearningReview(routed.id))?.status,'completed');assert.equal(body.model,'explicit-test-model');assert.match(body.input[0].content,/Earlier conversation digest/);
});
test('full package resources version atomically, exact file read guards, locks, pins and rollback',()=>{
 const evidence=[message('Use the report template.')];const skill=skills.createSkill('owner','alpha',{...seed,resources:{'templates/report.md':'Old template','scripts/check.mjs':'console.log(1)'}});const ctx=management();
 access.withManagement(ctx,()=>{assert.throws(()=>skills.manageSkill('owner','alpha',{action:'write_file',skillId:skill.id,expectedRevision:1,filePath:'templates/report.md',fileContent:'New template',reason:'template',evidence}),/Read the current target/);skills.readSkillForBot('owner','alpha',skill.id,{filePath:'templates/report.md'});skills.manageSkill('owner','alpha',{action:'write_file',skillId:skill.id,expectedRevision:1,filePath:'templates/report.md',fileContent:'New template',reason:'template',evidence});});
 const restored=skills.rollbackSkill('owner',skill.id,1,2);assert.equal(restored.resources['templates/report.md'],'Old template');assert.equal(restored.resources['scripts/check.mjs'],'console.log(1)');assert.equal(restored.revision,3);
 const locked=skills.updateSkill('owner',skill.id,{locked:true,pinned:true},3);access.withManagement(management(),()=>{skills.readSkillForBot('owner','alpha',skill.id);assert.throws(()=>skills.manageSkill('owner','alpha',{action:'update',skillId:skill.id,expectedRevision:locked.revision,body:'rewrite',reason:'bad',evidence}),/locked/);});
 assert.throws(()=>skills.resources({'scripts/../escape.sh':'oops'}),/Invalid/);
});
test('unattended batches stage destructive changes atomically, while attended refinement can directly replace',async()=>{
 const evidence=[message('Always prefer brief reports.')];const first=memory.saveMemory('owner','alpha',{text:'User prefers detailed reports.',evidence}).memory!;const second=memory.saveMemory('owner','alpha',{text:'User works in London.',evidence}).memory!;const job=jobs.acceptJob('alpha',{type:'learning-review'});
 const tool=LEARNING_TOOLS.find(t=>t.name==='manage_memory')!;
 const result=await access.withManagement({...management(),jobId:job.id},()=>tool.impl({action:'batch',operations:[{action:'replace',memory_id:first.id,expected_revision:1,text:'User prefers brief reports.',evidence},{action:'remove',memory_id:second.id,expected_revision:1}]},jobCtx(job.id)));
 assert.equal(result.isError,undefined);assert.equal(memory.listMemoryChanges('owner','alpha').length,2);assert.equal(memory.listMemories('owner','alpha').length,2);
 const failed=await access.withManagement({...management(),jobId:job.id},()=>tool.impl({action:'batch',operations:[{action:'remove',memory_id:first.id,expected_revision:1},{action:'remove',memory_id:second.id,expected_revision:99}]},jobCtx(job.id)));assert.equal(failed.isError,true);assert.equal(memory.listMemoryChanges('owner','alpha').length,2);
 access.withManagement(management(false),()=>memory.manageMemory('owner','alpha',{action:'replace',memoryId:first.id,expectedRevision:1,text:'User prefers brief reports.',evidence}));assert.equal(memory.listMemories('owner','alpha').some(m=>m.text==='User prefers brief reports.'),true);
});
test('memory approval rejects stale source/base and never revives forgotten facts',()=>{
 const evidence=[message('User prefers concise reports.')];const m=memory.saveMemory('owner','alpha',{text:'User prefers detailed reports.',evidence}).memory!;const change=memory.stageMemoryChange('owner','alpha',{action:'replace',memoryId:m.id,expectedRevision:1,text:'User prefers concise reports.',evidence});
 memory.forgetMemory('owner',m.id,1);assert.throws(()=>memory.resolveMemoryChange('owner',change.id,'approve',1),/changed/);assert.equal(memory.listMemoryChanges('owner','alpha')[0].status,'pending');assert.equal(memory.listMemories('owner','alpha').length,0);assert.equal(memory.resolveMemoryChange('owner',change.id,'reject',1).status,'rejected');
});
test('private/project/account grants expose only current authorized knowledge and revoke immediately',()=>{
 const evidence=[message('The project uses source citations.')];const m=memory.saveMemory('owner','alpha',{text:'Project requires source citations.',evidence,target:'environment'}).memory!;const s=skills.createSkill('owner','alpha',seed);
 assert.equal(learning.learningContext('owner','beta').includes(s.id),false);skills.setSkillScope('owner',s.id,{expectedRevision:1,scope:'project',projectId:'p1',botIds:['beta']});memory.setMemoryScope('owner',m.id,{expectedRevision:1,scope:'account'});
 assert.match(learning.learningContext('owner','beta'),new RegExp(s.id));assert.match(learning.learningContext('owner','beta'),/revision 2/);assert.equal(learning.learningContext('other','foreign').includes(s.id),false);
 skills.setSkillScope('owner',s.id,{expectedRevision:2,scope:'private'});assert.equal(learning.learningContext('owner','beta').includes(s.id),false);assert.throws(()=>skills.setSkillScope('owner',s.id,{expectedRevision:3,scope:'project',projectId:'p',botIds:['foreign']}),/Not found/);
 assert.throws(()=>skills.readSkillForBot('owner','beta',s.id),/Not found/);
});
test('tool observations route to environment and cannot masquerade as human preferences',()=>{
 const n=++seq;db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,\'tool-call\',?,?)').run('alpha',n,n,JSON.stringify({type:'tool-call',status:'done',callId:'observed-tool',name:'inspect',summary:'Project endpoint is /v2/reports.'}),Date.now());
 const evidence=sessions.refsOnly(sessions.validateEvidence('owner','alpha',[{botId:'alpha',generation:1,seq:n,kind:'tool'}]));assert.throws(()=>memory.saveMemory('owner','alpha',{text:'User prefers reports.',evidence}),/human/);
 const saved=memory.saveMemory('owner','alpha',{text:'Project endpoint is /v2/reports.',evidence,target:'environment'}).memory!;assert.equal(saved.evidenceKind,'tool');assert.equal(sessions.readMessageWindow('owner','alpha',evidence[0]).some(m=>m.role==='tool'),true);
});
test('curator defers first run, uses upstream idle/stale/archive defaults and protects pins/locks/routines',()=>{
 const archive=skills.createSkill('owner','alpha',{...seed,name:'Obsolete workflow'});const pinned=skills.createSkill('owner','alpha',{...seed,name:'Pinned workflow',pinned:true});const locked=skills.createSkill('owner','alpha',{...seed,name:'Locked workflow',locked:true});const routine=skills.createSkill('owner','alpha',{...seed,name:'Scheduled workflow'});
 db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,created_at) VALUES(?,?,?,?,?,?,?)').run('routine','alpha','Weekly',`Read ${routine.id}`,'0 0 * * 1','UTC',1);
 const first=Date.now();assert.equal(curator.curateSkills('owner','alpha',first).deferred,true);const stale=curator.curateSkills('owner','alpha',first+15*86400000);assert.deepEqual(stale.stale,[archive.id]);const result=curator.curateSkills('owner','alpha',first+31*86400000);assert.deepEqual(result.archived,[archive.id]);for(const s of[pinned,locked,routine])assert.equal(skills.getSkill('owner',s.id).deleted,false);
 assert.equal(skills.rollbackSkill('owner',archive.id,1,2).deleted,false);
});

test('shared knowledge revision/revocation during a review cancels its next publication',async()=>{
 const shared=skills.createSkill('owner','beta',seed);skills.setSkillScope('owner',shared.id,{expectedRevision:1,scope:'account'});message('Always cite current sources.');patch({memoryTurnInterval:1});const review=turn()!;
 learning.configureLearningModelExecutor(async()=>{skills.setSkillScope('owner',shared.id,{expectedRevision:2,scope:'private'});return call('manage_skill',{action:'create',expected_revision:0,name:'Unsafe new workflow',description:'Stale shared source',body:'Do something',reason:'stale',evidence:[]});});
 const result=await learning.runLearningReview(review.id);assert.equal(result?.status,'cancelled');assert.match(result?.error??'',/sharing grant/);assert.equal(skills.listSkills('owner','alpha').length,0);
});
test('curator can consolidate only managed unprotected packages and archive with full recovery',()=>{
 const now=Date.now();const source=skills.createSkill('owner','alpha',{...seed,name:'Old narrow research'});db.prepare('UPDATE skills SET created_at=? WHERE id=?').run(now-40*86400000,source.id);const pinned=skills.createSkill('owner','alpha',{...seed,name:'Protected research',pinned:true});
 access.withManagement({...management(),actor:'curator'},()=>{skills.readSkillForBot('owner','alpha',source.id);const archived=skills.manageSkill('owner','alpha',{action:'archive',skillId:source.id,expectedRevision:1,reason:'Absorbed into class workflow',evidence:[]});assert.equal(archived.skill?.deleted,true);skills.readSkillForBot('owner','alpha',pinned.id);assert.throws(()=>skills.manageSkill('owner','alpha',{action:'update',skillId:pinned.id,expectedRevision:1,body:'Changed',reason:'unsafe',evidence:[]}),/protected/);});
 assert.equal(skills.rollbackSkill('owner',source.id,1,2).deleted,false);
});
test('new ownership starts fresh counters while stale prior owner review settles cancelled',async()=>{
 message('Always verify sources.');patch({memoryTurnInterval:1});const review=turn()!;
 learning.configureLearningModelExecutor(async()=>{db.prepare('UPDATE bots SET user_id=\'other\' WHERE id=\'alpha\'').run();return final();});assert.equal((await learning.runLearningReview(review.id))?.status,'cancelled');await learning.beforeForegroundTurn('other','alpha');assert.equal((db.prepare('SELECT user_id,memory_turns FROM knowledge_learning_state WHERE bot_id=\'alpha\'').get()as any).user_id,'other');
});

test('completion outbox failures propagate and roll back marker/counters, while stale epochs consume without review',async()=>{
 const evidence=[message('Always verify citations.')];patch({memoryTurnInterval:1});
 db.exec("CREATE TRIGGER fail_learning_enqueue BEFORE INSERT ON knowledge_learning_reviews BEGIN SELECT RAISE(ABORT,'injected_enqueue_failure'); END");
 assert.throws(()=>turn(),/injected_enqueue_failure/);assert.equal((db.prepare('SELECT count(*) n FROM knowledge_learning_turns').get()as any).n,0);db.exec('DROP TRIGGER fail_learning_enqueue');
 const epoch=learning.learningForegroundEpoch('owner','alpha');await learning.beforeForegroundTurn('owner','alpha');assert.equal(turn({foregroundEpoch:epoch}),undefined);assert.equal(learning.listLearningReviews('owner').reviews.length,0);
 const sourceSnapshot=learning.learningSourceSnapshot('alpha',1);db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify({type:'message',role:'user',text:'Edited source'}),'alpha',evidence[0].seq);assert.equal(turn({sourceSnapshot}),undefined);
});
test('model-directed passive corrections handle low-overlap changed values without adding contradictory active facts',()=>{
 const evidence=[message('Timezone is EST now; remember this.')];const original=memory.saveMemory('owner','alpha',{text:'Timezone is PST.',evidence}).memory!;const learned=memory.learnMemory('owner','alpha',{text:'Timezone is EST.',evidence,replacesMemoryId:original.id});assert.ok('change'in learned);assert.equal(memory.listMemories('owner','alpha').length,1);assert.equal(memory.listMemoryChanges('owner','alpha')[0].memoryId,original.id);
});

test('explicit refine preempts an automatic review and runs attended direct memory replacement',async()=>{
 const evidence=[message('Always prefer concise reports.')];const saved=memory.saveMemory('owner','alpha',{text:'User prefers detailed reports.',evidence}).memory!;patch({memoryTurnInterval:1});const automatic=turn()!;
 db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES(?,1,0,?)').run('alpha',JSON.stringify({role:'system',content:'Native fixture system; evidence only, no real sends.'}));const refine=learning.refineLearning('owner','alpha');assert.notEqual(automatic.id,refine.id);assert.equal(learning.listLearningReviews('owner').reviews.find(r=>r.id===automatic.id)?.status,'cancelled');
 let n=0;learning.configureLearningModelExecutor(async()=>++n===1?call('manage_memory',{action:'replace',memory_id:saved.id,expected_revision:1,text:'User prefers concise reports.',evidence}):final());assert.equal((await learning.runLearningReview(refine.id))?.status,'completed');assert.equal(memory.listMemoryChanges('owner','alpha').length,0);assert.equal(memory.listMemories('owner','alpha')[0].text,'User prefers concise reports.');
});
