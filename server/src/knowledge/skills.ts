import {curatorProtected} from './curator.js';
import {publishNativeEvent} from '../native/events.js';
import { assertWritable, canRead, managementContext, recordRead, requireRead,hash, setGrants, type Scope } from './access.js';
import { learningSettings, settingsVersion } from './settings.js';
import { assertPromotion, assertSourcesNotSuppressed, baseSnapshotHash, candidateRow, evaluateSkillProposal, listSkillEvaluations, previewProcedure, procedureWithinPolicy, promotionPolicy, proposalSourcesCurrent } from './evaluation.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { boundedText, checkedRun, expectedRevision, KnowledgeError, ownedBot } from './common.js';
import { refsOnly, validateEvidence, type MessageRef } from './sessions.js';
import { skillProposalStatus } from './proposal-status.js';

export interface SkillContent { name: string; description: string; body: string; resources?:Record<string,string>; locked?:boolean; pinned?:boolean; managed?:boolean; scope?:Scope; projectId?:string|null;deleted?:boolean }
export interface SkillView extends SkillContent { id: string; botId: string; revision: number; createdAt: number; updatedAt: number; deleted: boolean; resources:Record<string,string>;locked:boolean;pinned:boolean;managed:boolean;scope:Scope;projectId:string|null;lastUsedAt:number|null;lifecycle:'active'|'stale'|'archived'|'suspended' }
function content(value: any): SkillContent {
  return { name: boundedText(value?.name, 'Name', 80), description: boundedText(value?.description ?? '', 'Description', 300, true), body: boundedText(value?.body, 'Skill steps', 20000),resources:resources(value?.resources??{}),locked:!!value?.locked,pinned:!!value?.pinned,managed:value?.managed!==false,scope:value?.scope??'private',projectId:value?.projectId??value?.project_id??null,deleted:!!value?.deleted };
}
function view(s: any): SkillView { return { id: s.id, botId: s.bot_id, name: s.name, description: s.description, body: s.body, revision: s.revision, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at, deleted: s.deleted_at !== null,resources:JSON.parse(s.resources??'{}'),locked:!!s.locked,pinned:!!s.pinned,managed:!!s.managed,scope:s.scope??'private',projectId:s.project_id??null,lastUsedAt:s.last_used_at??null,lifecycle:s.lifecycle??'active' }; }
/** Proposals change content, never the owner's sharing/protection choices.
 * Recheck at approval too: already-persisted snapshots may predate this guard.
 * Preserve absent fields on text-only edits, including supporting files. */
function proposalContent(value: SkillContent, current: any | null): SkillContent {
  const prior = current ? view(current) : null;
  const supplied = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  const next = content({ ...prior, ...supplied });
  const controls = prior ?? { scope: 'private', projectId: null, locked: false, pinned: false, managed: true };
  for (const key of ['scope', 'projectId', 'locked', 'pinned', 'managed'] as const) {
    if (next[key] !== controls[key]) throw new KnowledgeError('Skill proposals cannot change sharing or protection settings. Use owner controls; reject old conflicting proposals and request a fresh proposal.', 409);
  }
  return next;
}
function ownSkill(userId: string, id: string): any {
  const row = db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId);
  if (!row) throw new KnowledgeError('Not found', 404);
  return row;
}
export function resources(value:unknown):Record<string,string> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new KnowledgeError('resources must be an object');
 const pairs=Object.entries(value);if(pairs.length>100)throw new KnowledgeError('Too many supporting files');
 let size=0;for(const [path,text] of pairs){if(!/^(references|templates|scripts)\/[a-zA-Z0-9][a-zA-Z0-9_./-]{0,180}$/.test(path)||path.split('/').some(p=>p==='..'||p==='.'||!p)||typeof text!=='string'||text.length>100000)throw new KnowledgeError('Invalid supporting file');size+=(text as string).length;}
 if(size>500000)throw new KnowledgeError('Skill package too large');return Object.fromEntries(pairs) as Record<string,string>;
}
export function getSkill(userId: string, id: string): SkillView { return view(ownSkill(userId, id)); }
export function listSkills(userId: string, botId: string, includeDeleted = false): SkillView[] {
  ownedBot(userId, botId);
  return (db.prepare(`SELECT * FROM skills WHERE bot_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at,id`).all(botId) as any[]).map(view);
}
function append(skill: any, value: SkillContent, action: string, actor: string, evidence: MessageRef[] = [], runId: string | null = null, deleted = false, auditActor?:string) {
  assertWritable(actor,skill.bot_id);
  const revision = skill.revision + 1; const at = now();
  db.prepare('INSERT INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,evidence,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(skill.id, skill.bot_id, revision, JSON.stringify({ ...value, deleted }), action, auditActor??(managementContext()?`${managementContext()!.actor}:${actor}`:actor), JSON.stringify(evidence), runId, at);
  db.prepare('UPDATE skills SET name=?,description=?,body=?,revision=?,deleted_at=?,updated_at=? WHERE id=?')
    .run(value.name, value.description, value.body, revision, deleted ? at : null, at, skill.id);
  db.prepare('UPDATE skills SET resources=?,locked=?,pinned=?,managed=?,scope=?,project_id=?,lifecycle=? WHERE id=?').run(JSON.stringify(value.resources??{}),Number(value.locked??!!skill.locked),Number(value.pinned??!!skill.pinned),Number(value.managed??!!skill.managed),value.scope??skill.scope??'private',value.projectId??null,deleted?'archived':'active',skill.id);
  publishNativeEvent({userId:actor,botId:skill.bot_id,kind:'knowledge.skill.changed',sourceType:'skill',sourceId:skill.id,sourceRevision:revision,jobId:runId,data:{action,deleted}});
  return view(ownSkill(actor, skill.id));
}
function create(userId: string, botId: string, id: string, value: SkillContent, evidence: MessageRef[] = [], runId: string | null = null) {
  assertWritable(userId,botId);const at = now();
  db.prepare('INSERT INTO skills(id,bot_id,name,description,body,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    .run(id, botId, value.name, value.description, value.body, at, at);
  db.prepare('UPDATE skills SET resources=?,locked=?,pinned=?,managed=?,scope=?,project_id=? WHERE id=?').run(JSON.stringify(value.resources??{}),Number(value.locked??false),Number(value.pinned??false),Number(value.managed??true),value.scope??'private',value.projectId??null,id);
  db.prepare('INSERT INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,evidence,run_id,created_at) VALUES(?,?,1,?,?,?,?,?,?)')
    .run(id, botId, JSON.stringify({ ...value, deleted: false }), 'create', managementContext()?`${managementContext()!.actor}:${userId}`:userId, JSON.stringify(evidence), runId, at);
  publishNativeEvent({userId,botId,kind:'knowledge.skill.changed',sourceType:'skill',sourceId:id,sourceRevision:1,jobId:runId,data:{action:'create'}});
  return view(ownSkill(userId, id));
}
export function createSkill(userId: string, botId: string, value: SkillContent): SkillView {
  return db.transaction(() => { rejectBackgroundCRUD();ownedBot(userId, botId); return create(userId, botId, newId('skl'), content(value)); })();
}
function rejectBackgroundCRUD(){if(managementContext()?.unattended)throw new KnowledgeError('Background skill changes must use the evaluation gate',409);}
export function updateSkill(userId: string, id: string, value: Partial<SkillContent>, expected: number): SkillView {
  return db.transaction(() => {
    rejectBackgroundCRUD();
    const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected);
    if (cur.deleted_at !== null) throw new KnowledgeError('Skill is deleted; restore it from history', 409);
    return append(cur, content({ ...view(cur), ...value }), 'edit', userId);
  })();
}
export function deleteSkill(userId: string, id: string, expected: number): SkillView {
  return db.transaction(() => { if(managementContext()?.actor!=='curator')rejectBackgroundCRUD();const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected); return append(cur, content(view(cur)), 'delete', userId, [], null, true); })();
}
export function listSkillHistory(userId: string, id: string) {
  ownSkill(userId, id);
  return (db.prepare('SELECT * FROM knowledge_skill_revisions WHERE skill_id=? ORDER BY revision DESC LIMIT 100').all(id) as any[])
    .map(r => {const promotion=db.prepare('SELECT * FROM knowledge_skill_promotions WHERE skill_id=? AND revision=?').get(id,r.revision) as any;return ({ skillId: r.skill_id, revision: r.revision, ...JSON.parse(r.snapshot), action: r.action, actor: r.actor, evidence: JSON.parse(r.evidence), runId: r.run_id, createdAt: r.created_at,promotion:promotion?{evaluationId:promotion.evaluation_id,policyRevision:promotion.policy_revision,actor:promotion.actor,rollback:JSON.parse(promotion.rollback),evaluations:listSkillEvaluations(userId,promotion.proposal_id)}:null });});
}
export function rollbackSkill(userId: string, id: string, targetRevision: number, expected: number): SkillView {
  return db.transaction(() => {
    rejectBackgroundCRUD();
    const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected);
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) throw new KnowledgeError('Invalid target revision');
    const target = db.prepare('SELECT * FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(id, targetRevision) as any;
    if (!target) throw new KnowledgeError('Revision not found', 404);
    const saved = JSON.parse(target.snapshot);
    return append(cur, content({...saved,scope:cur.scope,projectId:cur.project_id}), `rollback:${targetRevision}`, userId, JSON.parse(target.evidence), target.run_id, saved.deleted);
  })();
}
function render(value: SkillContent | null) { return value ? `# ${value.name}\n${value.description}\n\n${value.body}\n${Object.entries(value.resources??{}).sort(([a],[b])=>a.localeCompare(b)).map(([path,text])=>`\n## ${path}\n${text}\n`).join('')}\nSharing scope: ${value.scope??'private'}\nProject: ${value.projectId??'none'}\nLocked: ${!!value.locked}\nPinned: ${!!value.pinned}\nManaged: ${value.managed!==false}\n${value.deleted?'\n[ARCHIVE]\n':''}` : ''; }
// Native translation of Hermes tools/write_approval.py:74-129,305-345 at
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898 (MIT). Explicit proposals always stage;
// Swarm additionally compares base revision and generation before replay.
export function skillDiff(before: SkillContent | null, after: SkillContent): string {
  const a = render(before).trimEnd().split('\n'), b = render(after).trimEnd().split('\n');
  if (!before) a.length = 0;
  return `--- current\n+++ proposed\n@@ -${a.length ? 1 : 0},${a.length} +1,${b.length} @@\n${a.map(l => `-${l}\n`).join('')}${b.map(l => `+${l}\n`).join('')}`;
}
export function stageSkillProposal(userId: string, botId: string, input: { skillId?: string; expectedRevision: number; content: SkillContent; reason: string; evidence: MessageRef[]; runId?: string }) {
  return db.transaction(() => {
    assertWritable(userId,botId);const bot = ownedBot(userId, botId);
    const cur = input.skillId ? ownSkill(userId, input.skillId) : null;
    if (cur && cur.bot_id !== botId) throw new KnowledgeError('Not found', 404);
    if (cur && cur.deleted_at !== null) throw new KnowledgeError('Skill is deleted', 409);
    if(cur?.locked&&managementContext())throw new KnowledgeError('Skill is locked',409);
    expectedRevision(cur?.revision ?? 0, input.expectedRevision);
    const value = proposalContent(input.content, cur);
    if(cur&&managementContext()){if(value.body!==cur.body||value.name!==cur.name||value.description!==cur.description)requireRead('skill',cur.id,cur.revision,cur.body);for(const[path,text]of Object.entries(view(cur).resources))if(value.resources?.[path]!==text)requireRead('skill',cur.id,cur.revision,text,path);}
    const reason = boundedText(input.reason, 'Reason', 1000);
    const evidence = refsOnly(validateEvidence(userId, botId, input.evidence,managementContext()?.actor!=='curator'));
    const runId = checkedRun(userId, botId, input.runId); const id = newId('skp'); const skillId = cur?.id ?? newId('skl');
    const actor=managementContext()?.actor??'owner';
    const sourceVersions=[...(managementContext()?.reads??new Map<string,string>())].filter(([key])=>key.startsWith('skill:')).map(([key,value])=>{const [,skillId,...rest]=key.split(':');const [revision,digest]=value.split(':');return{skillId,resource:rest.join(':'),revision:Number(revision),hash:digest};});
    db.prepare('INSERT INTO knowledge_skill_proposals(id,bot_id,skill_id,base_revision,generation,snapshot,reason,evidence,run_id,created_at,actor,source_versions,settings_revision,policy_revision,base_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, botId, skillId, input.expectedRevision, bot.generation, JSON.stringify(value), reason, JSON.stringify(evidence), runId, now(),actor,JSON.stringify(sourceVersions),settingsVersion(userId,botId),cur?promotionPolicy(userId,skillId)?.revision??0:0,cur?baseSnapshotHash(skillId,cur.revision):'');
    publishNativeEvent({userId,botId,kind:'knowledge.skill.proposed',sourceType:'skill-proposal',sourceId:id,jobId:runId,data:{skillId}});
    const status = skillProposalStatus({ id, bot_id: botId, skill_id: skillId, base_revision: input.expectedRevision, snapshot: JSON.stringify(value), status: 'pending' });
    return { id, skillId, name: value.name, baseRevision: input.expectedRevision, status, diff: skillDiff(cur ? view(cur) : null, value) };
  })();
}
export function listSkillProposals(userId: string, botId: string) {
  ownedBot(userId, botId);
  return (db.prepare("SELECT * FROM knowledge_skill_proposals WHERE bot_id=? ORDER BY created_at DESC,id DESC LIMIT 100").all(botId) as any[]).map(p => {
    const base = p.base_revision ? db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(p.skill_id, p.base_revision) as any : null;
    const promotion=db.prepare('SELECT * FROM knowledge_skill_promotions WHERE proposal_id=?').get(p.id) as any;
    return { id: p.id, skillId: p.skill_id, baseRevision: p.base_revision, content: JSON.parse(p.snapshot),actor:p.actor,sourceVersions:JSON.parse(p.source_versions??'[]'),settingsRevision:p.settings_revision,policyRevision:p.policy_revision,evaluations:listSkillEvaluations(userId,p.id),promotion:promotion?{evaluationId:promotion.evaluation_id,revision:promotion.revision,policyRevision:promotion.policy_revision,actor:promotion.actor,rollback:JSON.parse(promotion.rollback)}:null, reason: p.reason, evidence: JSON.parse(p.evidence), runId: p.run_id, status: skillProposalStatus(p), createdAt: p.created_at, diff: skillDiff(base ? JSON.parse(base.snapshot) : null, JSON.parse(p.snapshot)) };
  });
}
export function resolveSkillProposal(userId: string, id: string, decision: 'approve' | 'reject', expectedBaseRevision: number) {
  return db.transaction(() => {
    rejectBackgroundCRUD();
    const p = db.prepare('SELECT p.* FROM knowledge_skill_proposals p JOIN bots b ON b.id=p.bot_id WHERE p.id=? AND b.user_id=?').get(id, userId) as any;
    if (!p) throw new KnowledgeError('Not found', 404);
    assertWritable(userId,p.bot_id);expectedRevision(p.base_revision, expectedBaseRevision);
    if (decision === 'approve' && skillProposalStatus(p) === 'superseded') throw new KnowledgeError('This proposal was superseded. Review the current skill or a newer proposal.', 409);
    if (p.status !== 'pending') throw new KnowledgeError('Proposal has already been reviewed', 409);
    if (!['approve', 'reject'].includes(decision)) throw new KnowledgeError('Invalid review decision');
    let skill: SkillView | undefined;
    if (decision === 'approve') {
      const bot = ownedBot(userId, p.bot_id);
      if (bot.generation !== p.generation) throw new KnowledgeError('Conversation changed; ask for a fresh proposal', 409);
      const evidence = refsOnly(validateEvidence(userId, p.bot_id, JSON.parse(p.evidence),p.actor!=='curator'));
      checkedRun(userId, p.bot_id, p.run_id);
      for(const source of JSON.parse(p.source_versions??'[]')){const row=ownSkill(userId,source.skillId);if(!canRead(userId,p.bot_id,'skills',row)||row.deleted_at!==null||row.revision!==source.revision)throw new KnowledgeError('Source skill changed or is no longer shared',409);const text=source.resource?view(row).resources[source.resource]:row.body;if(text===undefined||hash(text)!==source.hash)throw new KnowledgeError('Source skill content changed',409);}

      const cur = db.prepare('SELECT * FROM skills WHERE id=? AND bot_id=?').get(p.skill_id, p.bot_id) as any;
      expectedRevision(cur?.revision ?? 0, p.base_revision);
      const proposed = proposalContent(JSON.parse(p.snapshot), cur);
      skill = cur ? append(cur, proposed, 'learned', userId, evidence, p.run_id,!!proposed.deleted) : create(userId, p.bot_id, p.skill_id, proposed, evidence, p.run_id);
    }
    db.prepare('UPDATE knowledge_skill_proposals SET status=?,resolved_at=?,resolved_by=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected', now(), userId, id);
    publishNativeEvent({userId,botId:p.bot_id,kind:'knowledge.skill.proposal-reviewed',sourceType:'skill-proposal',sourceId:id,data:{decision}});
    return { status: decision === 'approve' ? 'approved' : 'rejected', skill };
  })();
}
export function skillIndexForPrompt(botId: string, budget = 4000): string {
  const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
  if (!bot) return '';
  let used = 0;
  const lines = listSkills(bot.user_id, botId).filter(s=>s.lifecycle!=='suspended').flatMap(s => { const line = `- ${s.id} (revision ${s.revision}): ${s.name} — ${s.description || 'Read for instructions.'}`; if (used + line.length > budget) return []; used += line.length; return [line]; });
  return lines.length ? `Available skills (metadata only). Use read_skill to load a skill before following it.\n${lines.join('\n')}` : '';
}

export function authorizedSkills(userId:string,botId:string):SkillView[] {
 ownedBot(userId,botId);
 return (db.prepare("SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=? AND s.deleted_at IS NULL AND s.lifecycle!='suspended' ORDER BY s.created_at,s.id").all(userId) as any[]).filter(s=>canRead(userId,botId,'skills',s)&&validSkillSources(userId,s)).map(view);
}
function validSkillSources(userId:string,row:any):boolean {
 try{
  const revision=db.prepare('SELECT evidence FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(row.id,row.revision) as any;
  const evidence=validateEvidence(userId,row.bot_id,JSON.parse(revision?.evidence??'[]'),false);assertSourcesNotSuppressed(row.bot_id,evidence);
  const promotion=db.prepare('SELECT proposal_id FROM knowledge_skill_promotions WHERE skill_id=? AND revision=?').get(row.id,row.revision) as any;
  if(promotion)proposalSourcesCurrent(userId,candidateRow(userId,promotion.proposal_id),true);
  return true;
 }catch(e){if(!(e instanceof KnowledgeError))throw e;return false;}
}
export function readSkillForBot(userId:string,botId:string,id:string,opts:{jobId?:string;filePath?:string;review?:boolean}={}) {
 const row=ownSkill(userId,id);if(row.deleted_at!==null||row.lifecycle==='suspended'||!canRead(userId,botId,'skills',row)||!validSkillSources(userId,row))throw new KnowledgeError('Not found',404);
 const skill=view(row);const path=opts.filePath??'';
 const text=path ? skill.resources[path] : skill.body;
 if(text===undefined)throw new KnowledgeError('Supporting file not found',404);
 recordRead(userId,botId,'skill',id,skill.revision,text,opts.jobId,path);
 // Review reads do not make unused skills look useful to the curator.
 if(!opts.review&&(!managementContext()||managementContext()?.actor==='foreground')) db.prepare("UPDATE skills SET last_used_at=?,lifecycle='active' WHERE id=?").run(now(),id);
 return path?{skillId:id,revision:skill.revision,filePath:path,content:text}:{skill};
}
export function setSkillScope(userId:string,id:string,input:{expectedRevision:number;scope:Scope;projectId?:string;botIds?:string[]}) {
 return db.transaction(()=>{const cur=ownSkill(userId,id);expectedRevision(cur.revision,input.expectedRevision);setGrants(userId,cur.bot_id,'skills',id,input.scope,input.projectId,input.botIds);return append(cur,content({...view(cur),scope:input.scope,projectId:input.scope==='project'?input.projectId:null}),'scope',userId);})();
}
export interface SkillMutation { action:'create'|'update'|'patch'|'write_file'|'remove_file'|'delete'|'archive';skillId?:string;expectedRevision:number;name?:string;description?:string;body?:string;resources?:Record<string,string>;filePath?:string;fileContent?:string;oldText?:string;newText?:string;reason:string;evidence:MessageRef[];runId?:string }
export function manageSkill(userId:string,botId:string,input:SkillMutation) {
 return db.transaction(()=>{
  assertWritable(userId,botId);const ctx=managementContext();
  if(!ctx)throw new KnowledgeError('Management operation requires an execution context',409);
  const cur=input.skillId?ownSkill(userId,input.skillId):null;
  if(cur&&(cur.bot_id!==botId||cur.deleted_at!==null))throw new KnowledgeError('Not found',404);
  expectedRevision(cur?.revision??0,input.expectedRevision);
  if(ctx.actor==='curator'&&input.action==='create'&&![...ctx.reads.keys()].some(key=>key.startsWith('skill:')))throw new KnowledgeError('Read source packages before curator consolidation',409);
  if(cur?.locked)throw new KnowledgeError('Skill is locked; do not recreate it under another name',409);
  if(!['create','update','patch','write_file','remove_file','delete','archive'].includes(input.action))throw new KnowledgeError('Invalid skill action');
  if(input.action==='create'&&cur||input.action!=='create'&&!cur)throw new KnowledgeError('Invalid skill target');
  if(input.action==='archive'&&ctx.actor!=='curator')throw new KnowledgeError('Use owner archive controls',409);
  if(ctx.actor==='curator'&&cur&&curatorProtected(botId,view(cur)))throw new KnowledgeError('Curator cannot modify protected skills',409);
  if(ctx.actor==='curator'&&input.action==='archive'&&!cur.last_used_at&&now()-cur.created_at<30*86400000)throw new KnowledgeError('Never-used skills younger than 30 days cannot be archived',409);
  if(ctx.unattended&&input.action==='delete')throw new KnowledgeError('Reviewers cannot delete skills',409);
  const value=cur?view(cur):null;let next:SkillContent;
  if(cur){
   const path=['write_file','remove_file'].includes(input.action)?input.filePath:undefined;
   if(path){resources({[path]:input.fileContent??''});if(path in value!.resources)requireRead('skill',cur.id,cur.revision,value!.resources[path],path);}
   else requireRead('skill',cur.id,cur.revision,cur.body);
   next={...value!};
   if(input.action==='patch'){
    if(typeof input.oldText!=='string'||!input.oldText||typeof input.newText!=='string'||next.body.split(input.oldText).length!==2)throw new KnowledgeError('Patch must match exactly once',409);
    next.body=next.body.replace(input.oldText,input.newText);
   }else if(input.action==='write_file'||input.action==='remove_file'){
    if(!path)throw new KnowledgeError('filePath is required');next.resources={...next.resources};
    if(input.action==='remove_file'){if(!(path in next.resources))throw new KnowledgeError('Supporting file not found',404);delete next.resources[path];}
    else next.resources[path]=boundedText(input.fileContent,'File content',100000,true);
   }else{
    if(input.body!==undefined)next.body=input.body;if(input.name!==undefined)next.name=input.name;if(input.description!==undefined)next.description=input.description;
    if(input.resources!==undefined){for(const [path,text] of Object.entries(value!.resources))if(input.resources[path]!==text)requireRead('skill',cur.id,cur.revision,text,path);next.resources=input.resources;}
   }
  }else next=content(input);
  if(input.action==='archive')next.deleted=true;
  next=content(next);boundedText(input.reason,'Reason',1000);const evidence=refsOnly(validateEvidence(userId,botId,input.evidence,ctx.actor!=='curator'));const runId=checkedRun(userId,botId,input.runId??ctx.jobId);
  if(ctx.actor==='foreground')db.prepare('UPDATE knowledge_learning_state SET skill_iterations=0 WHERE bot_id=? AND user_id=?').run(botId,userId);
  if(ctx.actor==='foreground'&&ctx.jobId){
   db.prepare('INSERT OR IGNORE INTO knowledge_learning_state(bot_id,user_id) VALUES(?,?)').run(botId,userId);
   db.prepare('UPDATE knowledge_learning_state SET skill_reset_job_id=?,skill_reset_iteration=? WHERE bot_id=? AND user_id=?').run(ctx.jobId,ctx.iteration??null,botId,userId);
  }
  if(ctx.unattended||learningSettings(userId,botId).settings.skillApproval){
   if(input.action==='delete')throw new KnowledgeError('Archive through owner controls when approval is required',409);
   const proposal=stageSkillProposal(userId,botId,{skillId:cur?.id,expectedRevision:input.expectedRevision,content:next,reason:input.reason,evidence,runId:runId??undefined});
   if(ctx.unattended&&!learningSettings(userId,botId).settings.skillApproval){
    const evaluation=evaluateSkillProposal(userId,proposal.id);
    if(evaluation.status==='passed')return {...promoteSkillProposal(userId,proposal.id,evaluation.id),proposal:{...proposal,status:'automatically_promoted'},evaluation,activated:true};
    return {proposal,evaluation,activated:false};
   }
   return {proposal,activated:false};
  }
  const skill=cur?append(cur,next,'learned',userId,evidence,runId,input.action==='delete'||input.action==='archive'):create(userId,botId,newId('skl'),next,evidence,runId);
  return {skill,activated:true};
 })();
}

/** Separate capability from owner approval. No tool accepts a model-supplied
 * passing result; only immutable native evaluation rows can authorize this. */
export function promoteSkillProposal(userId:string,id:string,evaluationId:string) {
 return db.transaction(()=>{
  const {proposal:p}=assertPromotion(userId,id,evaluationId);
  const cur=ownSkill(userId,p.skill_id);const next=content(JSON.parse(p.snapshot));
  const actor=`automatic:${managementContext()?.actor??'policy'}`;
  const skill=append(cur,next,'automatic-promotion',userId,JSON.parse(p.evidence),p.run_id,false,actor);
  const baseline=db.prepare('SELECT evidence FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(p.skill_id,p.base_revision) as any;
  const rollback={revision:p.base_revision,hash:p.base_hash,evidence:JSON.parse(baseline.evidence),candidateEvidence:JSON.parse(p.evidence),sourceVersions:JSON.parse(p.source_versions),policyRevision:p.policy_revision,settingsRevision:p.settings_revision};
  db.prepare('INSERT INTO knowledge_skill_promotions(id,bot_id,skill_id,proposal_id,evaluation_id,revision,policy_revision,actor,rollback,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(newId('skpr'),p.bot_id,p.skill_id,id,evaluationId,skill.revision,p.policy_revision,actor,JSON.stringify(rollback),now());
  db.prepare("UPDATE knowledge_skill_proposals SET status='approved',resolved_at=?,resolved_by=? WHERE id=?").run(now(),actor,id);
  publishNativeEvent({userId,botId:p.bot_id,kind:'knowledge.skill.promoted',sourceType:'skill',sourceId:p.skill_id,sourceRevision:skill.revision,data:{actor,evaluationId,policyRevision:p.policy_revision,rollbackRevision:p.base_revision}});
  return {skill,evaluationId,actor};
 })();
}

/** Reproduce a regression with current owner-maintained fixtures. No assertion
 * from a proposing/reviewing model can suspend or roll back a procedure. */
export function recheckSkillPromotion(userId:string,id:string,expected:number) {
 return db.transaction(()=>{
  const cur=ownSkill(userId,id);assertWritable(userId,cur.bot_id);expectedRevision(cur.revision,expected);
  const promotion=db.prepare('SELECT * FROM knowledge_skill_promotions WHERE skill_id=? AND revision=?').get(id,expected) as any;
  const policy=promotionPolicy(userId,id);
  if(!promotion||!policy)throw new KnowledgeError('No promoted revision and current fixtures to recheck',409);
  const checks=policy.policy.cases.map(c=>{let actual:string;try{actual=previewProcedure(view(cur),c.input);}catch(e){if(!(e instanceof KnowledgeError))throw e;actual='unsupported';}return{id:c.id,expected:c.expected,actual,passed:actual===c.expected};});
  let withinPolicy=false;try{withinPolicy=policy.policy.enabled&&procedureWithinPolicy(view(cur),policy.policy);}catch(e){if(!(e instanceof KnowledgeError))throw e;}
  if(!withinPolicy)checks.push({id:'standing_policy',expected:'current_scope',actual:'revoked_or_changed',passed:false});
  if(!checks.some(c=>!c.passed))return{action:'unchanged',checks};
  const rollback=JSON.parse(promotion.rollback);let reason='';let fallback:SkillContent|undefined;
  try{
   if(!policy.policy.enabled)throw new KnowledgeError('Standing policy is disabled',409);
   const p=candidateRow(userId,promotion.proposal_id);proposalSourcesCurrent(userId,p,true);
   if(baseSnapshotHash(id,rollback.revision)!==rollback.hash)throw new KnowledgeError('Rollback baseline unavailable',409);
   const target=db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(id,rollback.revision) as any;
   const value=content(JSON.parse(target.snapshot));
   validateEvidence(userId,cur.bot_id,rollback.evidence,false);assertSourcesNotSuppressed(cur.bot_id,rollback.evidence);
   if(value.deleted||value.scope!==cur.scope||value.projectId!==cur.project_id||value.body!==cur.body||value.name!==cur.name||value.description!==cur.description)throw new KnowledgeError('Rollback baseline no longer matches current applicability',409);
   if(!procedureWithinPolicy(value,policy.policy))throw new KnowledgeError('Rollback baseline expands current policy',409);
   if(policy.policy.cases.some(c=>previewProcedure(value,c.input)!==c.baselineExpected))throw new KnowledgeError('Rollback baseline violates current frozen expectations',409);
   fallback=value;
  }catch(e){if(!(e instanceof KnowledgeError))throw e;reason=e.message;}
  const restored=fallback?append(cur,fallback,`automatic-rollback:${rollback.revision}`,userId,rollback.evidence,null,false,'automatic:regression_guard'):undefined;
  const action=restored?'rolled_back':'suspended';
  if(!restored)db.prepare("UPDATE skills SET lifecycle='suspended',updated_at=? WHERE id=?").run(now(),id);
  const regressionId=newId('skr');
  db.prepare('INSERT INTO knowledge_skill_regressions(id,bot_id,skill_id,revision,policy_revision,checks,action,rollback_revision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(regressionId,cur.bot_id,id,expected,policy.revision,JSON.stringify(checks),action,restored?rollback.revision:null,reason,now());
  publishNativeEvent({userId,botId:cur.bot_id,kind:'knowledge.skill.regression',sourceType:'skill',sourceId:id,sourceRevision:restored?.revision??expected,data:{action,regressionId,reason}});
  return{action,checks,reason,skill:restored,regressionId};
 })();
}
