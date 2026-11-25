import { plural } from '../lib/plural.js';
import './schema.js';
import { db, now } from '../db.js';
import { newId, sha256 } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen, legacyWorkHeld } from '../security/legacy-work.js';
import { publishNativeEvent, latestNativeEventSeq } from '../native/events.js';
import { recordArtifact, readArtifact } from '../deliverables/artifacts.js';
import { getDelivery, getDeliveryTarget, targetIdentity, requestDelivery, retryDelivery, sendDelivery } from '../deliverables/delivery.js';
import { ownerAlive, ownerBirth } from '../deliverables/ownership.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';

const exists = (table:string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export const REPORT_PAGE_SIZE = 100;
export const NARRATIVE_TIMEOUT_MS = 120_000;
export interface ReportSource { id:string; revision:string; kind:string; state:string; title:string; owner:string|null; details:string; changed:boolean }
interface SourceRow { id:string; kind:string; state:string; title:string; owner?:string|null; details?:string|null }

/** Project operational facts, never prompts, private memory contents or transcript text.
 * Each query reads every matching row in bounded keyset pages. No recent-N cap can hide an old open blocker.
 * Missing optional domains are disclosed in the frozen report, not treated as empty.
 */
function observe(userId:string,from:number,through:number,emit:(s:ReportSource)=>void) {
 const gaps:string[]=[];let abbreviated=0;
 const scan=(table:string,sql:string,args:unknown[]=[])=>{
  if(!exists(table)){gaps.push(`${table}: unavailable`);return;}
  const query=db.prepare(`SELECT * FROM (${sql}) WHERE id>? ORDER BY id LIMIT 200`);let after='';
  while(true){const rows=query.all(...args,after) as SourceRow[];if(!rows.length)break;
  for(const r of rows) {
   const full=JSON.stringify([r.kind,r.state,r.title,r.owner??null,r.details??'']);
   const details=String(r.details??'');
   if(details.length>2000||String(r.title??'').length>240)abbreviated++;
   emit({id:r.id,revision:sha256(full),kind:r.kind,state:r.state,title:String(r.title??r.id).slice(0,240),owner:r.owner??null,
    details:(details.length>2000?details.slice(0,2000)+' [details abbreviated; inspect canonical record]':details)+(String(r.title??'').length>240?' [title abbreviated; inspect canonical record]':''),changed:false});
  }
  after=rows.at(-1)!.id;if(rows.length<200)break;
  }
 };
 scan('routines',`SELECT 'routine:'||r.id id,'routine' kind,CASE WHEN r.enabled THEN 'enabled' ELSE 'disabled' END state,r.name title,b.name owner,
 json_object('schedule',r.schedule,'timezone',r.timezone,'lastRunAt',r.last_run_at) details FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.id`,[userId]);
 scan('bot_setups',`SELECT 'coworker:'||b.id id,'coworker' kind,COALESCE(s.onboarding_status,'unavailable') state,b.name title,b.name owner,
 json_object('setupRevision',s.revision,'lastVerifiedAt',s.updated_at,'executionHealth','not inferred from setup') details
 FROM bots b LEFT JOIN bot_setups s ON s.bot_id=b.id WHERE b.user_id=? AND COALESCE(b.hidden,0)=0 AND COALESCE(b.kind,'agent')!='room' AND b.parent_bot_id IS NULL ORDER BY b.id`,[userId]);
 scan('native_workflows',`SELECT 'workflow:'||w.id id,'workflow' kind,w.status state,w.title,b.name owner,w.reason details
 FROM native_workflows w JOIN bots b ON b.id=w.bot_id AND b.user_id=w.user_id WHERE w.user_id=? AND (w.status NOT IN ('completed','cancelled') OR w.updated_at>=?) ORDER BY w.id`,[userId,from]);
 scan('native_workflow_tasks',`SELECT 'task:'||t.task_id id,'task' kind,t.status state,k.title,b.name owner,
 json_object('reason',t.reason,'accepted',t.result_validated,'evidence',json(t.evidence),'workflowId',t.workflow_id,'nextAction',CASE WHEN t.status='ready' THEN 'ready for owner' ELSE t.status END) details
 FROM native_workflow_tasks t JOIN native_workflows w ON w.id=t.workflow_id JOIN tasks k ON k.id=t.task_id
 LEFT JOIN bots b ON b.id=COALESCE(t.worker_bot_id,t.assigned_bot_id,w.bot_id) AND b.user_id=w.user_id
 WHERE w.user_id=? AND (t.status NOT IN ('completed','cancelled') OR w.updated_at>=?) ORDER BY t.task_id`,[userId,from]);
 scan('native_goals',`SELECT 'goal:'||g.id id,'goal' kind,g.status state,g.title,b.name owner,g.reason details FROM native_goals g JOIN bots b ON b.id=g.bot_id AND b.user_id=g.user_id
 WHERE g.user_id=? AND (g.status NOT IN ('completed','cancelled') OR g.updated_at>=?) ORDER BY g.id`,[userId,from]);
 scan('agent_jobs',`SELECT 'job:'||j.id id,'job' kind,j.state state,'Execution '||j.id title,b.name owner,
 json_object('triggerType',json_extract(j.trigger,'$.type'),'lastVerifiedAt',COALESCE(j.finished_at,j.started_at,j.created_at),'acceptance','not inferred from execution status') details
 FROM agent_jobs j JOIN bots b ON b.id=j.bot_id AND b.user_id=j.user_id WHERE j.user_id=?
 AND (j.state IN ('queued','running','uncertain') OR COALESCE(j.finished_at,j.created_at)>=?) ORDER BY j.id`,[userId,from]);
 scan('routine_executions',`SELECT 'run:'||r.id id,'run' kind,r.status state,r.routine_name title,b.name owner,r.error details
 FROM routine_executions r JOIN bots b ON b.id=r.bot_id AND b.user_id=r.user_id WHERE r.user_id=? AND (r.created_at>=? OR COALESCE(r.finished_at,0)>=? OR r.status IN ('queued','running','waiting','failed','unknown')) ORDER BY r.id`,[userId,from,from]);
 scan('output_artifacts',`SELECT 'artifact:'||a.id id,'artifact' kind,'available' state,a.filename title,b.name owner,
 json_object('sha256',a.sha256,'url','/api/deliverables/artifacts/'||a.id||'/download','acceptance','not inferred from availability') details
 FROM output_artifacts a JOIN bots b ON b.id=a.bot_id AND b.user_id=a.user_id WHERE a.user_id=? AND a.created_at>=?
 AND NOT EXISTS(SELECT 1 FROM coordination_synopses s WHERE s.artifact_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM coordination_synopsis_pages p WHERE p.artifact_id=a.id) ORDER BY a.id`,[userId,from]);
 scan('artifact_deliveries',`SELECT 'delivery:'||d.id id,'delivery' kind,d.status state,a.filename||' via '||d.channel title,b.name owner,
 json_object('artifactId',a.id,'artifactSha256',a.sha256,'channel',d.channel,'error',d.error,'acknowledgement',CASE WHEN d.status!='delivered' THEN NULL WHEN d.channel='library' THEN 'library availability only' ELSE 'provider or owner receipt; not proof of reading' END) details
 FROM artifact_deliveries d JOIN output_artifacts a ON a.id=d.artifact_id AND a.user_id=d.user_id JOIN bots b ON b.id=a.bot_id AND b.user_id=d.user_id
 WHERE d.user_id=? AND (d.updated_at>=? OR d.status!='delivered')
 AND NOT EXISTS(SELECT 1 FROM coordination_synopses s WHERE s.artifact_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM coordination_synopsis_pages p WHERE p.artifact_id=a.id) ORDER BY d.id`,[userId,from]);
 scan('coordination_requests',`SELECT 'request:'||r.id id,'request' kind,r.status state,'Internal '||r.kind title,b.name owner,r.reason details
 FROM coordination_requests r JOIN bots b ON b.id=r.to_bot_id AND b.user_id=r.user_id WHERE r.user_id=? AND (r.updated_at>=? OR r.status!='completed') ORDER BY r.seq`,[userId,from]);
 scan('rows',`SELECT 'decision:'||b.id||':'||r.generation||':'||r.seq id,'decision' kind,'pending' state,COALESCE(json_extract(r.body,'$.title'),'Decision required') title,b.name owner,
 json_object('card',json_extract(r.body,'$.card'),'lastVerifiedAt',r.created_at) details FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
 WHERE b.user_id=? AND r.kind='card' AND json_extract(r.body,'$.card') IN ('question','approval','connect') AND json_extract(r.body,'$.status')='pending' ORDER BY b.id,r.seq`,[userId]);
 scan('approvals',`SELECT 'approval:'||a.id id,'decision' kind,'pending' state,'Approval required' title,b.name owner,
 json_object('tool',a.tool,'lastVerifiedAt',a.created_at) details FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? AND a.status='pending' ORDER BY a.id`,[userId]);
 scan('knowledge_memory_events',`SELECT 'learning:memory:'||e.id id,'learning' kind,e.action state,'Memory learning change' title,b.name owner,
 json_object('memoryId',e.memory_id,'recordedAt',e.created_at,'actor',e.actor) details FROM knowledge_memory_events e JOIN bots b ON b.id=e.bot_id WHERE b.user_id=? AND e.created_at>=? AND e.created_at<=? ORDER BY e.id`,[userId,from,through]);
 scan('knowledge_skill_revisions',`SELECT 'learning:skill:'||s.skill_id||':'||s.revision id,'learning' kind,s.action state,'Skill learning revision' title,b.name owner,
 json_object('skillId',s.skill_id,'revision',s.revision,'recordedAt',s.created_at,'actor',s.actor) details FROM knowledge_skill_revisions s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=? AND s.created_at>=? AND s.created_at<=? ORDER BY s.skill_id,s.revision`,[userId,from,through]);
 if(abbreviated)gaps.push(`${abbreviated} source observations contain abbreviated titles or details. Source references identify the original revisions; full detail is not preserved in this report projection.`);
 const reviewed=(db.prepare("SELECT seq FROM native_consumer_cursors WHERE user_id=? AND consumer='coordination-human-reviewed'").get(userId) as {seq:number}|undefined)?.seq??0;
 const pending=db.prepare("SELECT COUNT(*) count,MAX(seq) through FROM native_events WHERE user_id=? AND kind='coordination.human_source' AND seq>?").get(userId,reviewed) as {count:number;through:number|null};
 if(pending.count)gaps.push(`${plural(pending.count, 'human conversation source revision')} ${pending.count === 1 ? 'awaits' : 'await'} coordinator review (reviewed through event ${reviewed}; pending through event ${pending.through}). Current user changes may not yet be reflected in operational records. Source text is not included in this report.`);
 const supervision=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(userId) as any;
 if(!supervision?.last_tick_at||through-supervision.last_tick_at>120000||supervision.last_error)gaps.push(`Coordination runtime observation is ${supervision?.last_error?'degraded':supervision?.last_tick_at?'stale':'unavailable'}; last verified tick: ${supervision?.last_tick_at?new Date(supervision.last_tick_at).toISOString():'none'}. Coworker setup and execution states above are last verified records, not a live availability check.`);
 gaps.push('Current canonical states were observed at the snapshot time; intermediate transitions before the watermark may be unavailable. No live coworker/provider poll was required. Unstructured deadline commitments are not inferred.');
 return gaps;
}

function reportRow(userId:string,id:string):any {
 assertTenant(userId);
 const r=db.prepare('SELECT * FROM coordination_synopses WHERE id=? AND user_id=?').get(id,userId);
 if(!r)throw new Error('Report not found.');return r;
}
export function reportSourcePage(userId:string,id:string,after=0,limit=REPORT_PAGE_SIZE) {
 reportRow(userId,id);limit=Math.max(1,Math.min(REPORT_PAGE_SIZE,Math.trunc(limit)||REPORT_PAGE_SIZE));
 const rows=db.prepare('SELECT * FROM coordination_synopsis_sources WHERE report_id=? AND user_id=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(id,userId,Math.max(0,after),limit+1) as any[];
 return {sources:rows.slice(0,limit).map(s=>({ordinal:s.ordinal,id:s.source_id,revision:s.revision,kind:s.kind,state:s.state,title:s.title,owner:s.owner,details:s.details,changed:!!s.changed})),hasMore:rows.length>limit,nextCursor:rows.slice(0,limit).at(-1)?.ordinal??after};
}
function summarySources(userId:string,id:string):ReportSource[] {
 return (db.prepare(`SELECT * FROM coordination_synopsis_sources WHERE user_id=? AND report_id=? ORDER BY
 CASE WHEN kind='decision' THEN 0 WHEN state IN ('blocked','failed','unknown','uncertain','waiting','unavailable') THEN 1
 WHEN kind IN ('workflow','goal','task') THEN 2 ELSE 3 END,ordinal LIMIT ?`).all(userId,id,REPORT_PAGE_SIZE) as any[])
 .map(s=>({id:s.source_id,revision:s.revision,kind:s.kind,state:s.state,title:s.title,owner:s.owner,details:s.details,changed:!!s.changed}));
}
export function getSynopsis(userId:string,id:string) {
 const r=reportRow(userId,id),delivery=r.delivery_id?getDelivery(userId,r.delivery_id):null;
 return {id:r.id,seq:r.seq,slotKey:r.slot_key,firstSlot:r.first_slot,slotCount:r.slot_count,timezone:r.timezone,
  windowStart:r.window_start,windowEnd:r.window_end,sourceFrom:r.source_from,sourceThrough:r.source_through,observedAt:r.observed_at,
  sourceCount:r.source_count,changedCount:r.changed_count,gaps:JSON.parse(r.gaps),destination:JSON.parse(r.destination),status:r.status,
  content:r.content,sha256:r.content_sha256,generationNote:r.generation_note,artifactId:r.artifact_id,delivery,
  coverage:{snapshotComplete:true,historyComplete:false,summaryComplete:r.source_count<=REPORT_PAGE_SIZE,pages:Math.ceil(r.source_count/REPORT_PAGE_SIZE),pageSize:REPORT_PAGE_SIZE},
  pages:db.prepare('SELECT page,artifact_id AS artifactId FROM coordination_synopsis_pages WHERE report_id=? ORDER BY page').all(id),lastError:r.last_error};
}
export function listSynopses(userId:string,after=0,limit=20) {
 assertTenant(userId);limit=Math.max(1,Math.min(50,Math.trunc(limit)||20));
 const rows=db.prepare('SELECT id,seq FROM coordination_synopses WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?').all(userId,Math.max(0,after),limit+1) as any[];
 return {reports:rows.slice(0,limit).map(r=>{const {content,pages,...metadata}=getSynopsis(userId,r.id);return metadata;}),hasMore:rows.length>limit,nextCursor:rows.slice(0,limit).at(-1)?.seq??after,
  cursors:db.prepare('SELECT * FROM coordination_report_cursors WHERE user_id=?').get(userId)??null};
}

/** Freeze source values, revisions, boundaries, destination and schedule identity atomically. */
export function createSynopsis(input:{userId:string;botId:string;slotKey:string;firstSlot?:string;slotCount?:number;timezone:string;time?:number}) {
 assertTenant(input.userId);assertLegacyWorkOpen(input.userId);
 return db.transaction(()=>{
 const prior=db.prepare('SELECT id FROM coordination_synopses WHERE user_id=? AND slot_key=?').get(input.userId,input.slotKey) as any;if(prior)return prior.id as string;
 if(!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(input.botId,input.userId))throw new Error('Report owner not found.');
 if(db.prepare("SELECT 1 FROM coordination_synopses WHERE user_id=? AND status='preparing'").get(input.userId))throw new Error('Previous report is still materializing.');
 const at=input.time??now(),id=newId('synopsis');
 db.prepare('INSERT OR IGNORE INTO coordination_report_cursors(user_id) VALUES(?)').run(input.userId);
 const cursor=db.prepare('SELECT * FROM coordination_report_cursors WHERE user_id=?').get(input.userId) as any;
 // Never move a report cursor backwards, even across a wall-clock correction.
 const through=Math.max(at,cursor.materialized_through),seq=latestNativeEventSeq(input.userId);
 db.prepare(`INSERT INTO coordination_synopses(id,user_id,bot_id,slot_key,first_slot,slot_count,timezone,window_start,window_end,source_from,source_through,observed_at,destination,gaps,generation_deadline,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.userId,input.botId,input.slotKey,input.firstSlot??input.slotKey,input.slotCount??1,input.timezone,cursor.materialized_through,through,cursor.materialized_seq,seq,at,JSON.stringify({channel:'library'}),'[]',at+NARRATIVE_TIMEOUT_MS,at);
 let count=0,changed=0;
 const insert=db.prepare('INSERT INTO coordination_synopsis_sources(report_id,user_id,ordinal,source_id,revision,kind,state,title,owner,details,changed) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 const previous=db.prepare(`SELECT s.revision FROM coordination_synopsis_sources s JOIN coordination_synopses r ON r.id=s.report_id
 WHERE r.user_id=? AND r.seq<(SELECT seq FROM coordination_synopses WHERE id=?) AND s.source_id=? ORDER BY r.seq DESC LIMIT 1`);
 const gaps=observe(input.userId,cursor.materialized_through,through,s=>{
  s.changed=(previous.get(input.userId,id,s.id) as any)?.revision!==s.revision;if(s.changed)changed++;
  insert.run(id,input.userId,++count,s.id,s.revision,s.kind,s.state,s.title,s.owner,s.details,s.changed?1:0);
 });
 db.prepare("UPDATE coordination_synopses SET source_count=?,changed_count=?,gaps=?,status='preparing' WHERE id=?").run(count,changed,JSON.stringify(gaps),id);
 return id;
 })();
}

export type SynopsisNarrator=(input:{report:ReturnType<typeof getSynopsis>;sources:ReportSource[];signal:AbortSignal})=>Promise<string>;
let narrator:SynopsisNarrator|undefined;
export function configureSynopsisNarrator(value?:SynopsisNarrator) {narrator=value;}
const line=(s:ReportSource)=>`- ${s.kind}: ${s.kind==='artifact'?`[${s.title.replace(/[\r\n\[\]]/g,' ')}](/api/deliverables/artifacts/${encodeURIComponent(s.id.slice('artifact:'.length))}/download)`:s.title.replace(/[\r\n]/g,' ')} — ${s.state}; owner: ${s.owner??'unassigned'}. ${s.details.replace(/[\r\n]/g,' ')}\n  Source: ${s.id}@${s.revision}`;
function header(r:any) {
 return `# Quinn daily synopsis\n\nSlot: ${r.slot_key}; timezone: ${r.timezone}. ${r.slot_count>1?`Catch-up combines ${r.slot_count} slots from ${r.first_slot}.`:''}\nCoverage: ${new Date(r.window_start).toISOString()} through ${new Date(r.window_end).toISOString()}. Observed: ${new Date(r.observed_at).toISOString()}.\nSource watermark: (${r.source_from}, ${r.source_through}]. Destination snapshot: ${r.destination}.\n\n`;
}
function template(r:any) {
 const first=summarySources(r.user_id,r.id);
 const sections:Array<[string,(s:ReportSource)=>boolean]>=[
  ['Accepted outcomes and artifacts',s=>s.kind==='artifact'||s.kind==='delivery'||s.kind==='task'&&s.state==='completed'],
  ['Ongoing work and ownership',s=>['coworker','workflow','goal','job','run','request'].includes(s.kind)&&!['completed','cancelled'].includes(s.state)],
  ['Execution outcomes (not acceptance)',s=>['job','run','request'].includes(s.kind)&&['completed','cancelled'].includes(s.state)],
  ['Material blockers, uncertainty and deadline risks',s=>['blocked','failed','unknown','uncertain','waiting','unavailable'].includes(s.state)],
  ['Decisions required',s=>s.kind==='decision'],['Next planned actions',s=>s.kind==='routine'||s.kind==='task'&&s.state!=='completed'],
  ['Learning improvements',s=>s.kind==='learning']];
 let content=header(r)+(r.changed_count?`${r.changed_count} new or changed observed source revisions.\n\n`:'No changes in the observed source revisions. Current open work remains below.\n\n');
 for(const [title,filter] of sections)content+=`## ${title}\n\n${first.filter(filter).map(line).join('\n')||'No matching observations on this summary page.'}\n\n`;
 const pages=db.prepare('SELECT page,artifact_id FROM coordination_synopsis_pages WHERE report_id=? ORDER BY page').all(r.id) as any[];
 content+=`## Coverage and saved source pages\n\n${r.source_count} frozen observations. The summary displays at most ${REPORT_PAGE_SIZE}; ${r.source_count>REPORT_PAGE_SIZE?'summary coverage is partial; read ALL saved pages for complete snapshot coverage.':'the summary includes all source observations.'}\n`;
 for(const p of pages)content+=`- [Source page ${p.page}](/api/deliverables/artifacts/${p.artifact_id}/download)\n`;
 content+=`\n${(JSON.parse(r.gaps) as string[]).map(g=>'- '+g).join('\n')}\n\nAvailable artifacts and completed executions do not prove acceptance or human delivery. Open blockers remain current state even when previously alerted; this synopsis creates no separate blocker alerts.\n`;
 return content;
}

/** Single-writer finalization; model text can only become an optional preface.
 * Canonical template + source pages are always present and never depend on model tools.
 */
export async function materializeSynopsis(userId:string,id:string,time=now()) {
 let r=reportRow(userId,id);assertLegacyWorkOpen(userId);
 if(r.content!==null)return getSynopsis(userId,id);
 if(r.generation_owner&&ownerAlive(r.generation_owner,r.generation_birth)&&time<r.generation_deadline)return getSynopsis(userId,id);
 const tokenOwner=process.pid;
 db.prepare('UPDATE coordination_synopses SET generation_owner=?,generation_birth=? WHERE id=? AND content IS NULL').run(tokenOwner,ownerBirth,id);
 let narrative='',note='Factual template; no narrative provider configured.';
 if(narrator&&time<r.generation_deadline){
  const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
   const remaining=Math.min(NARRATIVE_TIMEOUT_MS,r.generation_deadline-time);
   const result=await Promise.race([Promise.resolve().then(()=>narrator!({report:getSynopsis(userId,id),sources:summarySources(userId,id),signal:controller.signal})),
    new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new Error('Narrative deadline exceeded.'));},remaining);})]);
   if(typeof result==='string'&&result.trim()&&result.length<=4000){narrative=result.trim();note='Optional narrative; canonical facts and coverage follow.';}else note='Narrative unavailable or too large; factual fallback.';
  }catch{note='Narrative unavailable or timed out; factual fallback.';}finally{if(timeout)clearTimeout(timeout);controller.abort();}
 }else if(r.generation_owner||time>=r.generation_deadline)note='Generation interrupted or deadline elapsed; factual fallback.';
 assertLegacyWorkOpen(userId);
 // One immutable page artifact per bounded source page. Deterministic filename+bytes
 // makes a crash between filesystem write and DB linkage safe to replay.
 let after=0,page=0;
 do{
  const part=reportSourcePage(userId,id,after);if(!part.sources.length)break;
  const content=header(r)+`## Frozen sources, page ${++page}\n\n`+part.sources.map(line).join('\n');
  const artifact=recordArtifact({userId,botId:r.bot_id,filename:`quinn-synopsis-${id}-sources-${page}.md`,content});
  db.prepare('INSERT OR IGNORE INTO coordination_synopsis_pages(report_id,user_id,page,artifact_id) VALUES(?,?,?,?)').run(id,userId,page,artifact.id);
  after=part.nextCursor;if(!part.hasMore)break;
 }while(true);
 db.transaction(()=>{
  r=reportRow(userId,id);if(r.content!==null)return;
  const content=(narrative?`Optional narrative (not acceptance or delivery evidence):\n\n${narrative}\n\n`:'')+template(r);
  db.prepare("UPDATE coordination_synopses SET content=?,content_sha256=?,generation_note=?,status='ready' WHERE id=? AND content IS NULL").run(content,sha256(content),note,id);
  db.prepare('UPDATE coordination_report_cursors SET materialized_through=?,materialized_seq=? WHERE user_id=? AND materialized_through<=?').run(r.window_end,r.source_through,userId,r.window_end);
 })();
 return getSynopsis(userId,id);
}

/** Only the existing Library channel is scheduled. Linked messaging accounts alone
 * are not authorization to send a synopsis to an external recipient.
 */
export async function dispatchSynopsis(userId:string,id:string) {
 let r=reportRow(userId,id);assertLegacyWorkOpen(userId);if(r.content===null)return getSynopsis(userId,id);
 if(!synopsisDeliveryPermitted(r))return getSynopsis(userId,id);
 if(sha256(r.content)!==r.content_sha256)throw new Error('Report content integrity check failed.');
 if(!r.artifact_id){
  const artifact=recordArtifact({userId,botId:r.bot_id,filename:`quinn-synopsis-${id}.md`,content:r.content});
  db.prepare('UPDATE coordination_synopses SET artifact_id=? WHERE id=? AND artifact_id IS NULL').run(artifact.id,id);r=reportRow(userId,id);
 }
 // The same artifact/identity survives partial failures, retries and restarts.
 if(!r.delivery_id){
  if(JSON.parse(r.destination).channel!=='library')throw new Error('External synopsis delivery requires existing recipient authorization.');
  const d=await requestDelivery({userId,artifactId:r.artifact_id,channel:'library',idempotencyKey:`quinn-synopsis:${id}`,approvedTarget:{channel:'library'}});
  assertLegacyWorkOpen(userId);db.prepare('UPDATE coordination_synopses SET delivery_id=? WHERE id=? AND delivery_id IS NULL').run(d.id,id);r=reportRow(userId,id);
 }
 const saved=readArtifact(userId,r.artifact_id);if(saved.artifact.sha256!==r.content_sha256)throw new Error('Report artifact identity mismatch.');
 const delivery=getDelivery(userId,r.delivery_id);
 if(delivery.artifactId!==r.artifact_id||targetIdentity(getDeliveryTarget(userId,delivery.id))!==targetIdentity(JSON.parse(r.destination)))throw new Error('Report receipt identity mismatch.');
 if(delivery.status==='pending')await sendDelivery(userId,delivery.id);
 // Failed is definitely unsent; unknown/sending are never implicitly retried.
 reconcileSynopsisReceipts(userId);return getSynopsis(userId,id);
}
function synopsisDeliveryPermitted(r:any,time=now()) {
 if(r.slot_key.startsWith('manual:')||!exists('proactivity'))return true;
 const p=db.prepare('SELECT * FROM proactivity WHERE user_id=?').get(r.user_id) as any;
 if(!p)return true;if(!p.enabled)return false;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:p.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time).map(v=>[v.type,v.value]));
 const hm=`${parts.hour}:${parts.minute}`;
 return !(JSON.parse(p.quiet_hours??'[]') as Array<{start:string;end:string}>).some(q=>q.start===q.end||
  (q.start<q.end?hm>=q.start&&hm<q.end:hm>=q.start||hm<q.end));
}
export async function retrySynopsis(userId:string,id:string) {
 const r=reportRow(userId,id);assertLegacyWorkOpen(userId);
 if(r.delivery_id)retryDelivery(userId,r.delivery_id);
 return dispatchSynopsis(userId,id);
}
export function reconcileSynopsisReceipts(onlyUser?:string) {
 if(!db.open)return;
 const owners=onlyUser?[{user_id:onlyUser}]:db.prepare('SELECT user_id FROM coordination_report_cursors').all() as any[];
 for(const {user_id:userId} of owners){assertTenant(userId);if(legacyWorkHeld(userId))continue;
 db.transaction(()=>{
  const cursor=db.prepare('SELECT * FROM coordination_report_cursors WHERE user_id=?').get(userId) as any;if(!cursor)return;
  let through=cursor.delivered_through,seq=cursor.delivered_seq;
  for(const r of db.prepare('SELECT * FROM coordination_synopses WHERE user_id=? ORDER BY seq').all(userId) as any[]){
   if(r.delivered_at&&r.window_end<=cursor.delivered_through&&r.source_through<=cursor.delivered_seq)continue;
   if(!r.content||!r.artifact_id||!r.delivery_id)break;
   const d=getDelivery(userId,r.delivery_id);if(d.status!=='delivered'||d.artifactId!==r.artifact_id||targetIdentity(getDeliveryTarget(userId,d.id))!==targetIdentity(JSON.parse(r.destination)))break;
   try{
    if(readArtifact(userId,r.artifact_id).artifact.sha256!==r.content_sha256)break;
    const pages=db.prepare('SELECT artifact_id FROM coordination_synopsis_pages WHERE report_id=? ORDER BY page').all(r.id) as any[];
    if(pages.length!==Math.ceil(r.source_count/REPORT_PAGE_SIZE))break;
    for(const p of pages)readArtifact(userId,p.artifact_id);
   }catch{break;}
   through=r.window_end;seq=r.source_through;
   if(!r.delivered_at)db.prepare('UPDATE coordination_synopses SET delivered_at=? WHERE id=?').run(now(),r.id);
  }
  db.prepare('UPDATE coordination_report_cursors SET delivered_through=?,delivered_seq=? WHERE user_id=?').run(through,seq,userId);
 })();}
}
export async function resumeSynopses(time=now()) {
 const settings=exists('proactivity');
 const reports=db.prepare(`SELECT coordination_synopses.* FROM coordination_synopses LEFT JOIN artifact_deliveries d ON d.id=coordination_synopses.delivery_id
 ${settings?'LEFT JOIN proactivity p ON p.user_id=coordination_synopses.user_id':''}
 WHERE (content IS NULL OR delivery_id IS NULL OR d.status='pending') AND coordination_synopses.next_attempt_at<=? AND ${legacyWritableRows(db,'coordination_synopses')}
 ${settings?"AND (p.user_id IS NULL OR p.enabled=1 OR slot_key LIKE 'manual:%')":''}
 ORDER BY coordination_synopses.next_attempt_at,seq LIMIT 100`).all(time) as any[];
 await Promise.allSettled(reports.map(async r=>{
  if(legacyWorkHeld(r.user_id)||!synopsisDeliveryPermitted(r,time))return;
  try{await materializeSynopsis(r.user_id,r.id,time);await dispatchSynopsis(r.user_id,r.id);}
  catch(e){if(!legacyWorkHeld(r.user_id))db.prepare('UPDATE coordination_synopses SET last_error=?,next_attempt_at=?,failure_count=failure_count+1 WHERE id=?')
   .run(String((e as Error).message).slice(0,1000),time+Math.min(30000,1000*2**Math.min(r.failure_count,5)),r.id);}
 }));
 reconcileSynopsisReceipts();
}

// Compatibility for already-admitted agent report jobs. New schedules use the
// independent snapshot lifecycle above. Old ambiguous deliveries remain intact.
export function reportSources(userId:string) {
 assertTenant(userId);
 const sources:Array<{id:string;revision:string;kind:string;state:string;title:string}>=[];
 for(const r of db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.id').iterate(userId) as Iterable<any>)sources.push({id:`routine:${r.id}`,revision:sha256(JSON.stringify([r.name,r.prompt,r.enabled,r.schedule,r.timezone,r.last_run_at])),kind:'routine',state:r.enabled?'enabled':'disabled',title:r.name});
 if(exists('routine_executions'))for(const r of db.prepare('SELECT * FROM routine_executions WHERE user_id=? ORDER BY created_at,id').iterate(userId) as Iterable<any>)sources.push({id:`run:${r.id}`,revision:sha256(JSON.stringify([r.status,r.finished_at,r.error])),kind:'run',state:r.status,title:r.routine_name});
 if(exists('output_artifacts'))for(const r of db.prepare('SELECT * FROM output_artifacts WHERE user_id=? ORDER BY created_at,id').iterate(userId) as Iterable<any>)sources.push({id:`artifact:${r.id}`,revision:r.sha256,kind:'artifact',state:'available',title:r.filename});
 if(exists('artifact_deliveries'))for(const r of db.prepare('SELECT * FROM artifact_deliveries WHERE user_id=? ORDER BY updated_at,id').iterate(userId) as Iterable<any>)sources.push({id:`delivery:${r.id}`,revision:sha256(JSON.stringify([r.status,r.updated_at,r.error])),kind:'delivery',state:r.status,title:r.channel});
 return sources;
}
export function dailySynopsisContext(userId:string,period=new Date().toISOString().slice(0,10)) {
 const sources=reportSources(userId);
 const covered=new Set((db.prepare('SELECT source_id,source_revision FROM coordination_reports WHERE user_id=? AND period=?').all(userId,period) as any[]).map(r=>`${r.source_id}:${r.source_revision}`));
 return {period,sources:sources.map(s=>({...s,covered:covered.has(`${s.id}:${s.revision}`)})),instructions:'Use canonical facts. Available artifacts do not prove acceptance or human delivery. Failed/unknown/waiting work stays unresolved. Include exact id@revision references for every discussed source in the saved artifact. Only durable delivered artifact receipts confer coverage.'};
}
export function bindReportIntent(userId:string,jobId:string,period:string,sources=reportSources(userId)) {
 assertTenant(userId);assertLegacyWorkOpen(userId);
 if(!db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=?').get(jobId,userId))throw new Error('Report job not found.');
 db.prepare('INSERT OR IGNORE INTO coordination_report_intents(job_id,user_id,period,sources,created_at) VALUES(?,?,?,?,?)').run(jobId,userId,period,JSON.stringify(sources),now());
}
/** Reconcile independently of model success; delivery can happen after the turn. */
export function reconcileReportCoverage() {
 reconcileSynopsisReceipts();
 if(!exists('artifact_deliveries')||!exists('output_artifacts'))return;
 const intents=db.prepare('SELECT * FROM coordination_report_intents WHERE settled_at IS NULL').all() as any[];
 for(const intent of intents){if(legacyWorkHeld(intent.user_id))continue;
 const receipts=db.prepare(`WITH RECURSIVE lineage(id,n) AS (
 SELECT id,0 FROM agent_jobs WHERE id=? AND user_id=? UNION ALL
 SELECT j.id,l.n+1 FROM agent_jobs j JOIN lineage l ON json_extract(j.trigger,'$.parentJobId')=l.id WHERE j.user_id=? AND l.n<32)
 SELECT d.id,a.id AS artifact_id FROM artifact_deliveries d JOIN output_artifacts a ON a.id=d.artifact_id AND a.user_id=d.user_id
 JOIN agent_jobs j ON j.id=a.job_id AND j.user_id=a.user_id JOIN lineage l ON l.id=j.id
 WHERE a.user_id=? AND j.state='completed' AND d.status='delivered' ORDER BY d.updated_at`).all(intent.job_id,intent.user_id,intent.user_id,intent.user_id) as any[];
 const sources=JSON.parse(intent.sources) as Array<{id:string;revision:string}>;
 for(const receipt of receipts) {
 let content:string;try{content=readArtifact(intent.user_id,receipt.artifact_id).content.toString('utf8');}catch{continue;}
 const referenced=sources.filter(s=>content.includes(`${s.id}@${s.revision}`));if(!referenced.length)continue;
 db.transaction(()=>{
 let inserted=0;
 for(const s of referenced)inserted+=db.prepare('INSERT OR IGNORE INTO coordination_reports(id,user_id,period,source_id,source_revision,report_job_id,delivery_id,covered_at) VALUES(?,?,?,?,?,?,?,?)').run(newId('coverage'),intent.user_id,intent.period,s.id,s.revision,intent.job_id,receipt.id,now()).changes;
 const covered=new Set((db.prepare('SELECT source_id,source_revision FROM coordination_reports WHERE user_id=? AND period=?').all(intent.user_id,intent.period) as any[]).map(r=>`${r.source_id}@${r.source_revision}`));
 if(sources.every(s=>covered.has(`${s.id}@${s.revision}`)))db.prepare('UPDATE coordination_report_intents SET settled_at=? WHERE job_id=?').run(now(),intent.job_id);
 if(inserted)publishNativeEvent({userId:intent.user_id,kind:'coordination.report_covered',sourceType:'coordination_report',sourceId:intent.job_id,jobId:intent.job_id,audience:'internal',data:{period:intent.period,deliveryId:receipt.id,sourceCount:inserted}});
 })();
 }
 }
}
