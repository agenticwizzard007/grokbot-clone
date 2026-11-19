import { db } from '../db.js';
import { KnowledgeError, ownedBot } from './common.js';

const summaryColumns = 'version,kind,source_id,source_revision,action,actor,reason,run_id,occurred_at,recorded_at,origin';
function summary(r:any) {
  return { version:r.version, kind:r.kind, sourceId:r.source_id, sourceRevision:r.source_revision,
    action:r.action, actor:r.actor, reason:r.reason, runId:r.run_id,
    occurredAt:r.occurred_at, recordedAt:r.recorded_at, origin:r.origin };
}
function integer(value:number|undefined, fallback:number) {
  if(value===undefined)return fallback;
  if(!Number.isSafeInteger(value)||value<0)throw new KnowledgeError('Invalid history cursor');
  return value;
}
export function evolutionHistory(userId:string,botId:string,options:{before?:number;through?:number;limit?:number}={}) {
  ownedBot(userId,botId);
  const latest=(db.prepare('SELECT COALESCE(MAX(version),0) n FROM agent_evolution WHERE user_id=? AND bot_id=?').get(userId,botId) as {n:number}).n;
  const through=Math.min(integer(options.through,latest),latest),before=integer(options.before,through+1),limit=Math.max(1,Math.min(100,integer(options.limit,30)));
  const rows=db.prepare(`SELECT ${summaryColumns} FROM agent_evolution WHERE user_id=? AND bot_id=? AND version<=? AND version<? ORDER BY version DESC LIMIT ?`).all(userId,botId,through,before,limit+1) as any[];
  const entries=rows.slice(0,limit).map(summary);
  return {entries,through,latestVersion:latest,nextBefore:rows.length>limit?entries.at(-1)!.version:null,
    coverage:'Retained skill and memory evidence is included. Earlier configuration changes may be unavailable. Change numbers identify recorded events; proposals and evaluations are not active agent revisions.'};
}
export function evolutionChange(userId:string,botId:string,version:number) {
  ownedBot(userId,botId);integer(version,0);
  const row=db.prepare('SELECT * FROM agent_evolution WHERE user_id=? AND bot_id=? AND version=?').get(userId,botId,version) as any;
  if(!row)throw new KnowledgeError('Not found',404);
  const decode=(s:string|null)=>s===null?null:JSON.parse(s);
  const before=decode(row.before_snapshot),after=decode(row.after_snapshot);
  const keys=[...new Set([...Object.keys(before??{}),...Object.keys(after??{})])];
  const changes=keys.filter(key=>JSON.stringify(before?.[key])!==JSON.stringify(after?.[key])).map(field=>({field,before:before?.[field]??null,after:after?.[field]??null}));
  const review=row.run_id?db.prepare(`SELECT id,reason,model,provider,selected_model,selected_provider,parent_job_id,status
    FROM knowledge_learning_reviews WHERE user_id=? AND bot_id=? AND job_id=?`).get(userId,botId,row.run_id) as any:undefined;
  return {...summary(row),before,after,changes,evidence:decode(row.evidence),
    review:review?{id:review.id,reason:review.reason,model:review.selected_model??review.model,provider:review.selected_provider??review.provider,parentJobId:review.parent_job_id,status:review.status}:null};
}
