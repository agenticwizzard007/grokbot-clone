import { assertWritable, canRead, managementContext, recordRead, requireRead, setGrants, type Scope } from './access.js';
import { learningSettings } from './settings.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { boundedText, checkedRun, expectedRevision, KnowledgeError, ownedBot } from './common.js';
import { refsOnly, validateEvidence, type MessageRef } from './sessions.js';

export interface SkillContent { name: string; description: string; body: string; resources?:Record<string,string>; locked?:boolean; pinned?:boolean; managed?:boolean; scope?:Scope; projectId?:string|null }
export interface SkillView extends SkillContent { id: string; botId: string; revision: number; createdAt: number; updatedAt: number; deleted: boolean; resources:Record<string,string>;locked:boolean;pinned:boolean;managed:boolean;scope:Scope;projectId:string|null;lastUsedAt:number|null }
function content(value: any): SkillContent {
  return { name: boundedText(value?.name, 'Name', 80), description: boundedText(value?.description ?? '', 'Description', 300, true), body: boundedText(value?.body, 'Skill steps', 20000),resources:resources(value?.resources??{}),locked:!!value?.locked,pinned:!!value?.pinned,managed:value?.managed!==false,scope:value?.scope??'private',projectId:value?.projectId??value?.project_id??null };
}
function view(s: any): SkillView { return { id: s.id, botId: s.bot_id, name: s.name, description: s.description, body: s.body, revision: s.revision, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at, deleted: s.deleted_at !== null,resources:JSON.parse(s.resources??'{}'),locked:!!s.locked,pinned:!!s.pinned,managed:!!s.managed,scope:s.scope??'private',projectId:s.project_id??null,lastUsedAt:s.last_used_at??null }; }
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
function append(skill: any, value: SkillContent, action: string, actor: string, evidence: MessageRef[] = [], runId: string | null = null, deleted = false) {
  assertWritable(actor,skill.bot_id);
  const revision = skill.revision + 1; const at = now();
  db.prepare('INSERT INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,evidence,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(skill.id, skill.bot_id, revision, JSON.stringify({ ...value, deleted }), action, actor, JSON.stringify(evidence), runId, at);
  db.prepare('UPDATE skills SET name=?,description=?,body=?,revision=?,deleted_at=?,updated_at=? WHERE id=?')
    .run(value.name, value.description, value.body, revision, deleted ? at : null, at, skill.id);
  db.prepare('UPDATE skills SET resources=?,locked=?,pinned=?,managed=?,scope=?,project_id=?,lifecycle=? WHERE id=?').run(JSON.stringify(value.resources??{}),Number(value.locked??!!skill.locked),Number(value.pinned??!!skill.pinned),Number(value.managed??!!skill.managed),value.scope??skill.scope??'private',value.projectId??null,deleted?'archived':'active',skill.id);
  return view(ownSkill(actor, skill.id));
}
function create(userId: string, botId: string, id: string, value: SkillContent, evidence: MessageRef[] = [], runId: string | null = null) {
  assertWritable(userId,botId);const at = now();
  db.prepare('INSERT INTO skills(id,bot_id,name,description,body,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    .run(id, botId, value.name, value.description, value.body, at, at);
  db.prepare('UPDATE skills SET resources=?,locked=?,pinned=?,managed=?,scope=?,project_id=? WHERE id=?').run(JSON.stringify(value.resources??{}),Number(value.locked??false),Number(value.pinned??false),Number(value.managed??true),value.scope??'private',value.projectId??null,id);
  db.prepare('INSERT INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,evidence,run_id,created_at) VALUES(?,?,1,?,?,?,?,?,?)')
    .run(id, botId, JSON.stringify({ ...value, deleted: false }), 'create', userId, JSON.stringify(evidence), runId, at);
  return view(ownSkill(userId, id));
}
export function createSkill(userId: string, botId: string, value: SkillContent): SkillView {
  return db.transaction(() => { ownedBot(userId, botId); return create(userId, botId, newId('skl'), content(value)); })();
}
export function updateSkill(userId: string, id: string, value: Partial<SkillContent>, expected: number): SkillView {
  return db.transaction(() => {
    const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected);
    if (cur.deleted_at !== null) throw new KnowledgeError('Skill is deleted; restore it from history', 409);
    return append(cur, content({ ...view(cur), ...value }), 'edit', userId);
  })();
}
export function deleteSkill(userId: string, id: string, expected: number): SkillView {
  return db.transaction(() => { const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected); return append(cur, content(view(cur)), 'delete', userId, [], null, true); })();
}
export function listSkillHistory(userId: string, id: string) {
  ownSkill(userId, id);
  return (db.prepare('SELECT * FROM knowledge_skill_revisions WHERE skill_id=? ORDER BY revision DESC LIMIT 100').all(id) as any[])
    .map(r => ({ skillId: r.skill_id, revision: r.revision, ...JSON.parse(r.snapshot), action: r.action, actor: r.actor, evidence: JSON.parse(r.evidence), runId: r.run_id, createdAt: r.created_at }));
}
export function rollbackSkill(userId: string, id: string, targetRevision: number, expected: number): SkillView {
  return db.transaction(() => {
    const cur = ownSkill(userId, id); expectedRevision(cur.revision, expected);
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) throw new KnowledgeError('Invalid target revision');
    const target = db.prepare('SELECT * FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(id, targetRevision) as any;
    if (!target) throw new KnowledgeError('Revision not found', 404);
    const saved = JSON.parse(target.snapshot);
    return append(cur, content(saved), `rollback:${targetRevision}`, userId, JSON.parse(target.evidence), target.run_id, saved.deleted);
  })();
}
function render(value: SkillContent | null) { return value ? `# ${value.name}\n${value.description}\n\n${value.body}\n` : ''; }
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
    expectedRevision(cur?.revision ?? 0, input.expectedRevision);
    const value = content(input.content); const reason = boundedText(input.reason, 'Reason', 1000);
    const evidence = refsOnly(validateEvidence(userId, botId, input.evidence));
    const runId = checkedRun(userId, botId, input.runId); const id = newId('skp'); const skillId = cur?.id ?? newId('skl');
    db.prepare('INSERT INTO knowledge_skill_proposals(id,bot_id,skill_id,base_revision,generation,snapshot,reason,evidence,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, botId, skillId, input.expectedRevision, bot.generation, JSON.stringify(value), reason, JSON.stringify(evidence), runId, now());
    return { id, skillId, baseRevision: input.expectedRevision, status: 'pending', diff: skillDiff(cur, value) };
  })();
}
export function listSkillProposals(userId: string, botId: string) {
  ownedBot(userId, botId);
  return (db.prepare("SELECT * FROM knowledge_skill_proposals WHERE bot_id=? ORDER BY created_at DESC,id DESC LIMIT 100").all(botId) as any[]).map(p => {
    const base = p.base_revision ? db.prepare('SELECT snapshot FROM knowledge_skill_revisions WHERE skill_id=? AND revision=?').get(p.skill_id, p.base_revision) as any : null;
    return { id: p.id, skillId: p.skill_id, baseRevision: p.base_revision, content: JSON.parse(p.snapshot), reason: p.reason, evidence: JSON.parse(p.evidence), runId: p.run_id, status: p.status, createdAt: p.created_at, diff: skillDiff(base ? JSON.parse(base.snapshot) : null, JSON.parse(p.snapshot)) };
  });
}
export function resolveSkillProposal(userId: string, id: string, decision: 'approve' | 'reject', expectedBaseRevision: number) {
  return db.transaction(() => {
    const p = db.prepare('SELECT p.* FROM knowledge_skill_proposals p JOIN bots b ON b.id=p.bot_id WHERE p.id=? AND b.user_id=?').get(id, userId) as any;
    if (!p) throw new KnowledgeError('Not found', 404);
    assertWritable(userId,p.bot_id);expectedRevision(p.base_revision, expectedBaseRevision);
    if (p.status !== 'pending') throw new KnowledgeError('Proposal has already been reviewed', 409);
    if (!['approve', 'reject'].includes(decision)) throw new KnowledgeError('Invalid review decision');
    let skill: SkillView | undefined;
    if (decision === 'approve') {
      const bot = ownedBot(userId, p.bot_id);
      if (bot.generation !== p.generation) throw new KnowledgeError('Conversation changed; ask for a fresh proposal', 409);
      const evidence = refsOnly(validateEvidence(userId, p.bot_id, JSON.parse(p.evidence)));
      checkedRun(userId, p.bot_id, p.run_id);
      const cur = db.prepare('SELECT * FROM skills WHERE id=? AND bot_id=?').get(p.skill_id, p.bot_id) as any;
      expectedRevision(cur?.revision ?? 0, p.base_revision);
      skill = cur ? append(cur, content(JSON.parse(p.snapshot)), 'learned', userId, evidence, p.run_id) : create(userId, p.bot_id, p.skill_id, content(JSON.parse(p.snapshot)), evidence, p.run_id);
    }
    db.prepare('UPDATE knowledge_skill_proposals SET status=?,resolved_at=?,resolved_by=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected', now(), userId, id);
    return { status: decision === 'approve' ? 'approved' : 'rejected', skill };
  })();
}
export function skillIndexForPrompt(botId: string, budget = 4000): string {
  const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
  if (!bot) return '';
  let used = 0;
  const lines = listSkills(bot.user_id, botId).flatMap(s => { const line = `- ${s.id} (revision ${s.revision}): ${s.name} — ${s.description || 'Read for instructions.'}`; if (used + line.length > budget) return []; used += line.length; return [line]; });
  return lines.length ? `Available skills (metadata only). Use read_skill to load a skill before following it.\n${lines.join('\n')}` : '';
}

export function authorizedSkills(userId:string,botId:string):SkillView[] {
 ownedBot(userId,botId);
 return (db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=? AND s.deleted_at IS NULL ORDER BY s.created_at,s.id').all(userId) as any[]).filter(s=>canRead(userId,botId,'skills',s)).map(view);
}
export function readSkillForBot(userId:string,botId:string,id:string,opts:{jobId?:string;filePath?:string;review?:boolean}={}) {
 const row=ownSkill(userId,id);if(row.deleted_at!==null||!canRead(userId,botId,'skills',row))throw new KnowledgeError('Not found',404);
 const skill=view(row);const path=opts.filePath??'';
 const text=path ? skill.resources[path] : skill.body;
 if(text===undefined)throw new KnowledgeError('Supporting file not found',404);
 recordRead(userId,botId,'skill',id,skill.revision,text,opts.jobId,path);
 // Review reads do not make unused skills look useful to the curator.
 if(!opts.review&&!managementContext()?.unattended) db.prepare("UPDATE skills SET last_used_at=?,lifecycle='active' WHERE id=?").run(now(),id);
 return path?{skillId:id,revision:skill.revision,filePath:path,content:text}:{skill};
}
export function setSkillScope(userId:string,id:string,input:{expectedRevision:number;scope:Scope;projectId?:string;botIds?:string[]}) {
 return db.transaction(()=>{const cur=ownSkill(userId,id);expectedRevision(cur.revision,input.expectedRevision);setGrants(userId,cur.bot_id,'skills',id,input.scope,input.projectId,input.botIds);return append(cur,content({...view(cur),scope:input.scope,projectId:input.scope==='project'?input.projectId:null}),'scope',userId);})();
}
export interface SkillMutation { action:'create'|'update'|'patch'|'write_file'|'remove_file'|'delete';skillId?:string;expectedRevision:number;name?:string;description?:string;body?:string;resources?:Record<string,string>;filePath?:string;fileContent?:string;oldText?:string;newText?:string;reason:string;evidence:MessageRef[];runId?:string }
export function manageSkill(userId:string,botId:string,input:SkillMutation) {
 return db.transaction(()=>{
  assertWritable(userId,botId);const ctx=managementContext();
  if(!ctx)throw new KnowledgeError('Management operation requires an execution context',409);
  const cur=input.skillId?ownSkill(userId,input.skillId):null;
  if(cur&&(cur.bot_id!==botId||cur.deleted_at!==null))throw new KnowledgeError('Not found',404);
  expectedRevision(cur?.revision??0,input.expectedRevision);
  if(cur?.locked)throw new KnowledgeError('Skill is locked; do not recreate it under another name',409);
  if(!['create','update','patch','write_file','remove_file','delete'].includes(input.action))throw new KnowledgeError('Invalid skill action');
  if(input.action==='create'&&cur||input.action!=='create'&&!cur)throw new KnowledgeError('Invalid skill target');
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
  next=content(next);const evidence=refsOnly(validateEvidence(userId,botId,input.evidence));const runId=checkedRun(userId,botId,input.runId??ctx.jobId);
  if(learningSettings(userId,botId).settings.skillApproval){
   if(input.action==='delete')throw new KnowledgeError('Archive through owner controls when approval is required',409);
   return {proposal:stageSkillProposal(userId,botId,{skillId:cur?.id,expectedRevision:input.expectedRevision,content:next,reason:input.reason,evidence,runId:runId??undefined}),activated:false};
  }
  const skill=cur?append(cur,next,'learned',userId,evidence,runId,input.action==='delete'):create(userId,botId,newId('skl'),next,evidence,runId);
  return {skill,activated:true};
 })();
}
