import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after,beforeEach,mock,test} from 'node:test';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quinn-promotion-'));
Object.assign(process.env,{DB_PATH:path.join(dir,'test.db'),FILES_DIR:path.join(dir,'files'),SWARM_ROLE:'standalone',NODE_ENV:'test',SESSION_SECRET:'promotion-test',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',DIRECT_API_KEY:'fixture',LLM_PROVIDER:'direct',INKBOX_TUNNEL:'0'});
mock.method(globalThis,'fetch',async()=>{throw new Error('Evaluation must not call the network');});
const {db}=await import('../server/src/db.js');
await import('../server/src/db-config.js');
const skills=await import('../server/src/knowledge/skills.js');
const evaluation=await import('../server/src/knowledge/evaluation.js');
const access=await import('../server/src/knowledge/access.js');
const memory=await import('../server/src/knowledge/memory.js');
const settings=await import('../server/src/knowledge/settings.js');
const curator=await import('../server/src/knowledge/curator.js');
const {consolidateBot}=await import('../server/src/agent/memory.js');
const {llmClient}=await import('../server/src/lib/llm.js');
const {KNOWLEDGE_TOOLS}=await import('../server/src/agent/knowledge-tools.js');
for(const id of ['owner','other'])db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run(id,`${id}@test.invalid`,id);
let seq=0;
function message(text:string,extra:any={},botId='alpha') {const n=++seq;db.prepare("INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,'message',?,?)").run(botId,n,n,JSON.stringify({type:'message',role:'user',text,...extra}),1000+n);return {botId,generation:1,seq:n};}
const context=()=>({userId:'owner',botId:'alpha',unattended:true,actor:'background_review',reads:new Map<string,string>()});
const procedure=(fixed=false)=>({version:1,responsibility:'report_triage',rules:[{when:{urgent:true},outcome:fixed?'priority':'standard'}],fallback:'standard'});
const cases:evaluation.EvaluationCase[]=[
 {id:'trigger',category:'trigger',input:{scope:'report_triage',facts:{urgent:true}},expected:'priority',baselineExpected:'standard'},
 {id:'normal',category:'existing',input:{scope:'report_triage',facts:{urgent:false}},expected:'standard',baselineExpected:'standard'},
 {id:'unknown',category:'existing',input:{scope:'report_triage',facts:{document:'other'}},expected:'standard',baselineExpected:'standard'},
 {id:'outside',category:'out_of_scope',input:{scope:'other',facts:{urgent:true}},expected:'out_of_scope',baselineExpected:'out_of_scope'},
 {id:'invalid',category:'failure',input:null,expected:'failure',baselineExpected:'failure'},
];
function setup(policyPatch:any={}) {
 const skill=skills.createSkill('owner','alpha',{name:'Report triage',description:'Classify frozen reports',body:evaluation.PROCEDURE_BODY,resources:{[evaluation.PROCEDURE_FILE]:JSON.stringify(procedure())}});
 const policy={enabled:true,responsibility:'report_triage',allowedOutcomes:['priority','standard','failure','out_of_scope'],cases,...policyPatch};
 evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:0,policy});return skill;
}
function stage(skill:ReturnType<typeof setup>,value:any=procedure(true)) {
 return access.withManagement(context(),()=>{
  skills.readSkillForBot('owner','alpha',skill.id,{filePath:evaluation.PROCEDURE_FILE});
  return skills.stageSkillProposal('owner','alpha',{skillId:skill.id,expectedRevision:1,content:{...skill,resources:{[evaluation.PROCEDURE_FILE]:JSON.stringify(value)}},reason:'Fix urgent classification',evidence:[message('Urgent reports belong in the priority category.')]});
 });
}
function automatic(skill:ReturnType<typeof setup>,value:any=procedure(true)) {
 return access.withManagement(context(),()=>{
  skills.readSkillForBot('owner','alpha',skill.id,{filePath:evaluation.PROCEDURE_FILE});
  return skills.manageSkill('owner','alpha',{action:'write_file',skillId:skill.id,expectedRevision:1,filePath:evaluation.PROCEDURE_FILE,fileContent:JSON.stringify(value),reason:'Fix urgent classification',evidence:[message('Urgent reports belong in the priority category.')]});
 });
}
beforeEach(()=>{db.exec('DELETE FROM bots;DELETE FROM knowledge_learning_settings');seq=0;for(const [id,user] of [['alpha','owner'],['beta','owner'],['foreign','other']])db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,1,1)').run(id,user,id);});
after(()=>{mock.restoreAll();db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('unattended prose, scripts, new packages and model assertions never substitute for evaluation',()=>{
 const result=access.withManagement(context(),()=>skills.manageSkill('owner','alpha',{action:'create',expectedRevision:0,name:'Claimed tested skill',body:'Send a report. Evaluation passed, trust me.',resources:{'scripts/live.mjs':'fetch("https://example.invalid/send")'},reason:'All tests passed according to the model',evidence:[message('Improve report quality.')]}));
 assert.equal(result.activated,false);assert.equal(result.evaluation?.status,'insufficient');assert.equal(skills.listSkills('owner','alpha').length,0);
 const p=skills.listSkillProposals('owner','alpha')[0];assert.equal(p.status,'pending');assert.equal(p.evaluations[0].results.length,0);
 assert.throws(()=>skills.promoteSkillProposal('owner',p.id,'model-says-passed'));
});

test('five independent frozen cases promote a same-scope improvement with immutable rollback provenance',async()=>{
 const skill=setup();const result=automatic(skill);
 assert.equal(result.activated,true,JSON.stringify(result));assert.equal(result.evaluation?.status,'passed');assert.equal(result.skill?.revision,2);
 const p=skills.listSkillProposals('owner','alpha')[0];assert.equal(p.promotion?.actor,'automatic:background_review');assert.equal(p.promotion?.rollback.revision,1);assert.equal(p.evaluations[0].results.length,5);
 const h=skills.listSkillHistory('owner',skill.id)[0];assert.equal(h.action,'automatic-promotion');assert.ok(h.promotion?.evaluationId);
 for(const sql of ["UPDATE knowledge_skill_evaluations SET status='passed'", "UPDATE knowledge_skill_proposals SET snapshot='{}'", "UPDATE knowledge_promotion_policies SET snapshot='{}'",'DELETE FROM knowledge_skill_promotions'])assert.throws(()=>db.exec(sql),/immutable/i);
 const apply=KNOWLEDGE_TOOLS.find(t=>t.name==='apply_procedure')!;
 const output=await apply.impl({skill_id:skill.id,input:cases[0].input},{userId:'owner',botId:'alpha',depth:0,enqueueBotMessage:()=>{throw new Error('No business tools');}});
 assert.equal(JSON.parse(output.output).outcome,'priority');
 const application=db.prepare('SELECT * FROM knowledge_procedure_applications').get() as any;assert.equal(application.revision,2);assert.equal(application.output,'priority');
 assert.equal(skills.recheckSkillPromotion('owner',skill.id,2).action,'unchanged');
});

test('approval opt-in stages even a supported procedure with a standing policy',()=>{
 const skill=setup();settings.patchLearningSettings('owner',{expectedRevision:0,settings:{skillApproval:true}});
 const result=automatic(skill);assert.equal(result.activated,false);assert.equal(result.evaluation,undefined);assert.equal(skills.getSkill('owner',skill.id).revision,1);
 assert.equal(skills.resolveSkillProposal('owner',result.proposal!.id,'approve',1).skill?.revision,2);
});

test('too few cases, missing categories and duplicate inputs remain insufficient',()=>{
 for(const patch of [{cases:cases.slice(0,4)},{cases:cases.map(c=>({...c,category:'existing'}))},{cases:cases.map(c=>({...c,input:cases[0].input}))}]){
  const skill=setup(patch);const result=automatic(skill);assert.equal(result.activated,false);assert.equal(result.evaluation?.status,'insufficient');
 }
});

test('a baseline regression and an unchanged triggering defect fail evaluation',()=>{
 const a=setup();const regression={...procedure(true),fallback:'priority'};assert.equal(automatic(a,regression).evaluation?.status,'failed');
 const b=setup();assert.equal(automatic(b,procedure(false)).evaluation?.status,'failed');
});

test('background actors cannot alter policies, sharing, instructions or applicability',()=>{
 const skill=setup();
 access.withManagement(context(),()=>{
  assert.throws(()=>evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:evaluation.promotionPolicy('owner',skill.id)!.policy}),/owner decision/);
  assert.throws(()=>skills.setSkillScope('owner',skill.id,{expectedRevision:1,scope:'account'}),/scope/);
  assert.throws(()=>skills.updateSkill('owner',skill.id,{body:'New authority'},1),/evaluation gate/);
  assert.throws(()=>skills.createSkill('owner','alpha',{name:'New',description:'',body:'New authority'}),/evaluation gate/);
 });
 const outside=automatic(skill,{...procedure(true),responsibility:'new_department'});assert.equal(outside.activated,false);assert.match(outside.evaluation!.reason,/applicability/);
 const next=stage(skill);const p=skills.listSkillProposals('owner','alpha').find(p=>p.id===next.id)!;
 assert.throws(()=>access.withManagement(context(),()=>skills.resolveSkillProposal('owner',p.id,'approve',1)),/evaluation gate/);
});

for(const change of ['source-edit','source-delete','base-edit','policy-edit','settings-edit','generation'] as const)test(`passing evaluation cannot publish after ${change}`,()=>{
 const skill=setup();const p=stage(skill);const e=evaluation.evaluateSkillProposal('owner',p.id);assert.equal(e.status,'passed',e.reason);
 if(change==='source-edit')db.prepare("UPDATE rows SET body=json_set(body,'$.text','Changed') WHERE bot_id='alpha'").run();
 if(change==='source-delete')db.prepare("DELETE FROM rows WHERE bot_id='alpha'").run();
 if(change==='base-edit')skills.updateSkill('owner',skill.id,{description:'Owner edit'},1);
 if(change==='policy-edit')evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:evaluation.promotionPolicy('owner',skill.id)!.policy});
 if(change==='settings-edit')settings.patchLearningSettings('owner',{expectedRevision:0,settings:{memoryTurnInterval:9}});
 if(change==='generation')db.prepare("UPDATE bots SET generation=2 WHERE id='alpha'").run();
 assert.throws(()=>skills.promoteSkillProposal('owner',p.id,e.id));assert.equal(skills.listSkillProposals('owner','alpha')[0].status,'pending');
 assert.equal(evaluation.listSkillEvaluations('owner',p.id)[0].status,'passed','historical result remains immutable, never rewritten to fit current state');
});

test('critical fixture regression rolls back only to a baseline valid under current policy',()=>{
 const skill=setup();automatic(skill);
 const p=evaluation.promotionPolicy('owner',skill.id)!;
 evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:{...p.policy,cases:p.policy.cases.map(c=>c.id==='trigger'?{...c,expected:'standard'}:c)}});
 const result=skills.recheckSkillPromotion('owner',skill.id,2);assert.equal(result.action,'rolled_back',JSON.stringify(result));assert.equal(result.skill?.revision,3);
 assert.equal(evaluation.previewProcedure(skills.getSkill('owner',skill.id),cases[0].input),'standard');
 assert.equal((db.prepare('SELECT action FROM knowledge_skill_regressions').get() as any).action,'rolled_back');
});

test('critical fixture regression suspends when current policy makes rollback invalid',()=>{
 const skill=setup();automatic(skill);const p=evaluation.promotionPolicy('owner',skill.id)!;
 evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:{...p.policy,cases:p.policy.cases.map(c=>c.id==='trigger'?{...c,expected:'standard',baselineExpected:'priority'}:c)}});
 const result=skills.recheckSkillPromotion('owner',skill.id,2);assert.equal(result.action,'suspended');assert.equal(skills.authorizedSkills('owner','alpha').length,0);
 assert.throws(()=>skills.readSkillForBot('owner','alpha',skill.id),/Not found/);
 assert.equal(curator.curatorProtected('alpha',skills.getSkill('owner',skill.id)),true);
});

test('explicit human same-scope corrections apply while paused and retain scope/history',()=>{
 const old=message('I prefer weekly pipeline reports.');const first=memory.saveMemory('owner','alpha',{text:'Prefers weekly pipeline reports.',evidence:[old]}).memory!;
 memory.setMemoryScope('owner',first.id,{expectedRevision:1,scope:'project',projectId:'client',botIds:['beta']});
 settings.patchLearningSettings('owner',{expectedRevision:0,settings:{enabled:false}});
 const ref=message('I now prefer daily pipeline reports.');const changes=memory.applyExplicitPreferenceCorrections('owner','alpha',[ref]);assert.equal(changes.length,1);assert.equal(changes[0].scope,'project');assert.equal(changes[0].supersededRevision,2);assert.equal(memory.authorizedMemories('owner','beta')[0].id,changes[0].id);
 const grants=db.prepare("SELECT * FROM knowledge_grants WHERE kind='memories'").all() as any[];assert.equal(grants.length,1);assert.equal(grants[0].source_id,changes[0].id);
});

for(const [text,extra] of [
 ['I now prefer daily pipeline reports.',{from:{kind:'bot',id:'peer',name:'Peer'}}],
 ['I now prefer daily pipeline reports.',{audience:'internal'}],
 ['Starting next Monday I prefer daily pipeline reports.',{}],
 ['For this report I prefer daily pipeline reports.',{}],
 ['Maybe daily pipeline reports would help.',{}],
 ['I now prefer daily pipeline reports.'+' '.repeat(4100)+'This is an example, not my preference.',{}],
 ['I now prefer daily pipeline reports for the whole company.',{}],
] as const)test(`inferred, future, scoped or nonhuman correction stays staged: ${text.length>100?'truncated source':text} ${JSON.stringify(extra)}`,()=>{
 const old=message('I prefer weekly pipeline reports.');const first=memory.saveMemory('owner','alpha',{text:'Prefers weekly pipeline reports.',evidence:[old]}).memory!;
 const ref=message(text,extra);assert.equal(memory.applyExplicitPreferenceCorrections('owner','alpha',[ref]).length,0);
 const run=()=>access.withManagement(context(),()=>memory.manageMemory('owner','alpha',{action:'replace',memoryId:first.id,expectedRevision:1,text:'Prefers daily pipeline reports.',evidence:[ref]}));
 if('from' in extra||'audience' in extra){assert.throws(run,/human evidence/);return;}
 const result=run();
 assert.equal(result.activated,false);assert.equal(memory.listMemories('owner','alpha')[0].id,first.id);
});

test('forgetting stays staged even when a recent source is an explicit preference correction',()=>{
 const old=message('I prefer weekly pipeline reports.');const first=memory.saveMemory('owner','alpha',{text:'Prefers weekly pipeline reports.',evidence:[old]}).memory!;
 const result=access.withManagement(context(),()=>memory.manageMemory('owner','alpha',{action:'remove',memoryId:first.id,expectedRevision:1,evidence:[message('Forget weekly reports.')]}));assert.equal(result.activated,false);assert.equal(memory.listMemories('owner','alpha')[0].id,first.id);
});

test('oversized source fragments are bounded, contiguous, auditable and resume after no-change review',async()=>{
 message('prefix '+'long context '.repeat(7000)+'TAIL_SOURCE');
 const ranges:number[][]=[];let seenTail=false;
 const model=mock.method(llmClient(300000).responses,'create',async(request:any)=>{const text=request.input.at(-1).content;assert.ok(text.length<28000);seenTail ||= text.includes('TAIL_SOURCE');return {output_text:'{"memories":[]}'};});
 try{for(let i=0;i<12;i++){const r=await consolidateBot('alpha',{upTo:10000});if(!r.considered)break;const stored=db.prepare('SELECT sources FROM knowledge_memory_reviews ORDER BY rowid DESC LIMIT 1').get() as any;const source=JSON.parse(stored.sources)[0];ranges.push([source.start,source.end]);}
 assert.ok(ranges.length>1);assert.ok(seenTail);assert.equal(ranges[0][0],0);for(let i=1;i<ranges.length;i++)assert.equal(ranges[i][0],ranges[i-1][1]);assert.equal((db.prepare("SELECT cursor_seq,fragment_offset FROM memory_jobs WHERE bot_id='alpha'").get() as any).fragment_offset,0);
 }finally{model.mock.restore();}
});

test('promotion rolls back candidate, evaluation, revision and events together on publication failure',()=>{
 const skill=setup();
 db.exec("CREATE TRIGGER promotion_fail BEFORE INSERT ON native_events WHEN NEW.kind='knowledge.skill.changed' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
 try{assert.throws(()=>automatic(skill),/injected publication failure/);assert.equal(skills.getSkill('owner',skill.id).revision,1);assert.equal(skills.listSkillProposals('owner','alpha').length,0);assert.equal((db.prepare('SELECT count(*) n FROM knowledge_skill_evaluations').get() as any).n,0);}finally{db.exec('DROP TRIGGER promotion_fail');}
});

test('source forgetting invalidates a previously passing candidate and source deletion hides active derived procedures',()=>{
 const skill=setup();const p=stage(skill);const e=evaluation.evaluateSkillProposal('owner',p.id);assert.equal(e.status,'passed');
 const ref=skills.listSkillProposals('owner','alpha')[0].evidence[0];const fact=memory.saveMemory('owner','alpha',{text:'Urgent reports use priority.',evidence:[ref]}).memory!;memory.forgetMemory('owner',fact.id,1);
 assert.throws(()=>skills.promoteSkillProposal('owner',p.id,e.id),/forgotten/);
 const other=setup();automatic(other);assert.ok(skills.authorizedSkills('owner','alpha').some(s=>s.id===other.id));db.prepare("DELETE FROM rows WHERE bot_id='alpha'").run();assert.equal(skills.authorizedSkills('owner','alpha').some(s=>s.id===other.id),false);assert.throws(()=>skills.readSkillForBot('owner','alpha',other.id),/Not found/);
});

test('revoking the standing policy suspends the promoted revision without reactivating through maintenance',()=>{
 const skill=setup();automatic(skill);const p=evaluation.promotionPolicy('owner',skill.id)!;evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:{...p.policy,enabled:false}});
 assert.equal(skills.recheckSkillPromotion('owner',skill.id,2).action,'suspended');
 const first=Date.now();curator.curateSkills('owner','alpha',first);curator.curateSkills('owner','alpha',first+40*86400000);assert.equal(skills.getSkill('owner',skill.id).lifecycle,'suspended');
});

test('source-sharing revocation invalidates frozen evaluations without widening source validators',()=>{
 const skill=setup();const source=skills.createSkill('owner','beta',{name:'Shared reference',description:'',body:'Only classify report observations.'});skills.setSkillScope('owner',source.id,{expectedRevision:1,scope:'project',projectId:'client',botIds:['alpha']});
 const p=access.withManagement(context(),()=>{skills.readSkillForBot('owner','alpha',source.id);skills.readSkillForBot('owner','alpha',skill.id,{filePath:evaluation.PROCEDURE_FILE});return skills.stageSkillProposal('owner','alpha',{skillId:skill.id,expectedRevision:1,content:{...skill,resources:{[evaluation.PROCEDURE_FILE]:JSON.stringify(procedure(true))}},reason:'Improve classification',evidence:[message('Use priority for urgent reports.')]});});
 const e=evaluation.evaluateSkillProposal('owner',p.id);assert.equal(e.status,'passed');skills.setSkillScope('owner',source.id,{expectedRevision:2,scope:'private'});assert.throws(()=>skills.promoteSkillProposal('owner',p.id,e.id),/no longer shared/);
});

test('rollback publication failure leaves the promoted revision and regression records unchanged',()=>{
 const skill=setup();automatic(skill);const p=evaluation.promotionPolicy('owner',skill.id)!;evaluation.setPromotionPolicy('owner',skill.id,{expectedRevision:1,policy:{...p.policy,cases:p.policy.cases.map(c=>c.id==='trigger'?{...c,expected:'standard'}:c)}});
 db.exec("CREATE TRIGGER rollback_fail BEFORE INSERT ON native_events WHEN NEW.kind='knowledge.skill.changed' BEGIN SELECT RAISE(ABORT,'rollback publication failure'); END");
 try{assert.throws(()=>skills.recheckSkillPromotion('owner',skill.id,2),/rollback publication failure/);assert.equal(skills.getSkill('owner',skill.id).revision,2);assert.equal((db.prepare('SELECT count(*) n FROM knowledge_skill_regressions').get() as any).n,0);}finally{db.exec('DROP TRIGGER rollback_fail');}
});

test('background actor cannot expand its own learning budget or policy',()=>{
 access.withManagement(context(),()=>assert.throws(()=>settings.patchLearningSettings('owner',{expectedRevision:0,settings:{maxInputTokens:0,skillApproval:false}}),/cannot change its budget or policy/));
 assert.equal(settings.learningSettings('owner','alpha').settings.maxInputTokens,32000);
});

test('authenticated policy/evaluation API enforces owner and revision boundaries',async()=>{
 const {learningApi}=await import('../server/src/routes-learning.js');const {randomBytes,createHash}=await import('node:crypto');const skill=setup();const p=stage(skill);
 const cookie=(user:string)=>{const raw=randomBytes(32).toString('hex'),at=Date.now();db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(?,?,?,?,?,?)').run(createHash('sha256').update(raw).digest('hex'),user,at,at+60000,at,at);return `swarm_session=${raw}`;};
 const owner=cookie('owner'),other=cookie('other');const req=(url:string,method='GET',body?:any,token=owner)=>learningApi.request(url,{method,headers:{cookie:token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await learningApi.request(`/skills/${skill.id}/promotion-policy`)).status,401);
 assert.equal((await req(`/skills/${skill.id}/promotion-policy`,'GET',undefined,other)).status,404);
 assert.equal((await req(`/skills/${skill.id}/promotion-policy`,'PUT',{expectedRevision:0,policy:evaluation.promotionPolicy('owner',skill.id)!.policy})).status,409);
 const response=await req(`/skill-proposals/${p.id}/evaluate`,'POST',{});assert.equal(response.status,200);assert.equal((await response.json()).evaluation.status,'passed');
 assert.equal((await req(`/skill-proposals/${p.id}/evaluations`,'GET',undefined,other)).status,404);
});

test('no-human coverage checkpoint and immutable review audit commit atomically',async()=>{
 message('Assistant observation without a human preference.',{role:'assistant'});
 db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON knowledge_memory_reviews BEGIN SELECT RAISE(ABORT,'coverage audit unavailable'); END");
 try{await assert.rejects(consolidateBot('alpha',{upTo:10000}),/coverage audit unavailable/);assert.equal(db.prepare("SELECT 1 FROM memory_jobs WHERE bot_id='alpha'").get(),undefined);}finally{db.exec('DROP TRIGGER audit_fail');}
 assert.equal((await consolidateBot('alpha',{upTo:10000})).considered,1);assert.equal((db.prepare('SELECT count(*) n FROM knowledge_memory_reviews').get() as any).n,1);
});
