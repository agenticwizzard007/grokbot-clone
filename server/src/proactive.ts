import { legacyWorkHeld, assertLegacyWorkOpen } from './security/legacy-work.js';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { assertTenant } from './deployment.js';
import { botOccupied } from './coordination/requests.js';
import { dailySynopsisContext, bindReportIntent, createSynopsis, materializeSynopsis, dispatchSynopsis, resumeSynopses } from './coordination/reports.js';

let enqueueFn:((botId:string,t:any)=>string|void)|null=null;
let timer:ReturnType<typeof setInterval>|undefined;
const tasks=new Set<Promise<unknown>>();
function track(task:Promise<unknown>) {tasks.add(task);void task.catch(e=>console.warn('[synopsis]',(e as Error).message)).finally(()=>tasks.delete(task));}
export async function settleProactive() {while(tasks.size)await Promise.allSettled([...tasks]);}
function schema() {
 db.exec(`CREATE TABLE IF NOT EXISTS proactivity (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,
 times TEXT NOT NULL DEFAULT '["09:00"]',timezone TEXT NOT NULL DEFAULT 'UTC',last_fired TEXT,
 silent_streak INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS proactive_due_slots (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,slot_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','admitted')),job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,admitted_at INTEGER,PRIMARY KEY(user_id,slot_key));`);
 const columns=(table:string)=>new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c=>c.name));
 const p=columns('proactivity');
 for(const [name,type] of Object.entries({discovered_local:'TEXT',quiet_hours:"TEXT NOT NULL DEFAULT '[]'",timezone_source:"TEXT NOT NULL DEFAULT 'explicit'"}))if(!p.has(name))db.exec(`ALTER TABLE proactivity ADD COLUMN ${name} ${type}`);
 const s=columns('proactive_due_slots');
 for(const [name,type] of Object.entries({first_slot:'TEXT',slot_count:'INTEGER NOT NULL DEFAULT 1',timezone:'TEXT',report_id:'TEXT'}))if(!s.has(name))db.exec(`ALTER TABLE proactive_due_slots ADD COLUMN ${name} ${type}`);
}
export function initProactive(enqueue:(botId:string,t:any)=>string|void) {
 schema();enqueueFn=enqueue;if(timer)clearInterval(timer);
 timer=setInterval(()=>tickProactive(),60000);timer.unref();
 // Discover missed slots immediately on startup; no model/queue availability required.
 tickProactive();return ()=>{if(timer)clearInterval(timer);timer=undefined;};
}
function defaultTimezone(userId:string) {
 const columns=db.prepare('PRAGMA table_info(users)').all() as any[];
 const tz=columns.some(c=>c.name==='timezone')?(db.prepare('SELECT timezone FROM users WHERE id=?').get(userId) as any)?.timezone:null;
 if(tz){try{new Intl.DateTimeFormat('en-US',{timeZone:tz});return {timezone:tz,timezoneSource:'account'};}catch{}}
 return {timezone:'UTC',timezoneSource:'utc_fallback'};
}
export function getCheckins(userId:string) {
 assertTenant(userId);schema();const r=db.prepare('SELECT * FROM proactivity WHERE user_id=?').get(userId) as any;
 return r?{enabled:!!r.enabled,times:JSON.parse(r.times) as string[],timezone:r.timezone,timezoneSource:r.timezone_source,quietHours:JSON.parse(r.quiet_hours) as Array<{start:string;end:string}>}:
 {enabled:false,times:['09:00'],...defaultTimezone(userId),quietHours:[] as Array<{start:string;end:string}>};
}
const validTime=(t:unknown):t is string=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
export function setCheckins(userId:string,p:{enabled?:boolean;times?:string[];timezone?:string;quietHours?:Array<{start:string;end:string}>},time=now()) {
 assertTenant(userId);assertLegacyWorkOpen(userId);const cur=getCheckins(userId);
 if(p.enabled!==undefined&&typeof p.enabled!=='boolean')throw new Error('Enabled must be a boolean.');
 if(p.times!==undefined&&(!Array.isArray(p.times)||p.times.length>6||!p.times.every(validTime)))throw new Error('Choose at most six valid HH:MM times.');
 const times=p.times===undefined?cur.times:[...new Set(p.times)].sort(),tz=p.timezone??cur.timezone;
 if(typeof tz!=='string'||tz.length>100)throw new Error('Invalid timezone.');new Intl.DateTimeFormat('en-US',{timeZone:tz});
 const quiet=p.quietHours??cur.quietHours;
 if(!Array.isArray(quiet)||quiet.length>6||quiet.some(q=>!q||!validTime(q.start)||!validTime(q.end)))throw new Error('Invalid quiet hours.');
 const changed=JSON.stringify(times)!==JSON.stringify(cur.times)||tz!==cur.timezone||(p.enabled===true&&!cur.enabled);
 const local=localParts(tz,time),baseline=`${local.date} ${local.hm}`;
 db.transaction(()=>{
  db.prepare(`INSERT INTO proactivity(user_id,enabled,times,timezone,quiet_hours,timezone_source,discovered_local,updated_at) VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,times=excluded.times,timezone=excluded.timezone,quiet_hours=excluded.quiet_hours,
  timezone_source=excluded.timezone_source,discovered_local=CASE WHEN ? THEN excluded.discovered_local ELSE proactivity.discovered_local END,updated_at=excluded.updated_at`)
  .run(userId,(p.enabled??cur.enabled)?1:0,JSON.stringify(times),tz,JSON.stringify(quiet),p.timezone!==undefined?'explicit':cur.timezoneSource,baseline,time,changed?1:0);
  // These rows have no dispatch and can safely be cancelled on schedule changes.
  if(changed||p.enabled===false)db.prepare("DELETE FROM proactive_due_slots WHERE user_id=? AND status='pending' AND report_id IS NULL").run(userId);
 })();return getCheckins(userId);
}
export function noteCheckinOutcome(userId:string,sentMessage:boolean) {
 assertTenant(userId);if(legacyWorkHeld(userId))return;schema();db.prepare('UPDATE proactivity SET silent_streak=CASE WHEN ? THEN 0 ELSE silent_streak+1 END WHERE user_id=?').run(sentMessage?1:0,userId);
}
export function localParts(tz:string,time:number) {
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time)).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,hm:`${p.hour}:${p.minute}`};
}
const primary=(userId:string)=>(db.prepare("SELECT id FROM bots WHERE user_id=? AND is_primary=1 AND COALESCE(hidden,0)=0 AND parent_bot_id IS NULL AND COALESCE(kind,'agent')!='room'").get(userId) as any)?.id as string|undefined;
function recentHuman(userId:string,time:number) {
 const last=db.prepare(`SELECT MAX(r.created_at) t FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.kind='message'
 AND json_extract(r.body,'$.role')='user' AND COALESCE(json_extract(r.body,'$.from.kind'),'human') IN ('human','user','voice','imessage','sms','whatsapp')
 AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'`).get(userId) as any;
 return !!last?.t&&time>=last.t&&time-last.t<20*60000;
}
/** Local calendar arithmetic makes a repeated time one durable slot; a nonexistent
 * local slot becomes due at the first observed valid minute after the DST gap.
 * Coalescing is O(number of configured times), even after years offline.
 */
function discover(r:any,time:number) {
 const p=localParts(r.timezone,time),through=`${p.date} ${p.hm}`;
 let baseline=r.discovered_local??(()=>{const x=localParts(r.timezone,r.updated_at);return `${x.date} ${x.hm}`;})();
 // Upgrade existing schedules from their last admitted local slot, not from
 // the much older settings edit. Existing uncertain/materialized work stays intact.
 if(typeof r.last_fired==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.last_fired)&&r.last_fired>baseline)baseline=r.last_fired;
 if(through<=baseline)return;
 const startDate=baseline.slice(0,10),endDate=p.date;
 const startDay=Date.parse(startDate+'T00:00:00Z')/86400000,endDay=Date.parse(endDate+'T00:00:00Z')/86400000;
 const times=(JSON.parse(r.times) as string[]).filter(validTime).sort();let count=0,first:string|undefined,last:string|undefined;
 for(const slot of times){
  let firstDay=startDay+(slot<=baseline.slice(11)?1:0),lastDay=endDay-(slot>p.hm?1:0);
  if(firstDay>lastDay)continue;
  count+=lastDay-firstDay+1;
  const f=`${new Date(firstDay*86400000).toISOString().slice(0,10)} ${slot}`,l=`${new Date(lastDay*86400000).toISOString().slice(0,10)} ${slot}`;
  if(!first||f<first)first=f;if(!last||l>last)last=l;
 }
 db.transaction(()=>{
  if(count&&last&&first){
   const pending=db.prepare("SELECT * FROM proactive_due_slots WHERE user_id=? AND status='pending' AND report_id IS NULL ORDER BY slot_key").all(r.user_id) as any[];
   for(const d of pending){count+=d.slot_count;const f=d.first_slot??d.slot_key;if(f<first!)first=f;if(d.slot_key>last!)last=d.slot_key;}
   db.prepare("DELETE FROM proactive_due_slots WHERE user_id=? AND status='pending' AND report_id IS NULL").run(r.user_id);
   db.prepare("INSERT OR IGNORE INTO proactive_due_slots(user_id,slot_key,first_slot,slot_count,timezone,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(r.user_id,last,first,count,r.timezone,time);
  }
  db.prepare('UPDATE proactivity SET discovered_local=? WHERE user_id=?').run(through,r.user_id);
 })();
}
function quietNow(quiet:Array<{start:string;end:string}>,hm:string) {return quiet.some(q=>q.start===q.end||(q.start<q.end?hm>=q.start&&hm<q.end:hm>=q.start||hm<q.end));}
function runSynopsis(userId:string,id:string,time:number) {
 track((async()=>{await materializeSynopsis(userId,id,time);
  // Settings can be disabled during optional narrative generation.
  if(!legacyWorkHeld(userId)&&getCheckins(userId).enabled)await dispatchSynopsis(userId,id);
 })());
}
/** Durable missed-slot discovery is independent of agent queue admission. */
export function tickProactive(time=now()) {
 if(!db.open)return;schema();
 for(const r of db.prepare('SELECT * FROM proactivity WHERE enabled=1').all() as any[]){
  if(legacyWorkHeld(r.user_id))continue;
  try{
   discover(r,time);const p=localParts(r.timezone,time);
   if(quietNow(JSON.parse(r.quiet_hours),p.hm)||recentHuman(r.user_id,time))continue;
   const botId=primary(r.user_id);if(!botId)continue;
   const due=db.prepare("SELECT * FROM proactive_due_slots WHERE user_id=? AND status='pending' ORDER BY slot_key LIMIT 1").get(r.user_id) as any;
   if(due){
    const id=db.transaction(()=>{
     const id=createSynopsis({userId:r.user_id,botId,slotKey:due.slot_key,firstSlot:due.first_slot??due.slot_key,slotCount:due.slot_count,timezone:due.timezone??r.timezone,time});
     db.prepare("UPDATE proactive_due_slots SET status='admitted',report_id=?,admitted_at=? WHERE user_id=? AND slot_key=? AND status='pending'").run(id,time,r.user_id,due.slot_key);
     db.prepare('UPDATE proactivity SET last_fired=? WHERE user_id=?').run(due.slot_key,r.user_id);return id;
    })();runSynopsis(r.user_id,id,time);
   }
  }catch(e){console.warn('[proactive]',r.user_id,(e as Error).message);}
 }
 track(resumeSynopses(time));
}
export function requestSynopsisNow(userId:string,key?:string,time=now()) {
 assertTenant(userId);assertLegacyWorkOpen(userId);const settings=getCheckins(userId),botId=primary(userId);if(!botId)throw new Error('Primary teammate unavailable.');
 if(key!==undefined&&(!key||key.length>100||/[^\x21-\x7e]/.test(key)))throw new Error('Invalid idempotency key.');
 const id=createSynopsis({userId,botId,slotKey:`manual:${key??localParts(settings.timezone,time).date}`,timezone:settings.timezone,time});
 track((async()=>{await materializeSynopsis(userId,id,time);await dispatchSynopsis(userId,id);})());return id;
}

/** Compatibility for explicitly requested conversational check-ins. Scheduled daily
 * synopses use the independent artifact lifecycle above, so model silence cannot lose a day.
 */
export function fireCheckin(userId:string,_silentStreak=0,force=false,slotKey?:string) {
 assertTenant(userId);if(legacyWorkHeld(userId))return;
 const botId=primary(userId);if(!botId||!enqueueFn||botOccupied(botId)||!force&&recentHuman(userId,now()))return;
 const period=(slotKey??new Date().toISOString()).slice(0,10),synopsis=dailySynopsisContext(userId,period);
 const text=`[check-in] Requested check-in. Use canonical facts below. State current blockers, decisions and coverage gaps honestly. A finished model turn is not proof of acceptance or delivery. If a synopsis is requested, a no-change report is valid. Save and deliver a report artifact with exact source references.\n${JSON.stringify(synopsis)}`;
 const jobId=enqueueFn(botId,{type:'system',text,proactiveSlotKey:slotKey??`manual:${newId('checkin')}`,coordinationReportPeriod:period});
 if(typeof jobId!=='string')return;
 if(!db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(jobId,userId,botId))throw new Error('Check-in did not receive a durable admission.');
 bindReportIntent(userId,jobId,period,synopsis.sources);return jobId;
}
/** The account's IANA time zone, or UTC when none is known (R2F-017: new routines use it by default). */
export function accountTimezone(userId:string):string {
 return defaultTimezone(userId).timezone;
}
/**
 * MF-017 and R2F-017: a schedule that follows the account zone (it fell back to UTC, or already took the
 * account zone) moves with every account zone change. Explicit choices are never overwritten. Pending
 * slots computed in the old zone are rediscovered in the new one. Returns whether a schedule changed.
 */
export function adoptAccountTimezone(userId:string,tz:string,time=now()) {
 assertTenant(userId);schema();new Intl.DateTimeFormat('en-US',{timeZone:tz});
 const local=localParts(tz,time);
 return db.transaction(()=>{
  const changed=db.prepare("UPDATE proactivity SET timezone=?,timezone_source='account',discovered_local=?,updated_at=? WHERE user_id=? AND timezone_source IN ('utc_fallback','account') AND timezone IS NOT ?").run(tz,`${local.date} ${local.hm}`,time,userId,tz).changes>0;
  if(changed)db.prepare("DELETE FROM proactive_due_slots WHERE user_id=? AND status='pending' AND report_id IS NULL").run(userId);
  return changed;
 })();
}
