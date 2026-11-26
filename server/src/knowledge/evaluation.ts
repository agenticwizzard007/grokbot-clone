import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { assertWritable, canRead, hash, managementContext } from './access.js';
import { expectedRevision, KnowledgeError } from './common.js';
import { learningSettings, settingsVersion } from './settings.js';
import { checkedRun } from './common.js';
import { refsOnly, validateEvidence } from './sessions.js';
import type { SkillContent } from './skills.js';
import { skillProposalStatus } from './proposal-status.js';

// This interpreter has no tool dispatcher, network, clock, executable code or
// model dependency. Unsupported procedures have no passing evaluator.
export const PROCEDURE_FILE = 'references/procedure.json';
export const PROCEDURE_BODY = 'Use apply_procedure with this skill ID and frozen observations to return the matched outcome label from references/procedure.json. A label never authorizes an external action or a change to permissions, recipients, schedules, budgets or scope.';
const EVALUATOR = 'frozen-decision-table-v1';
type Scalar = string | number | boolean | null;
interface Procedure { version:1; responsibility:string; rules:{when:Record<string,Scalar>;outcome:string}[]; fallback:string }
export interface EvaluationCase {
 id:string; category:'trigger'|'existing'|'out_of_scope'|'failure';
 input:unknown; expected:string; baselineExpected:string;
}
export interface PromotionPolicy {
 enabled:boolean; responsibility:string; allowedOutcomes:string[];
 cases:EvaluationCase[];
}
function object(value:unknown):value is Record<string,any> { return !!value&&typeof value==='object'&&!Array.isArray(value); }
function keys(value:Record<string,any>, allowed:string[]) { return Object.keys(value).every(k=>allowed.includes(k)); }
function scalar(value:unknown):value is Scalar { return value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=200||typeof value==='number'&&Number.isFinite(value); }
function facts(value:unknown):value is Record<string,Scalar> { return object(value)&&Object.keys(value).length<=16&&Object.entries(value).every(([k,v])=>/^[a-z][a-z0-9_]{0,39}$/.test(k)&&scalar(v)); }
const label = (value:unknown):value is string => typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
export function parseProcedure(content:SkillContent):Procedure {
 if(content.body!==PROCEDURE_BODY||content.deleted||Object.keys(content.resources??{}).length!==1)throw new KnowledgeError('No side-effect-free evaluator for this procedure',409);
 let p:any;try{p=JSON.parse(content.resources![PROCEDURE_FILE]);}catch{throw new KnowledgeError('Missing frozen decision table',409);}
 if(!object(p)||!keys(p,['version','responsibility','rules','fallback'])||p.version!==1||typeof p.responsibility!=='string'||!p.responsibility.trim()||p.responsibility.length>200||!label(p.fallback)||!Array.isArray(p.rules)||p.rules.length>100||!p.rules.every((r:any)=>object(r)&&keys(r,['when','outcome'])&&facts(r.when)&&Object.keys(r.when).length>0&&label(r.outcome)))throw new KnowledgeError('Invalid bounded decision table',409);
 return p as Procedure;
}
export function previewProcedure(content:SkillContent,input:unknown):string {
 const p=parseProcedure(content);
 if(!object(input)||!keys(input,['scope','facts'])||typeof input.scope!=='string'||!facts(input.facts))return 'failure';
 if(input.scope!==p.responsibility)return 'out_of_scope';
 return p.rules.find(rule=>Object.entries(rule.when).every(([key,value])=>Object.hasOwn(input.facts,key)&&input.facts[key]===value))?.outcome??p.fallback;
}
export function procedureWithinPolicy(content:SkillContent,policy:PromotionPolicy) {
 const p=parseProcedure(content);
 return p.responsibility===policy.responsibility&&[...p.rules.map(r=>r.outcome),p.fallback].every(v=>policy.allowedOutcomes.includes(v));
}
function skillRow(userId:string,id:string) {
 const row=db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id,userId) as any;
 if(!row)throw new KnowledgeError('Not found',404);return row;
}
export function promotionPolicy(userId:string,skillId:string) {
 skillRow(userId,skillId);const row=db.prepare('SELECT * FROM knowledge_promotion_policies WHERE skill_id=? ORDER BY revision DESC LIMIT 1').get(skillId) as any;
 return row?{revision:row.revision,policy:JSON.parse(row.snapshot) as PromotionPolicy,actor:row.actor,createdAt:row.created_at}:null;
}
function ownerOnly() { if(managementContext())throw new KnowledgeError('Standing policies require a direct owner decision',409); }
export function setPromotionPolicy(userId:string,skillId:string,input:{expectedRevision:number;policy:PromotionPolicy}) {
 return db.transaction(()=>{
  ownerOnly();const row=skillRow(userId,skillId);assertWritable(userId,row.bot_id);
  const current=promotionPolicy(userId,skillId);expectedRevision(current?.revision??0,input.expectedRevision);
  const p=input.policy;
  if(!object(p)||!keys(p,['enabled','responsibility','allowedOutcomes','cases'])||typeof p.enabled!=='boolean'||typeof p.responsibility!=='string'||!p.responsibility.trim()||p.responsibility.length>200||!Array.isArray(p.allowedOutcomes)||p.allowedOutcomes.length>100||!p.allowedOutcomes.every(label)||!p.allowedOutcomes.includes('failure')||!p.allowedOutcomes.includes('out_of_scope')||!Array.isArray(p.cases)||p.cases.length>100||JSON.stringify(p).length>100000)throw new KnowledgeError('Invalid standing promotion policy');
  if(!p.cases.every(c=>object(c)&&keys(c,['id','category','input','expected','baselineExpected'])&&label(c.id)&&['trigger','existing','out_of_scope','failure'].includes(c.category)&&Object.hasOwn(c,'input')&&p.allowedOutcomes.includes(c.expected)&&p.allowedOutcomes.includes(c.baselineExpected))||new Set(p.cases.map(c=>c.id)).size!==p.cases.length)throw new KnowledgeError('Invalid frozen evaluation cases');
  // The owner supplies these fixtures through authenticated CRUD, never a model tool.
  db.prepare('INSERT INTO knowledge_promotion_policies(skill_id,bot_id,revision,snapshot,actor,created_at) VALUES(?,?,?,?,?,?)').run(skillId,row.bot_id,(current?.revision??0)+1,JSON.stringify(p),userId,now());
  return promotionPolicy(userId,skillId)!;
 })();
}
export function baseSnapshotHash(skillId:string,revision:number) {
 const row=db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(skillId,revision) as any;
 return row?hash(row.snapshot):'';
}
export function proposalSourcesCurrent(userId:string,p:any,allowHistoricalTarget=false) {
 const evidence=refsOnly(validateEvidence(userId,p.bot_id,JSON.parse(p.evidence),p.actor!=='curator'));
 assertSourcesNotSuppressed(p.bot_id,evidence);
 if(JSON.stringify(evidence)!==p.evidence)throw new KnowledgeError('Candidate sources are not version-bound',409);
 checkedRun(userId,p.bot_id,p.run_id);
 for(const source of JSON.parse(p.source_versions)){
  const row=skillRow(userId,source.skillId);
  let text=source.resource?JSON.parse(row.resources)[source.resource]:row.body;
  const historical=allowHistoricalTarget&&source.skillId===p.skill_id;
  if(historical){const r=db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(source.skillId,source.revision) as any;const snapshot=r?JSON.parse(r.snapshot):null;text=source.resource?snapshot?.resources?.[source.resource]:snapshot?.body;}
  if(!canRead(userId,p.bot_id,'skills',row)||row.deleted_at!==null||row.lifecycle==='suspended'||!historical&&row.revision!==source.revision||typeof text!=='string'||hash(text)!==source.hash)throw new KnowledgeError('Source skill changed or is no longer shared',409);
 }
}
export function assertSourcesNotSuppressed(botId:string,evidence:{botId:string;generation:number;seq:number}[]) {
 const keys=new Set(evidence.map(r=>`${r.botId}:${r.generation}:${r.seq}`));
 for(const row of db.prepare('SELECT evidence FROM knowledge_memory_suppressions WHERE bot_id=?').all(botId) as any[]){
  if(JSON.parse(row.evidence).some((r:any)=>keys.has(`${r.botId}:${r.generation}:${r.seq}`)))throw new KnowledgeError('A source was forgotten or superseded',409);
 }
}
export function candidateRow(userId:string,id:string) {
 const p=db.prepare('SELECT p.* FROM knowledge_skill_proposals p JOIN bots b ON b.id=p.bot_id WHERE p.id=? AND b.user_id=?').get(id,userId) as any;
 if(!p)throw new KnowledgeError('Not found',404);return {...p,status:skillProposalStatus(p)};
}
function unchangedEnvelope(base:SkillContent,next:SkillContent) {
 const omit=(s:SkillContent)=>({...s,resources:undefined});
 return JSON.stringify(omit(base))===JSON.stringify(omit(next));
}
function checkCandidate(userId:string,p:any):{policy:PromotionPolicy;base:SkillContent;next:SkillContent} {
 assertWritable(userId,p.bot_id);
 if(p.status!=='pending')throw new KnowledgeError('Candidate has already been resolved',409);
 const bot=db.prepare('SELECT generation FROM bots WHERE id=? AND user_id=?').get(p.bot_id,userId) as any;
 if(bot.generation!==p.generation)throw new KnowledgeError('Conversation generation changed',409);
 const settings=learningSettings(userId,p.bot_id).settings;
 if(!settings.enabled||settings.skillApproval||settingsVersion(userId,p.bot_id)!==p.settings_revision)throw new KnowledgeError('Standing learning settings changed or require owner review',409);
 const policy=promotionPolicy(userId,p.skill_id);
 if(!policy?.policy.enabled||policy.revision!==p.policy_revision)throw new KnowledgeError('No current standing promotion policy',409);
 const row=skillRow(userId,p.skill_id);expectedRevision(row.revision,p.base_revision);
 if(row.deleted_at!==null||row.lifecycle==='suspended'||row.locked||row.pinned||!row.managed)throw new KnowledgeError('Procedure is inactive or protected',409);
 if(!p.base_hash||baseSnapshotHash(p.skill_id,p.base_revision)!==p.base_hash)throw new KnowledgeError('Rollback baseline changed or is unavailable',409);
 proposalSourcesCurrent(userId,p);
 const base=JSON.parse((db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(p.skill_id,p.base_revision) as any).snapshot) as SkillContent;
 const next=JSON.parse(p.snapshot) as SkillContent;
 // Applicability, instructions, authority and sharing remain byte-for-byte fixed.
 if(!unchangedEnvelope(base,next))throw new KnowledgeError('Candidate changes responsibility, instructions or sharing scope',409);
 const a=parseProcedure(base),b=parseProcedure(next);
 if(a.responsibility!==policy.policy.responsibility||b.responsibility!==a.responsibility||[...b.rules.map(r=>r.outcome),b.fallback].some(v=>!policy.policy.allowedOutcomes.includes(v)))throw new KnowledgeError('Candidate expands approved applicability or outcomes',409);
 return {policy:policy.policy,base,next};
}
export function evaluateSkillProposal(userId:string,id:string) {
 return db.transaction(()=>{
  const p=candidateRow(userId,id);assertWritable(userId,p.bot_id);
  let status='insufficient',reason='',results:any[]=[];
  try{
   const {policy,base,next}=checkCandidate(userId,p);
   const cases=policy.cases;
   if(cases.length<5||new Set(cases.map(c=>JSON.stringify(c.input))).size<5||!['trigger','existing','out_of_scope','failure'].every(k=>cases.some(c=>c.category===k)))throw new KnowledgeError('At least five distinct frozen cases must cover trigger, existing, out-of-scope and failure behavior',409);
   if(cases.filter(c=>c.category==='existing').length<2||cases.some(c=>['trigger','existing'].includes(c.category)&&(!object(c.input)||c.input.scope!==policy.responsibility||!facts(c.input.facts))))throw new KnowledgeError('Trigger and at least two baseline cases must exercise valid in-scope observations',409);
   results=cases.map(c=>{
    const baseline=previewProcedure(base,c.input),actual=previewProcedure(next,c.input);
    const hard=c.category==='failure'?actual==='failure'&&baseline==='failure':c.category==='out_of_scope'?actual==='out_of_scope'&&baseline==='out_of_scope':true;
    return {id:c.id,category:c.category,input:c.input,expected:c.expected,baselineExpected:c.baselineExpected,baseline,actual,passed:hard&&actual===c.expected&&baseline===c.baselineExpected};
   });
   const improvement=results.some(r=>r.category==='trigger'&&r.actual!==r.baseline&&r.passed);
   const regression=results.some(r=>r.category!=='trigger'&&r.actual!==r.baseline);
   status=results.every(r=>r.passed)&&improvement&&!regression?'passed':'failed';
   reason=status==='passed'?'All frozen expectations passed; triggering defect corrected without baseline regression':'Frozen expectations, targeted improvement or baseline preservation failed';
  }catch(e){if(!(e instanceof KnowledgeError))throw e;reason=e.message;}
  const evaluation={id:newId('ske'),proposalId:id,candidateHash:hash(p.snapshot),sourceHash:hash(p.evidence+p.source_versions),baseHash:p.base_hash,policyRevision:p.policy_revision,settingsRevision:p.settings_revision,evaluator:EVALUATOR,status,reason,results,createdAt:now()};
  db.prepare('INSERT INTO knowledge_skill_evaluations(id,bot_id,proposal_id,candidate_hash,source_hash,base_hash,policy_revision,settings_revision,evaluator,status,reason,results,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(evaluation.id,p.bot_id,id,evaluation.candidateHash,evaluation.sourceHash,evaluation.baseHash,evaluation.policyRevision,evaluation.settingsRevision,EVALUATOR,status,reason,JSON.stringify(results),evaluation.createdAt);
  return evaluation;
 })();
}
export function listSkillEvaluations(userId:string,id:string) {
 candidateRow(userId,id);return (db.prepare('SELECT * FROM knowledge_skill_evaluations WHERE proposal_id=? ORDER BY rowid').all(id) as any[]).map(r=>({id:r.id,proposalId:r.proposal_id,candidateHash:r.candidate_hash,sourceHash:r.source_hash,baseHash:r.base_hash,policyRevision:r.policy_revision,settingsRevision:r.settings_revision,evaluator:r.evaluator,status:r.status,reason:r.reason,results:JSON.parse(r.results),createdAt:r.created_at}));
}
/** Revalidate immediately inside the promotion transaction. Evaluation is not a
 * bearer credential: source deletion, owner edits and policy changes fence it. */
export function assertPromotion(userId:string,id:string,evaluationId:string) {
 const p=candidateRow(userId,id);checkCandidate(userId,p);
 const e=db.prepare('SELECT * FROM knowledge_skill_evaluations WHERE id=? AND proposal_id=?').get(evaluationId,id) as any;
 if(!e||e.status!=='passed'||e.evaluator!==EVALUATOR||e.candidate_hash!==hash(p.snapshot)||e.source_hash!==hash(p.evidence+p.source_versions)||e.base_hash!==p.base_hash||e.policy_revision!==p.policy_revision||e.settings_revision!==p.settings_revision)throw new KnowledgeError('No matching passing evaluation',409);
 return {proposal:p,evaluation:e};
}
