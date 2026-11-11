import type Database from 'better-sqlite3';

interface Event { id:string;ciphertext:string }
interface Delivery {
  open(event:Event):unknown;
  authorize(payload:any):Promise<void>;
  /** Record durable work only. Must use this database's synchronous transaction. */
  apply(payload:any,event:Event):void;
  retryable(error:unknown):boolean;
}
export function prepareEventInbox(db:Database.Database){
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_events(id TEXT PRIMARY KEY,received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_event_failures(id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL,error_code TEXT NOT NULL,received_at INTEGER NOT NULL);`);
}
/** Acknowledge only committed work or encrypted reconciliation records. A provider
 * outage leaves its events pending without blocking independent events in the page. */
export async function deliverRuntimeEvents(db:Database.Database,events:Event[],delivery:Delivery,clock=Date.now){
  if(!Array.isArray(events)||events.length>20)throw new Error('Invalid events.');
  const ack:string[]=[];
  for(const event of events){
    if(typeof event.id!=='string'||event.id.length>200||typeof event.ciphertext!=='string'||event.ciphertext.length>1024*1024)throw new Error('Invalid event.');
    if(db.prepare('SELECT 1 FROM runtime_events WHERE id=?').get(event.id)){ack.push(event.id);continue;}
    try{
      const payload=delivery.open(event);await delivery.authorize(payload);
      db.transaction(()=>{
        if(db.prepare('SELECT 1 FROM runtime_events WHERE id=?').get(event.id))return;
        delivery.apply(payload,event);
        db.prepare('INSERT INTO runtime_events VALUES(?,?)').run(event.id,clock());
      })();
    }catch(error){
      if(delivery.retryable(error))continue;
      db.transaction(()=>{
        db.prepare('INSERT OR IGNORE INTO runtime_event_failures VALUES(?,?,?,?)').run(event.id,event.ciphertext,'event_requires_reconciliation',clock());
        db.prepare('INSERT OR IGNORE INTO runtime_events VALUES(?,?)').run(event.id,clock());
      })();
    }
    ack.push(event.id);
  }
  return ack;
}
