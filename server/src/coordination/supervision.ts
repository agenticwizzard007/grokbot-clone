import './schema.js';
import { db, now } from '../db.js';
import { newId, sha256 } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { legacyWorkHeld, assertLegacyWorkOpen } from '../security/legacy-work.js';
import { publishNativeEvent, readNativeCursor, advanceNativeCursor } from '../native/events.js';
import { teamState, coordinationPrompt } from './state.js';
import { botOccupied, coordinationRuntime, type CoordinationFinish } from './requests.js';

export function setCoordinationEnabled(userId:string,enabled:boolean) {
 assertTenant(userId);assertLegacyWorkOpen(userId);
 db.transaction(()=>{
 db.prepare(`INSERT INTO coordination_supervision(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,authority_revision=authority_revision+1`).run(userId,enabled?1:0);
 db.prepare("UPDATE coordination_wakes SET status='superseded',reason='Authority settings changed.',updated_at=? WHERE user_id=? AND status='pending'").run(now(),userId);
 })();
}
export function reviewCoordination() {
 if(!db.open)return;
 const owners=db.prepare('SELECT DISTINCT user_id FROM bots WHERE is_primary=1').all() as any[];
 for(const {user_id:userId} of owners){if(legacyWorkHeld(userId))continue;
 try{db.transaction(()=>{
 const state=teamState(userId),primary=state.primaryBotId;
 db.prepare('INSERT OR IGNORE INTO coordination_supervision(user_id,primary_bot_id) VALUES(?,?)').run(userId,primary);
 let s=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(userId) as any;
 if(s.primary_bot_id!==primary){db.prepare('UPDATE coordination_supervision SET primary_bot_id=?,authority_revision=authority_revision+1 WHERE user_id=?').run(primary,userId);s=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(userId);}
 db.prepare('UPDATE coordination_supervision SET last_tick_at=?,last_error=NULL WHERE user_id=?').run(now(),userId);
 // No self-generated job/request chatter in the wake fingerprint. This avoids
 // supervisor turns perpetually waking themselves. Event cursor remains durable.
 const requestVersions=db.prepare("SELECT id,status,revision FROM coordination_requests WHERE user_id=? AND kind='request' ORDER BY seq").all(userId);
 const sourceVersion=sha256(JSON.stringify([state.sourceVersions.agents,state.sourceVersions.workflows,state.sourceVersions.artifacts,state.sourceVersions.deliveries,requestVersions]));
 const previousCursor=readNativeCursor(userId,'coordination');
 if(state.eventCursor>previousCursor&&!advanceNativeCursor(userId,'coordination',previousCursor,state.eventCursor))throw new Error('Coordination source cursor changed.');
 const admitted=db.prepare("SELECT * FROM coordination_wakes WHERE user_id=? AND status='admitted'").all(userId) as any[];
 for(const w of admitted){
 const j=db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(w.job_id) as any;
 const descendant=db.prepare(`WITH RECURSIVE chain(id,n) AS (SELECT ?,0 UNION ALL SELECT j.id,c.n+1 FROM agent_jobs j JOIN chain c ON json_extract(j.trigger,'$.parentJobId')=c.id WHERE j.user_id=? AND c.n<32)
 SELECT 1 FROM chain c JOIN agent_jobs j ON j.id=c.id WHERE c.n>0 AND j.state IN ('queued','running') LIMIT 1`).get(w.job_id,userId);
 if((!j||['uncertain','cancelled','completed'].includes(j.state))&&!botOccupied(s.primary_bot_id??'')&&!descendant)db.prepare("UPDATE coordination_wakes SET status='failed',reason='Interrupted or final review receipt unavailable; inspect canonical state.',updated_at=? WHERE id=?").run(now(),w.id);
 }
 if(!s.enabled||!primary)return;
 db.prepare("UPDATE coordination_wakes SET status='superseded',reason='Coalesced into newer state or authority.',updated_at=? WHERE user_id=? AND status='pending' AND (source_version!=? OR authority_revision!=?)").run(now(),userId,sourceVersion,s.authority_revision);
 db.prepare("INSERT OR IGNORE INTO coordination_wakes(id,user_id,authority_revision,source_cursor,source_version,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(newId('wake'),userId,s.authority_revision,state.eventCursor,sourceVersion,now(),now());
 })();
 db.transaction(()=>{
 const s=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(userId) as any,primary=s.primary_bot_id;
 if(!s.enabled||!primary)return;
 const wake=db.prepare("SELECT * FROM coordination_wakes WHERE user_id=? AND status='pending' AND authority_revision=? ORDER BY created_at DESC LIMIT 1").get(userId,s.authority_revision) as any;
 const recent=(db.prepare("SELECT COUNT(*) n FROM coordination_wakes WHERE user_id=? AND job_id IS NOT NULL AND created_at>?").get(userId,now()-3600000) as any).n;
 if(recent>=8 || s.last_review_at && now()-s.last_review_at<60000)return;
 if(!wake||!coordinationRuntime()||botOccupied(primary)||db.prepare("SELECT 1 FROM coordination_wakes WHERE user_id=? AND status='admitted'").get(userId))return;
 const jobId=coordinationRuntime()!.enqueue(primary,{type:'system',audience:'internal',coordinationWakeId:wake.id,text:`[Team review] Review current operational facts and blockers. Follow up through tracked workflows/internal requests only when needed. Respect pending human decisions and worker setup. Never claim verification or delivery from model text. No user message is required.\n${coordinationPrompt(userId,primary)}`});
 const j=db.prepare('SELECT user_id,bot_id FROM agent_jobs WHERE id=?').get(jobId) as any;if(!j||j.user_id!==userId||j.bot_id!==primary)throw new Error('Review admission did not return an owned durable job.');
 db.prepare("UPDATE coordination_wakes SET status='admitted',job_id=?,updated_at=? WHERE id=? AND status='pending'").run(jobId,now(),wake.id);
 db.prepare('UPDATE coordination_supervision SET source_cursor=? WHERE user_id=?').run(wake.source_cursor,userId);
 publishNativeEvent({userId,botId:primary,kind:'coordination.review_admitted',sourceType:'coordination_wake',sourceId:wake.id,sourceRevision:s.authority_revision,jobId,audience:'internal'});
 })();}catch(e){db.prepare('UPDATE coordination_supervision SET last_tick_at=?,last_error=? WHERE user_id=?').run(now(),String((e as Error).message).slice(0,1000),userId);}
 }
}
export function finishCoordinationReview(input:CoordinationFinish) {
 if(legacyWorkHeld(input.userId)||['waiting','queued','running'].includes(input.status))return;
 const wake=db.prepare(`WITH RECURSIVE chain(id,parent,n) AS (SELECT id,json_extract(trigger,'$.parentJobId'),0 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?
 UNION ALL SELECT j.id,json_extract(j.trigger,'$.parentJobId'),c.n+1 FROM agent_jobs j JOIN chain c ON j.id=c.parent WHERE j.user_id=? AND j.bot_id=? AND c.n<32)
 SELECT w.* FROM coordination_wakes w WHERE w.user_id=? AND w.status='admitted' AND (w.job_id IN (SELECT id FROM chain) OR w.id=(SELECT json_extract(trigger,'$.coordinationWakeId') FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?)) LIMIT 1`).get(input.jobId,input.userId,input.botId,input.userId,input.botId,input.userId,input.jobId,input.userId,input.botId) as any;
 if(!wake)return;
 db.transaction(()=>{
 db.prepare('UPDATE coordination_wakes SET status=?,updated_at=? WHERE id=?').run(input.status==='completed'?'completed':'failed',now(),wake.id);
 db.prepare('UPDATE coordination_supervision SET last_review_at=?,source_cursor=MAX(source_cursor,?) WHERE user_id=?').run(now(),wake.source_cursor,input.userId);
 })();
}
/** Root calls immediately before model execution; revoked authority cannot run. */
export function coordinationPreTurn(input:{userId:string;botId:string;jobId:string;trigger?:Record<string,unknown>}) {
 assertTenant(input.userId);if(legacyWorkHeld(input.userId))return {allowed:false,reason:'Account migration held.'};
 const wake=db.prepare(`WITH RECURSIVE chain(id,parent,n) AS (SELECT id,json_extract(trigger,'$.parentJobId'),0 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?
 UNION ALL SELECT j.id,json_extract(j.trigger,'$.parentJobId'),c.n+1 FROM agent_jobs j JOIN chain c ON j.id=c.parent WHERE j.user_id=? AND j.bot_id=? AND c.n<32)
 SELECT w.* FROM coordination_wakes w WHERE w.user_id=? AND (w.job_id IN (SELECT id FROM chain) OR w.id=(SELECT json_extract(trigger,'$.coordinationWakeId') FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?)) LIMIT 1`).get(input.jobId,input.userId,input.botId,input.userId,input.botId,input.userId,input.jobId,input.userId,input.botId) as any;
 if(!wake)return {allowed:true};
 const s=db.prepare('SELECT * FROM coordination_supervision WHERE user_id=?').get(input.userId) as any;
 const currentPrimary=db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=? AND is_primary=1').get(input.botId,input.userId);
 const valid=!!currentPrimary&&s?.enabled&&s.primary_bot_id===input.botId&&s.authority_revision===wake.authority_revision&&wake.status==='admitted';
 return valid?{allowed:true}:{allowed:false,reason:'Coordination authority changed.'};
}
