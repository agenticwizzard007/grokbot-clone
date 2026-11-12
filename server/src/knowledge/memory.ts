import {publishNativeEvent} from '../native/events.js';
import { assertWritable,canRead,managementContext,setGrants,type Scope } from './access.js';
import { learningSettings } from './settings.js';
import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { boundedText, checkedRun, expectedRevision, KnowledgeError, ownedBot } from './common.js';
import { refsOnly, validateEvidence, isHumanUserMessage, type MessageRef } from './sessions.js';

export interface MemoryView { id: string; botId: string; text: string; createdAt: number; source: 'chat' | 'learned'; status: string; revision: number; evidence: MessageRef[]; runId: string | null; supersedes: string | null; target:'user'|'environment';evidenceKind:'human'|'tool'|'hypothesis';scope:Scope;projectId:string|null }
function view(m: any): MemoryView { return { id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at, source: m.source === 'learned' ? 'learned' : 'chat', status: m.status, revision: m.revision, evidence: JSON.parse(m.evidence), runId: m.run_id, supersedes: m.supersedes,target:m.target??'user',evidenceKind:m.evidence_kind??'human',scope:m.scope??'private',projectId:m.project_id??null }; }
function ownMemory(userId: string, id: string): any {
  const m = db.prepare('SELECT m.* FROM memories m JOIN bots b ON b.id=m.bot_id WHERE m.id=? AND b.user_id=?').get(id, userId);
  if (!m) throw new KnowledgeError('Not found', 404);
  return m;
}
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fingerprint = (s: string) => crypto.createHash('sha256').update(normalize(s)).digest('hex');
export function similar(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const A = new Set(normalize(a).split(' ').filter(w => w.length > 2)), B = new Set(normalize(b).split(' ').filter(w => w.length > 2));
  const inter = [...A].filter(w => B.has(w)).length;
  return Math.min(A.size, B.size) >= 3 && inter / Math.min(A.size, B.size) >= .8;
}
const key = (s: MessageRef) => `${s.botId}:${s.generation}:${s.seq}`;
function isSuppressed(botId: string, text: string, evidence: MessageRef[], checkSources = true): boolean {
  const refs = new Set(evidence.map(key));
  return (db.prepare('SELECT text,evidence FROM knowledge_memory_suppressions WHERE bot_id=?').all(botId) as any[])
    .some(s => similar(text, s.text) || (checkSources && (JSON.parse(s.evidence) as MessageRef[]).some(r => refs.has(key(r)))));
}
export function listMemories(userId: string, botId: string, includeInactive = false): MemoryView[] {
  ownedBot(userId, botId);
  return (db.prepare(`SELECT * FROM memories WHERE bot_id=? ${includeInactive ? '' : "AND status='active'"} ORDER BY created_at DESC,id DESC LIMIT 1000`).all(botId) as any[]).map(view);
}
function record(m: any, action: string, userId: string) {
  db.prepare('INSERT INTO knowledge_memory_events(memory_id,bot_id,action,snapshot,actor,created_at) VALUES(?,?,?,?,?,?)').run(m.id, m.bot_id, action, JSON.stringify(view(m)), managementContext()?`${managementContext()!.actor}:${userId}`:userId, now());
  publishNativeEvent({userId,botId:m.bot_id,kind:'knowledge.memory.changed',sourceType:'memory',sourceId:m.id,sourceRevision:m.revision,data:{action}});
}
function suppress(m: any) {
  db.prepare('INSERT OR IGNORE INTO knowledge_memory_suppressions(bot_id,fingerprint,text,evidence,created_at) VALUES(?,?,?,?,?)').run(m.bot_id, fingerprint(m.text), m.text, m.evidence, now());
}
// Hermes memory write-approval concept (tools/write_approval.py:201-254, MIT,
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898), adapted to native owner-scoped
// sourced facts. Corrections/suppression are Swarm extensions, not Hermes claims.
export function saveMemory(userId: string, botId: string, input: { text: string; evidence: MessageRef[]; source?: 'chat' | 'learned'; runId?: string;target?:'user'|'environment';evidenceKind?:'human'|'tool'|'hypothesis' }): { memory: MemoryView | null; skipped: 'suppressed' | 'duplicate' | null } {
  return db.transaction(() => {
    assertWritable(userId,botId); const text = boundedText(input.text, 'Memory', 1000);
    const validated=validateEvidence(userId,botId,input.evidence);const evidence=refsOnly(validated);
    const target=input.target??'user';if(!['user','environment'].includes(target))throw new KnowledgeError('Invalid memory target');
    const evidenceKind=input.evidenceKind??(validated.some(e=>e.role==='tool')?'tool':'human');
    if(evidenceKind==='hypothesis'||validated.some(e=>e.role!=='tool'&&!isHumanUserMessage(e))||target==='user'&&(!validated.every(e=>isHumanUserMessage(e))||evidenceKind!=='human'))throw new KnowledgeError('User memory requires human evidence; hypotheses are not durable facts',422);
    const runId = checkedRun(userId, botId, input.runId);
    if (isSuppressed(botId, text, evidence)) return { memory: null, skipped: 'suppressed' as const };
    const existing = listMemories(userId, botId).find(m => m.target===target&&similar(m.text, text));
    if (existing) return { memory: existing, skipped: 'duplicate' as const };
    const id = newId('mem');
    db.prepare('INSERT INTO memories(id,bot_id,text,created_at,source,evidence,run_id) VALUES(?,?,?,?,?,?,?)').run(id, botId, text, now(), input.source === 'learned' ? 'learned' : 'chat', JSON.stringify(evidence), runId);
    db.prepare('UPDATE memories SET target=?,evidence_kind=? WHERE id=?').run(target,evidenceKind,id);
    const m = ownMemory(userId, id); record(m, 'create', userId); return { memory: view(m), skipped: null };
  })();
}
export function correctMemory(userId: string, id: string, input: { text: string; expectedRevision: number; evidence?: MessageRef[]; runId?: string }): MemoryView {
  return db.transaction(() => {
    if(managementContext()?.unattended)throw new KnowledgeError('Unattended replacements must stage through manageMemory',409);
    const cur = ownMemory(userId, id);assertWritable(userId,cur.bot_id); expectedRevision(cur.revision, input.expectedRevision);
    if (cur.status !== 'active') throw new KnowledgeError('Memory is no longer active', 409);
    const text = boundedText(input.text, 'Correction', 1000);
    if (normalize(text) === normalize(cur.text)) throw new KnowledgeError('Correction must change the fact');
    const checked=validateEvidence(userId,cur.bot_id,input.evidence??[],false);if(cur.target==='user'&&checked.some(e=>!isHumanUserMessage(e)))throw new KnowledgeError('User memory requires human evidence',422);
    const evidence=refsOnly(checked);
    const runId = checkedRun(userId, cur.bot_id, input.runId);
    // Explicit owner correction may reuse a source and update similar wording;
    // the old statement is suppressed only after the replacement is validated.
    if ((db.prepare('SELECT text FROM knowledge_memory_suppressions WHERE bot_id=?').all(cur.bot_id) as any[]).some(s => normalize(s.text) === normalize(text))) throw new KnowledgeError('This fact was previously forgotten or superseded', 409);
    suppress(cur);
    db.prepare("UPDATE memories SET status='superseded',revision=revision+1 WHERE id=?").run(id);
    record(ownMemory(userId, id), 'supersede', userId);
    const nextId = newId('mem');
    db.prepare('INSERT INTO memories(id,bot_id,text,created_at,source,evidence,run_id,supersedes) VALUES(?,?,?,?,?,?,?,?)').run(nextId, cur.bot_id, text, now(), 'chat', JSON.stringify(evidence), runId, id);
    db.prepare('UPDATE memories SET target=?,evidence_kind=?,scope=?,project_id=? WHERE id=?').run(cur.target,cur.evidence_kind,cur.scope,cur.project_id,nextId);
    db.prepare("UPDATE knowledge_grants SET source_id=? WHERE kind='memories' AND source_id=?").run(nextId,id);
    const next = ownMemory(userId, nextId); record(next, 'correction', userId); return view(next);
  })();
}
export function forgetMemory(userId: string, id: string, expected?: number): void {
  db.transaction(() => {
    if(managementContext()?.unattended)throw new KnowledgeError('Unattended removals must stage through manageMemory',409);
    const cur = ownMemory(userId, id);assertWritable(userId,cur.bot_id);
    if (expected !== undefined) expectedRevision(cur.revision, expected);
    if (cur.status === 'deleted') return;
    // A correction is a chain. Forgetting its replacement suppresses each prior
    // statement too, so archived source messages cannot resurrect any version.
    let node = cur; const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id); suppress(node);
      if (node.id === id) { db.prepare("UPDATE memories SET status='deleted',revision=revision+1 WHERE id=?").run(id); record(ownMemory(userId, id), 'delete', userId); }
      node = node.supersedes ? db.prepare('SELECT * FROM memories WHERE id=? AND bot_id=?').get(node.supersedes, cur.bot_id) : null;
    }
  })();
}
export function memoryHistory(userId: string, id: string) {
  ownMemory(userId, id);
  return (db.prepare('SELECT * FROM knowledge_memory_events WHERE memory_id=? ORDER BY id DESC LIMIT 100').all(id) as any[]).map(e => ({ action: e.action, actor: e.actor, memory: JSON.parse(e.snapshot), createdAt: e.created_at }));
}
export function recallMemories(userId: string, botId: string, query = '', limit = 20): MemoryView[] {
  if (typeof query !== 'string' || query.length > 500) throw new KnowledgeError('Search query must be at most 500 characters');
  const terms = normalize(query).split(' ').filter(Boolean);
  return listMemories(userId, botId).filter(m => terms.every(t => normalize(m.text).includes(t))).slice(0, Math.max(1, Math.min(50, limit)));
}

export function authorizedMemories(userId:string,botId:string):MemoryView[]{
 ownedBot(userId,botId);return(db.prepare("SELECT m.* FROM memories m JOIN bots b ON b.id=m.bot_id WHERE b.user_id=? AND m.status='active' ORDER BY m.created_at DESC,m.id").all(userId) as any[]).filter(m=>canRead(userId,botId,'memories',m)).map(view);
}
export function setMemoryScope(userId:string,id:string,input:{expectedRevision:number;scope:Scope;projectId?:string;botIds?:string[]}){
 return db.transaction(()=>{const cur=ownMemory(userId,id);expectedRevision(cur.revision,input.expectedRevision);if(cur.status!=='active')throw new KnowledgeError('Memory is inactive',409);setGrants(userId,cur.bot_id,'memories',id,input.scope,input.projectId,input.botIds);db.prepare('UPDATE memories SET scope=?,project_id=?,revision=revision+1 WHERE id=?').run(input.scope,input.scope==='project'?input.projectId:null,id);const next=ownMemory(userId,id);record(next,'scope',userId);return view(next);})();
}
export interface MemoryMutation {action:'add'|'replace'|'remove';memoryId?:string;expectedRevision:number;text?:string;target?:'user'|'environment';evidence:MessageRef[];runId?:string;evidenceKind?:'human'|'tool'|'hypothesis'}
export function stageMemoryChange(userId:string,botId:string,input:MemoryMutation){
 return db.transaction(()=>{
  assertWritable(userId,botId);const bot=ownedBot(userId,botId);const cur=input.memoryId?ownMemory(userId,input.memoryId):null;
  if(cur&&(cur.bot_id!==botId||cur.status!=='active'))throw new KnowledgeError('Memory not active in this agent',404);
  if(!['add','replace','remove'].includes(input.action)||input.action!=='add'&&!cur||input.action==='add'&&cur)throw new KnowledgeError('Invalid memory action');
  expectedRevision(cur?.revision??0,input.expectedRevision);
  const evidence=refsOnly(validateEvidence(userId,botId,input.evidence,input.action!=='remove'));
  if(cur&&input.target!==undefined&&input.target!==cur.target)throw new KnowledgeError('Replacement must keep its memory target',409);
  const text=input.action==='remove'?null:boundedText(input.text,'Memory',1000);const target=input.target??cur?.target??'user';
  if(!['user','environment'].includes(target))throw new KnowledgeError('Invalid target');
  if(target==='user'&&validateEvidence(userId,botId,evidence,false).some(e=>!isHumanUserMessage(e)))throw new KnowledgeError('User memory requires human evidence',422);
  checkedRun(userId,botId,input.runId);
  const id=newId('mch');db.prepare('INSERT INTO knowledge_memory_changes(id,user_id,bot_id,memory_id,base_revision,generation,action,text,target,evidence,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,botId,cur?.id??null,input.expectedRevision,bot.generation,input.action,text,target,JSON.stringify(evidence),input.runId??null,now());
  publishNativeEvent({userId,botId,kind:'knowledge.memory.proposed',sourceType:'memory-change',sourceId:id,jobId:input.runId,data:{action:input.action}});
  return listMemoryChanges(userId,botId).find(c=>c.id===id)!;
 })();
}
export function listMemoryChanges(userId:string,botId:string){ownedBot(userId,botId);return(db.prepare('SELECT * FROM knowledge_memory_changes WHERE bot_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 1000').all(botId,userId)as any[]).map(c=>({id:c.id,botId:c.bot_id,memoryId:c.memory_id,baseRevision:c.base_revision,generation:c.generation,action:c.action,text:c.text,target:c.target,evidence:JSON.parse(c.evidence),runId:c.run_id,status:c.status,createdAt:c.created_at,resolvedAt:c.resolved_at}));}
export function resolveMemoryChange(userId:string,id:string,decision:'approve'|'reject',expectedBaseRevision:number){
 return db.transaction(()=>{
  const p=db.prepare('SELECT * FROM knowledge_memory_changes WHERE id=? AND user_id=?').get(id,userId)as any;if(!p)throw new KnowledgeError('Not found',404);
  assertWritable(userId,p.bot_id);expectedRevision(p.base_revision,expectedBaseRevision);if(p.status!=='pending')throw new KnowledgeError('Change already reviewed',409);if(!['approve','reject'].includes(decision))throw new KnowledgeError('Invalid decision');
  let memory:MemoryView|null=null;
  if(decision==='approve'){
   const bot=ownedBot(userId,p.bot_id);if(bot.generation!==p.generation)throw new KnowledgeError('Conversation changed; request a fresh change',409);
   const evidence=refsOnly(validateEvidence(userId,p.bot_id,JSON.parse(p.evidence),p.action!=='remove'));checkedRun(userId,p.bot_id,p.run_id);
   if(p.memory_id)expectedRevision(ownMemory(userId,p.memory_id).revision,p.base_revision);
   if(p.action==='remove')forgetMemory(userId,p.memory_id,p.base_revision);
   else if(p.action==='replace')memory=correctMemory(userId,p.memory_id,{text:p.text,expectedRevision:p.base_revision,evidence,runId:p.run_id});
   else memory=saveMemory(userId,p.bot_id,{text:p.text,evidence,target:p.target,runId:p.run_id}).memory;
  }
  db.prepare('UPDATE knowledge_memory_changes SET status=?,resolved_at=? WHERE id=?').run(decision==='approve'?'approved':'rejected',now(),id);
  publishNativeEvent({userId,botId:p.bot_id,kind:'knowledge.memory.change-reviewed',sourceType:'memory-change',sourceId:id,data:{decision}});
  return {status:decision==='approve'?'approved':'rejected',memory};
 })();
}
export function manageMemory(userId:string,botId:string,input:MemoryMutation){
 return db.transaction(()=>{
  assertWritable(userId,botId);const ctx=managementContext();const bot=ownedBot(userId,botId);
  const cur=input.memoryId?ownMemory(userId,input.memoryId):null;
  if(cur&&(cur.bot_id!==botId||cur.status!=='active'))throw new KnowledgeError('Memory not active in this agent',404);
  if(!['add','replace','remove'].includes(input.action)||input.action!=='add'&&!cur||input.action==='add'&&cur)throw new KnowledgeError('Invalid memory action');
  expectedRevision(cur?.revision??0,input.expectedRevision);
  if(cur&&input.target!==undefined&&input.target!==cur.target)throw new KnowledgeError('Replacement must keep its memory target',409);
  validateEvidence(userId,bot.id,input.evidence,input.action!=='remove');
  if(ctx?.unattended&&input.action!=='add')return{change:stageMemoryChange(userId,botId,input),activated:false};
  if(input.action==='remove'){forgetMemory(userId,cur.id,input.expectedRevision);return{deleted:true,activated:true};}
  if(input.action==='replace')return{memory:correctMemory(userId,cur.id,{text:input.text!,expectedRevision:input.expectedRevision,evidence:input.evidence,runId:input.runId}),activated:true};
  return {...saveMemory(userId,botId,{...input,text:input.text!,source:ctx&&ctx.actor!=='foreground'?'learned':'chat'}),activated:true};
 })();
}
/** Passive extraction recognizes changed high-overlap facts instead of treating
 * changed values/negations as duplicates. Only exact normalized facts dedupe. */
export function learnMemory(userId:string,botId:string,input:{text:string;evidence:MessageRef[];runId?:string;target?:'user'|'environment';replacesMemoryId?:string}){
 const text=boundedText(input.text,'Memory',1000);const current=listMemories(userId,botId).filter(m=>m.target===(input.target??'user'));
 if(current.some(m=>normalize(m.text)===normalize(text)))return{memory:null,skipped:'duplicate'};
 const prior=input.replacesMemoryId?current.find(m=>m.id===input.replacesMemoryId):current.find(m=>similar(m.text,text));
 if(input.replacesMemoryId&&!prior)throw new KnowledgeError('Correction target is no longer active',409);
 if(prior){const pending=listMemoryChanges(userId,botId).find(c=>c.status==='pending'&&c.memoryId===prior.id&&normalize(c.text??'')===normalize(text));return{change:pending??stageMemoryChange(userId,botId,{action:'replace',memoryId:prior.id,expectedRevision:prior.revision,...input}),skipped:null};}
 return saveMemory(userId,botId,{...input,source:'learned'});
}
