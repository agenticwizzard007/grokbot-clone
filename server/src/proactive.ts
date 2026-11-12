import { legacyWorkHeld, assertLegacyWorkOpen } from './security/legacy-work.js';
import { db, now } from './db.js';
import { assertTenant } from './deployment.js';
import { botOccupied } from './coordination/requests.js';
import { dailySynopsisContext, bindReportIntent } from './coordination/reports.js';

let enqueueFn:((botId:string,t:any)=>string|void)|null=null;
let timer:ReturnType<typeof setInterval>|undefined;
function schema() {
 db.exec(`CREATE TABLE IF NOT EXISTS proactivity (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,
 times TEXT NOT NULL DEFAULT '["09:00","16:30"]',timezone TEXT NOT NULL DEFAULT 'UTC',last_fired TEXT,
 silent_streak INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS proactive_due_slots (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,slot_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','admitted')),job_id TEXT REFERENCES agent_jobs(id),
 created_at INTEGER NOT NULL,admitted_at INTEGER,PRIMARY KEY(user_id,slot_key));`);
}
export function initProactive(enqueue:(botId:string,t:any)=>string|void) {
 schema();enqueueFn=enqueue;if(timer)clearInterval(timer);timer=setInterval(tickProactive,60000);timer.unref();return ()=>{if(timer)clearInterval(timer);};
}
export function getCheckins(userId:string) {
 assertTenant(userId);schema();const r=db.prepare('SELECT * FROM proactivity WHERE user_id=?').get(userId) as any;
 return r?{enabled:!!r.enabled,times:JSON.parse(r.times) as string[],timezone:r.timezone}:{enabled:false,times:['09:00','16:30'],timezone:'UTC'};
}
export function setCheckins(userId:string,p:{enabled?:boolean;times?:string[];timezone?:string}) {
 assertLegacyWorkOpen(userId);const cur=getCheckins(userId),times=[...new Set(p.times??cur.times)].filter(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0,6),tz=p.timezone??cur.timezone;
 new Intl.DateTimeFormat('en-US',{timeZone:tz});
 db.prepare(`INSERT INTO proactivity(user_id,enabled,times,timezone,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,times=excluded.times,timezone=excluded.timezone,updated_at=excluded.updated_at`).run(userId,(p.enabled??cur.enabled)?1:0,JSON.stringify(times),tz,now());return getCheckins(userId);
}
export function noteCheckinOutcome(userId:string,sentMessage:boolean) {
 assertTenant(userId);if(legacyWorkHeld(userId))return;schema();db.prepare('UPDATE proactivity SET silent_streak=CASE WHEN ? THEN 0 ELSE silent_streak+1 END WHERE user_id=?').run(sentMessage?1:0,userId);
}
function localParts(tz:string,time:number) {
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time)).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,hm:`${p.hour}:${p.minute}`};
}
const minutes=(t:string)=>{const [h,m]=t.split(':').map(Number);return h*60+m;};
/** Discover due work first. A queue refusal or human conversation never consumes it. */
export function tickProactive(time=now()) {
 if(!enqueueFn||!db.open)return;schema();
 for(const r of db.prepare('SELECT * FROM proactivity WHERE enabled=1').all() as any[]) {
  if(legacyWorkHeld(r.user_id))continue;
  try {
   const {date,hm}=localParts(r.timezone,time);
   for(const slot of JSON.parse(r.times) as string[])if(minutes(hm)>=minutes(slot)&&r.last_fired!==`${date} ${slot}`)db.prepare("INSERT OR IGNORE INTO proactive_due_slots(user_id,slot_key,status,created_at) VALUES(?,?,'pending',?)").run(r.user_id,`${date} ${slot}`,time);
   // Persisted earlier slots remain eligible beyond their discovery window.
   const due=db.prepare("SELECT slot_key FROM proactive_due_slots WHERE user_id=? AND status='pending' ORDER BY slot_key LIMIT 1").get(r.user_id) as any;
   if(!due)continue;
   db.transaction(()=>{
    const jobId=fireCheckin(r.user_id,r.silent_streak,false,due.slot_key);
    if(!jobId)return;
    db.prepare("UPDATE proactive_due_slots SET status='admitted',job_id=?,admitted_at=? WHERE user_id=? AND slot_key=? AND status='pending'").run(jobId,now(),r.user_id,due.slot_key);
    db.prepare('UPDATE proactivity SET last_fired=? WHERE user_id=?').run(due.slot_key,r.user_id);
   })();
  }catch(e){console.warn('[proactive]',r.user_id,(e as Error).message);}
 }
}
export function fireCheckin(userId:string,silentStreak=0,force=false,slotKey?:string) {
 assertTenant(userId);if(legacyWorkHeld(userId))return;
 const primary=db.prepare("SELECT id FROM bots WHERE user_id=? AND is_primary=1 AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')!='room'").get(userId) as any;
 if(!primary||!enqueueFn||botOccupied(primary.id))return;
 const lastHuman=db.prepare(`SELECT MAX(r.created_at) t FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.kind='message'
 AND json_extract(r.body,'$.role')='user' AND COALESCE(json_extract(r.body,'$.from.kind'),'human') IN ('human','user','voice','imessage','sms','whatsapp')
 AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'`).get(userId) as any;
 if(!force&&lastHuman?.t&&now()-lastHuman.t<20*60000)return;
 const period=(slotKey??new Date().toISOString()).slice(0,10),synopsis=dailySynopsisContext(userId,period);
 const text=`[check-in] Scheduled proactive check-in. Use current facts below and inspect unresolved decisions or real results if useful. Send ONE concise user message only when useful; otherwise call stay_silent. A finished model turn is not proof of task acceptance or delivery.${silentStreak>=3?' Staying silent is fine.':''}\n${JSON.stringify(synopsis)}\nIf producing a daily report, create a report artifact and deliver it through the existing artifact delivery tools. Coverage requires its durable delivery receipt.`;
 const jobId=enqueueFn(primary.id,{type:'system',text,proactiveSlotKey:slotKey,coordinationReportPeriod:period});
 if(typeof jobId!=='string')return; // Legacy callbacks can run, but cannot consume durable due work.
 if(!db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(jobId,userId,primary.id))throw new Error('Check-in did not receive a durable admission.');
 bindReportIntent(userId,jobId,period,synopsis.sources);return jobId;
}
