import fs from 'node:fs';
import { z } from 'zod';
import { db,now,newId,sha256,atomic,emitEvent,missing,ownBot,ownJob,requireEnabled,ServiceError,cursor,pageSize,nextCursor } from './db.js';
import { OUTPUT_LIMITS, type RunOutput,type OutputPart,type Provenance,type SubmitOutputInput,type HandoffContext,type HandoffPage } from './contracts.js';
import { displayCoordinationText } from '../lib/redact.js';
import { readArtifact } from '../deliverables/artifacts.js';
import { env } from '../env.js';

export function displayText(text:string) {
 return displayCoordinationText(text).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,'[redacted]')
 .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,'$1[redacted]')
 .replace(/\b(api[_ -]?key|access[_ -]?token|secret|password)(\s*[:=]\s*)(["']?)[^\s,"'}]+\3/gi,'$1$2[redacted]')
 .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted]');
}
const clean=(text:string)=>displayText(text).replace(/[\u2013\u2014]/g,'-');
function summaryOf(body:string) {
 const text=clean(body).trim();if(text.length<=1200)return text;
 const p=text.split(/\n\s*\n/)[0].slice(0,1200),end=Math.max(p.lastIndexOf('. '),p.lastIndexOf('! '),p.lastIndexOf('? '));
 return end>0?p.slice(0,end+1):p;
}
export const submitOutputSchema=z.object({title:z.string().min(1).max(120).optional(),summary:z.string().max(1200),
 dataParts:z.array(z.object({name:z.string().min(1).max(100),schema:z.string().max(100).optional(),json:z.unknown()}).strict()).max(5).optional(),
 links:z.array(z.object({url:z.string().url().refine(v=>v.startsWith('https://')),title:z.string().max(200),relation:z.enum(['source','result','reference'])}).strict()).max(30).optional(),
 files:z.array(z.string().min(1).max(300)).max(20).optional()}).strict();
export function outputView(r:any):RunOutput {
 return {id:r.id,userId:r.user_id,botId:r.bot_id,jobId:r.job_id,taskId:r.task_id,source:r.source,status:r.status,revision:r.revision,title:r.title,summary:r.summary,
 parts:JSON.parse(r.manifest),provenance:JSON.parse(r.provenance),contentHash:r.content_hash,createdAt:r.created_at,finalizedAt:r.finalized_at};
}
export function getOutput(userId:string,id:string):RunOutput {
 requireEnabled(userId);const r=db.prepare('SELECT * FROM run_outputs WHERE id=? AND user_id=?').get(id,userId) as any;
 if(!r)missing();if(r.summary==='Deleted'&&r.manifest==='[]')throw new ServiceError('output_deleted','Output deleted.',410);return outputView(r);
}
export function outputByJob(userId:string,jobId:string):RunOutput {
 requireEnabled(userId);const r=db.prepare('SELECT * FROM run_outputs WHERE job_id=? AND user_id=?').get(jobId,userId);return r?outputView(r):missing();
}
export function listOutputs(userId:string,opts:{botId?:string;after?:string;limit?:number}={}) {
 requireEnabled(userId);if(opts.botId)ownBot(userId,opts.botId);const c=cursor(opts.after),limit=pageSize(opts.limit);
 const rows=(db.prepare(`SELECT * FROM run_outputs WHERE user_id=? ${opts.botId?'AND bot_id=?':''} ${c?'AND (created_at,id)<(?,?)':''} ORDER BY created_at DESC,id DESC LIMIT ?`)
 .all(userId,...(opts.botId?[opts.botId]:[]),...(c??[]),limit+1) as any[]).map(outputView);
 return {outputs:rows.slice(0,limit),next:rows.length>limit?nextCursor(rows[limit-1]):null};
}
function provenance(userId:string,botId:string,jobId:string|null,declaredBy:'auto'|'agent'):Provenance {
 const b=ownBot(userId,botId),j=jobId?ownJob(userId,botId,jobId):null,t=j?JSON.parse(j.trigger):{};
 const h=jobId?db.prepare(`SELECT h.* FROM handoffs h JOIN coordination_requests r ON r.id=h.request_id WHERE h.user_id=? AND (h.job_id=? OR r.job_id=? OR r.id=?)`).get(userId,jobId,jobId,t.coordinationRequestId??'') as any:null;
 const d=jobId?db.prepare(`SELECT d.* FROM handoff_loop_dispatches d JOIN loops l ON l.id=d.loop_id JOIN coordination_requests r ON r.id=d.request_id WHERE l.user_id=? AND (d.job_id=? OR r.job_id=? OR r.id=?)`).get(userId,jobId,jobId,t.coordinationRequestId??'') as any:null;
 const consumed:string[]=h?[h.source_output_id]:[];
 if(d){const previous=db.prepare('SELECT output_id FROM loop_steps WHERE loop_id=? AND output_id IS NOT NULL ORDER BY iteration DESC,rowid DESC LIMIT 2').all(d.loop_id) as any[];consumed.push(...previous.map(p=>p.output_id));}
 return {producer:{botId,botName:b.name},jobId,trigger:d?'loop':h?'handoff':t.type==='bot'?'internal':['user','routine','event'].includes(t.type)?t.type:'user',
 model:b.model??null,effort:b.reasoning_effort??null,startedAt:j?.started_at??null,finishedAt:j?.finished_at??null,consumed:[...new Set(consumed)].slice(0,10),handoffId:h?.id??null,
 loopId:d?.loop_id??h?.loop_id??null,iteration:d?.iteration??null,stepId:d?.step_id??null,tools:[],declaredBy};
}
function filesFor(userId:string,botId:string,jobId:string|null,selected?:string[]):OutputPart[] {
 if(!jobId){if(selected?.length)missing();return [];}
 const rows=db.prepare('SELECT * FROM output_artifacts WHERE user_id=? AND bot_id=? AND job_id=? ORDER BY created_at,id').all(userId,botId,jobId) as any[];
 if(selected?.some(s=>!rows.some(r=>s===r.id||s===r.filename||s===`Deliverables/${r.id}/${r.filename}`)))throw new ServiceError('not_found','Saved file not found.',404);
 return rows.filter(r=>!selected||selected.some(s=>s===r.id||s===r.filename||s===`Deliverables/${r.id}/${r.filename}`)).slice(0,20)
 .map(r=>({id:`p_${r.id}`,kind:'file',artifactId:r.id,filename:r.filename,mime:r.mime_type,size:r.size,sha256:r.sha256}));
}
export function saveOutput(input:{userId:string;botId:string;jobId?:string|null;taskId?:string|null;source?:RunOutput['source'];body?:string;declared?:SubmitOutputInput;final?:boolean;sourceKey?:string}) {
 requireEnabled(input.userId);ownBot(input.userId,input.botId);if(input.jobId)ownJob(input.userId,input.botId,input.jobId);
 if(input.declared){const check=submitOutputSchema.safeParse(input.declared);if(!check.success)throw new ServiceError('invalid_input','Check the output fields.');}
 return atomic(()=>{
  const prior=(input.jobId?db.prepare('SELECT * FROM run_outputs WHERE job_id=? AND user_id=?').get(input.jobId,input.userId):input.sourceKey?db.prepare('SELECT o.* FROM run_outputs o JOIN handoff_output_sources s ON s.output_id=o.id WHERE s.user_id=? AND s.source_key=?').get(input.userId,input.sourceKey):undefined) as any;
  if(prior&&(prior.status!=='draft'||input.sourceKey))return outputView(prior);
  const id=prior?.id??newId('out'),p=provenance(input.userId,input.botId,input.jobId??null,input.declared||prior&&JSON.parse(prior.provenance).declaredBy==='agent'?'agent':'auto');
  const raw=(input.body??(prior?rawBody(input.userId,prior.id,'p_body'):input.declared?.summary)??'').slice(0,OUTPUT_LIMITS.bodyChars);
  const display=clean(raw),originalParts:{id:string;body:string;display:string;kind:string;name:string}[]=[{id:'p_body',body:raw,display,kind:'text',name:'body'}];
  let parts:OutputPart[]=[{id:'p_body',kind:'text',name:'body',chars:display.length,sha256:sha256(display)}];
  let dataBytes=0;
  if(input.declared?.dataParts)for(const [i,part] of input.declared.dataParts.entries()){
   const json=JSON.stringify(part.json);if(json===undefined)throw new ServiceError('invalid_input','Use JSON data.');
   dataBytes+=Buffer.byteLength(json);if(dataBytes>OUTPUT_LIMITS.dataBytesMax)throw new ServiceError('part_too_large','Data parts exceed 256 KB.');
   const text=JSON.stringify(JSON.parse(json),null,2),safe=clean(text),pid=`p_data${i}`;
   parts.push({id:pid,kind:'data',name:part.name,...(part.schema?{schema:part.schema}:{}),bytes:Buffer.byteLength(safe),sha256:sha256(safe)});
   originalParts.push({id:pid,body:text,display:safe,kind:'data',name:part.name});
  }else if(prior)parts.push(...JSON.parse(prior.manifest).filter((p:OutputPart)=>p.kind==='data'));
  const oldParts:OutputPart[]=prior?JSON.parse(prior.manifest):[];
  const files=filesFor(input.userId,input.botId,input.jobId??null,input.declared?.files);
  parts.push(...[...new Map([...oldParts.filter(p=>p.kind==='file'),...files].map(p=>[p.id,p])).values()].slice(0,20));
  const links=new Map<string,OutputPart>();
  for(const link of input.declared?.links??oldParts.filter(p=>p.kind==='link'))links.set(link.url,{id:`p_link${links.size}`,kind:'link',url:clean(link.url),title:clean(link.title),relation:link.relation});
  for(const match of display.matchAll(/https:\/\/[^\s<>"')\]]+/g))if(links.size<30&&!links.has(match[0])){try{links.set(match[0],{id:`p_link${links.size}`,kind:'link',url:match[0],title:new URL(match[0]).host,relation:'reference'});}catch{}}
  parts.push(...links.values());
  const hash=sha256(JSON.stringify(parts.map(part=>{const {id:_,...data}=part;return data;})));
  const title=clean(input.declared?.title??prior?.title??raw.split('\n')[0]??'Output').slice(0,120)||'Output';
  const summary=clean(input.declared?.summary??(p.declaredBy==='agent'?prior?.summary:undefined)??summaryOf(raw)).slice(0,1200);
  const stamp=now(),status=input.final?'final':'draft',source=p.loopId?'loop_step':input.source??prior?.source??'run';
  if(input.body&&input.body.length>OUTPUT_LIMITS.bodyChars)Object.assign(p,{truncated:true});
  db.prepare(`INSERT INTO run_outputs(id,user_id,bot_id,job_id,task_id,source,status,revision,title,summary,manifest,provenance,content_hash,incomplete,created_at,finalized_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,title=excluded.title,summary=excluded.summary,
   manifest=excluded.manifest,provenance=excluded.provenance,content_hash=excluded.content_hash,incomplete=excluded.incomplete,finalized_at=excluded.finalized_at`)
   .run(id,input.userId,input.botId,input.jobId??null,input.taskId??null,source,status,(prior?.revision??0)+1,title,summary,JSON.stringify(parts),JSON.stringify(p),hash,input.final?0:1,prior?.created_at??stamp,input.final?stamp:null);
  for(const part of originalParts){db.prepare('INSERT OR REPLACE INTO run_output_parts VALUES(?,?,?,?,?,?,?)').run(id,part.id,part.kind,part.name,part.display,sha256(part.display),Number(part.display!==part.body));db.prepare('INSERT OR REPLACE INTO handoff_original_parts VALUES(?,?,?)').run(id,part.id,part.body);}
  if(input.sourceKey)db.prepare('INSERT INTO handoff_output_sources VALUES(?,?,?)').run(input.userId,input.sourceKey,id);
  if(!prior)emitEvent(input.userId,'output.created',{outputId:id},{loopId:p.loopId,handoffId:p.handoffId},{type:'output',id,botId:input.botId});
  if(input.final)emitEvent(input.userId,'output.finalized',{outputId:id},{loopId:p.loopId,handoffId:p.handoffId},{type:'output',id,botId:input.botId});
  return getOutput(input.userId,id);
 });
}
export function submitOutput(ctx:HandoffContext,input:SubmitOutputInput) {
 requireEnabled(ctx.userId);const j=ownJob(ctx.userId,ctx.botId,ctx.jobId);
 if(!['queued','running'].includes(j.state))throw new ServiceError('invalid_state','This run has finished.',409);
 return atomic(()=>{const fingerprint=sha256(JSON.stringify(input));const receipt=db.prepare('SELECT * FROM handoff_tool_receipts WHERE user_id=? AND job_id=? AND call_id=?').get(ctx.userId,ctx.jobId,ctx.toolCallId) as any;
 if(receipt){if(receipt.fingerprint!==fingerprint)throw new ServiceError('idempotency_conflict','This call was already used.',409);return getOutput(ctx.userId,receipt.output_id);}
 const output=saveOutput({...ctx,declared:input});db.prepare('INSERT INTO handoff_tool_receipts VALUES(?,?,?,?,?)').run(ctx.userId,ctx.jobId,ctx.toolCallId,fingerprint,output.id);return output;});
}
export function fromMessage(userId:string,input:{botId:string;generation:number;seq:number}) {
 requireEnabled(userId);ownBot(userId,input.botId);
 const row=db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq=? AND kind='message'").get(input.botId,input.generation,input.seq) as any;
 if(!row)missing();const body=JSON.parse(row.body);if(body.role!=='assistant'||body.audience==='internal'||body.streaming)missing();
 const text=typeof body.text==='string'?body.text:'';
 return saveOutput({userId,botId:input.botId,body:text,source:'message',final:true,sourceKey:`message:${input.botId}:${input.generation}:${input.seq}:${sha256(text)}`});
}
export function fromTask(userId:string,taskId:string) {
 requireEnabled(userId);const task=db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=? AND b.user_id=?').get(taskId,userId) as any;if(!task)missing();
 if(task.state!=='done')throw new ServiceError('invalid_state','Finish the task first.',409);
 const existing=db.prepare("SELECT * FROM run_outputs WHERE user_id=? AND task_id=? ORDER BY created_at DESC LIMIT 1").get(userId,taskId);
 return existing?outputView(existing):saveOutput({userId,botId:task.bot_id,taskId,source:'task',body:task.note,declared:{title:task.title,summary:summaryOf(task.note||task.title)},final:true,sourceKey:`task:${taskId}:${sha256(task.note)}`});
}
export function rawBody(userId:string,outputId:string,partId:string,sensitive=false) {
 getOutput(userId,outputId);
 const row=db.prepare(`SELECT body FROM ${sensitive?'handoff_original_parts':'run_output_parts'} WHERE output_id=? AND part_id=?`).get(outputId,partId) as any;
 return row?.body??'';
}
export function readPart(userId:string,id:string,partId:string,offset=0,limit=8000,sensitive=false):HandoffPage {
 const output=getOutput(userId,id),part=output.parts.find(p=>p.id===partId);if(!part)missing();
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8000)throw new ServiceError('invalid_input','Use a page of 1 to 8000 characters.');
 let text:string|undefined;
 if(part.kind==='text'||part.kind==='data')text=rawBody(userId,id,partId,sensitive);
 if(part.kind==='link')text=JSON.stringify({url:part.url,title:part.title});
 if(part.kind==='file'&&/^(text\/|application\/(json|csv))/.test(part.mime))text=displayText(readArtifact(userId,part.artifactId).content.toString('utf8'));
 return {output,part,...(text!==undefined?{text:text.slice(offset,offset+limit)}:{}),next:text&&offset+limit<text.length?offset+limit:null};
}
/** Copy only a referenced artifact into the receiver's storage using directory descriptors. */
export function materialize(userId:string,botId:string,part:OutputPart) {
 ownBot(userId,botId);if(part.kind!=='file')throw new ServiceError('invalid_input','Choose a file part.');
 if(part.size>25*1024*1024)throw new ServiceError('part_too_large','File exceeds 25 MB.');
 const {content}=readArtifact(userId,part.artifactId);
 if(!/^[A-Za-z0-9_-]+$/.test(botId)||!/^[A-Za-z0-9_-]+$/.test(part.artifactId)||/[\/\\\x00-\x1f]/.test(part.filename)||['.','..'].includes(part.filename))throw new ServiceError('invalid_input','Invalid file path.');
 fs.mkdirSync(env.filesDir,{recursive:true});let dir=fs.openSync(env.filesDir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{for(const segment of [botId,'Handoffs',part.artifactId]){const path=`/proc/self/fd/${dir}/${segment}`;try{fs.mkdirSync(path,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}const next=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fs.closeSync(dir);dir=next;}
 const path=`/proc/self/fd/${dir}/${part.filename}`;let fd:number;try{fd=fs.openSync(path,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o400);}catch(e:any){if(e.code!=='EEXIST')throw e;fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(sha256(fs.readFileSync(fd).toString('base64'))!==sha256(content.toString('base64')))throw new ServiceError('invalid_state','Copied file changed.',409);}finally{fs.closeSync(fd);}return `Handoffs/${part.artifactId}/${part.filename}`;}
 try{fs.writeFileSync(fd,content);}finally{fs.closeSync(fd);}return `Handoffs/${part.artifactId}/${part.filename}`;
 }finally{fs.closeSync(dir);}
}
export function deleteOutput(userId:string,id:string) {getOutput(userId,id);atomic(()=>{db.prepare('DELETE FROM run_output_parts WHERE output_id=?').run(id);db.prepare('DELETE FROM handoff_original_parts WHERE output_id=?').run(id);db.prepare("UPDATE run_outputs SET status='superseded',summary='Deleted',manifest='[]' WHERE id=? AND user_id=?").run(id,userId);});}
