/** Trusted recovery service. Restores a private environment into a new, unpublished directory only. */
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { Directory } from './directory.js';
import type { TenantEnvelopes } from './envelopes.js';
import { backupLocation, MAX_BACKUP_BYTES, MAX_BACKUP_PARTS, type BackupStorage } from './backup-storage.js';
import { restoreEnvironment } from './backup.js';

export async function restoreTenantEnvironment(directory:Directory,envelopes:TenantEnvelopes,storage:BackupStorage,input:{tenant:string;fullBackup:string;databaseBackup?:string;destination:string;volume:string}){
  backupLocation(input.tenant,input.fullBackup);
  if(input.databaseBackup)backupLocation(input.tenant,input.databaseBackup);
  if(!path.isAbsolute(input.destination)||fs.existsSync(input.destination))throw new Error('Recovery requires a new absolute destination.');
  const parent=path.dirname(input.destination);if(fs.realpathSync(parent)!==parent)throw new Error('Unsafe recovery parent.');
  const owner=(await directory.pool.query("SELECT generation FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted','failed')",[input.tenant])).rows[0];
  if(!owner)throw new Error('Recovery owner unavailable.');
  const work=fs.mkdtempSync(path.join(parent,'.swarm-recovery-')),result=path.join(work,'environment');
  let master:Buffer|undefined;
  try{
    master=await envelopes.key(input.tenant);
    async function restore(id:string,destination:string,scope:'environment'|'database'){
      const record=(await directory.pool.query("SELECT * FROM backups WHERE tenant_id=$1 AND id=$2 AND state='complete' AND expires_at>now()",[input.tenant,id])).rows[0];
      if(!record||record.scope!==scope)throw new Error('Backup not found.');
      const parts=(await directory.pool.query("SELECT name,bytes,sha256 FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND state='ready' ORDER BY name",[input.tenant,id])).rows;
      if(parts.length!==record.expected_parts||parts.length>MAX_BACKUP_PARTS||parts.reduce((n,p)=>n+Number(p.bytes),0)>MAX_BACKUP_BYTES)throw new Error('Invalid recovery inventory.');
      const bundle=path.join(work,id);fs.mkdirSync(bundle,{mode:0o700});
      for(const part of parts){
        backupLocation(input.tenant,id,part.name);
        const object=await storage.get(input.tenant,id,part.name);
        if(object.bytes!==Number(part.bytes)){object.body.destroy();throw new Error('Recovery size mismatch.');}
        const hash=createHash('sha256');let count=0;
        const meter=new Transform({transform(chunk,_encoding,cb){count+=chunk.length;if(count>Number(part.bytes))return cb(new Error('Recovery byte limit exceeded.'));hash.update(chunk);cb(null,chunk);}});
        await pipeline(object.body,meter,fs.createWriteStream(path.join(bundle,part.name),{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(120000)});
        if(count!==Number(part.bytes)||hash.digest('hex')!==part.sha256)throw new Error('Recovery object checksum mismatch.');
      }
      const restored=await restoreEnvironment(bundle,destination,input.tenant,id,input.volume,master!);
      if(restored.scope!==scope)throw new Error('Backup scope mismatch.');
      return {id,snapshotAt:restored.createdAt};
    }
    const full=await restore(input.fullBackup,result,'environment');
    let database=full;
    if(input.databaseBackup){
      const newer=path.join(work,'database');database=await restore(input.databaseBackup,newer,'database');
      if(Date.parse(database.snapshotAt)<Date.parse(full.snapshotAt))throw new Error('Database checkpoint predates full backup.');
      fs.copyFileSync(path.join(newer,'app/swarm.db'),path.join(result,'app/swarm.db'));
    }
    // Revocation or a concurrent cutover during this slow workflow prevents publication.
    if(!(await directory.pool.query("SELECT 1 FROM tenants WHERE id=$1 AND generation=$2 AND state NOT IN ('deleting','deleted','failed')",[input.tenant,owner.generation])).rowCount)throw new Error('Recovery authorization changed.');
    const receipt={id:randomBytes(16).toString('hex'),tenant:input.tenant,volume:input.volume,full,database,sourceGeneration:String(owner.generation),restoredAt:new Date().toISOString(),routingChanged:false};
    fs.writeFileSync(path.join(result,'recovery-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    // mkdir publication lock refuses concurrent restorers, including an empty existing destination.
    fs.mkdirSync(input.destination,{mode:0o700});
    try{
      for(const item of fs.readdirSync(result).filter(item=>item!=='recovery-receipt.json'))fs.renameSync(path.join(result,item),path.join(input.destination,item));
      // Publish the completion marker last. A directory left by process death is
      // unusable until this receipt exists; routing is a separate fenced action.
      fs.renameSync(path.join(result,'recovery-receipt.json'),path.join(input.destination,'recovery-receipt.json'));
    }
    catch(error){fs.rmSync(input.destination,{recursive:true,force:true});throw error;}
    return receipt;
  }finally{master?.fill(0);fs.rmSync(work,{recursive:true,force:true});}
}
