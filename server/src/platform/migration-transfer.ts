/** Trusted operator transfer only. Never mounted as a tenant/browser API. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Directory,opaqueToken} from './directory.js';
import type {TenantEnvelopes} from './envelopes.js';
import type {MigrationSource,SourceCheckpoint} from './migration-coordinator.js';
import {prepareMigrationPackage,type MigrationPackageInput} from './migration-package.js';
import {backupEnvironment} from './backup.js';
import {backupLocation,MAX_BACKUP_BYTES,MAX_BACKUP_PARTS,type BackupStorage} from './backup-storage.js';
import {openOwnedFile} from '../security/files.js';
import {checkedBackupUpload} from './backup-upload.js';

interface Part {name:string;bytes:number;sha256:string}
interface Journal {
  version:1;tenant:string;operation:string;checkpoint:string;sourceFence:string;volume:string;
  backup:string;packageHash:string;parts:Part[];receipt:Awaited<ReturnType<typeof prepareMigrationPackage>>;
}
export interface MigrationTransferInput extends Omit<MigrationPackageInput,'targetKey'|'destination'> {
  operation:string;checkpoint:string;workDirectory:string;
}
const digest=(value:string)=>/^[a-f0-9]{64}$/.test(value);
class SourceChanged extends Error {}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const packageHash=(j:Omit<Journal,'packageHash'>)=>hash([j.version,j.tenant,j.operation,j.checkpoint,j.sourceFence,j.volume,j.backup,j.parts,j.receipt]);
function durable(file:string,value:unknown){
  const temporary=`${file}.new`,fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
async function partDigest(root:string,name:string):Promise<Part>{
  const fd=openOwnedFile(root,name),before=fs.fstatSync(fd),checksum=createHash('sha256');let bytes=0;
  try{
    if(before.nlink!==1||before.size<0||before.size>MAX_BACKUP_BYTES)throw new Error('Invalid migration part.');
    for await(const chunk of fs.createReadStream('',{fd,autoClose:false})){bytes+=chunk.length;if(bytes>before.size)throw new Error('Migration part changed.');checksum.update(chunk);}
    const after=fs.fstatSync(fd);
    if(bytes!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Migration part changed.');
    fs.fsyncSync(fd);return {name,bytes,sha256:checksum.digest('hex')};
  }finally{fs.closeSync(fd);}
}

/** Packages are admitted only for the coordinator's still-frozen export. The
 * local encrypted journal and directory binding must agree on every retry. */
export class MigrationTransfer {
  constructor(private directory:Directory,private envelopes:Pick<TenantEnvelopes,'create'|'key'>,private storage:BackupStorage,private source:Pick<MigrationSource,'inspect'|'frozen'|'stop'>){}
  async upload(input:MigrationTransferInput){
    if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)||! /^[A-Za-z0-9_-]{1,120}$/.test(input.operation)||!digest(input.checkpoint)||! /^[A-Za-z0-9_-]{1,120}$/.test(input.volume))throw new Error('Invalid migration transfer identity.');
    if(!path.isAbsolute(input.workDirectory)||fs.realpathSync(path.dirname(input.workDirectory))!==path.dirname(input.workDirectory))throw new Error('Migration workspace must have a canonical absolute parent.');
    const lease=opaqueToken(),owner=input.tenant;
    const operation=await this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner]);
      const row=(await client.query(`UPDATE migration_runs m SET lease_owner=$3,lease_until=clock_timestamp()+interval '2 minutes',fence=fence+1
        FROM tenants t,migration_destinations d WHERE m.tenant_id=$1 AND m.id=$2 AND m.phase='exporting' AND m.writer='none' AND m.source_checkpoint=$4
        AND (m.lease_until IS NULL OR m.lease_until<clock_timestamp()) AND t.id=m.tenant_id AND t.state='pending'
        AND d.tenant_id=t.id AND d.migration_id=m.id AND d.state='reserved' AND d.generation=t.generation AND d.volume_id=$5
        AND d.source_checkpoint=m.source_checkpoint AND d.source_fence=m.source_fence
        RETURNING m.*,t.generation`,[owner,input.operation,lease,input.checkpoint,input.volume])).rows[0];
      if(!row)throw new Error('Migration export is absent, changed, revoked or already leased.');return row;
    });
    const fenced=async<T>(action:(client:PoolClient)=>Promise<T>)=>this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner]);
      await client.query('SELECT id FROM migration_runs WHERE tenant_id=$1 FOR UPDATE',[owner]);
      const row=await client.query(`UPDATE migration_runs m SET lease_until=clock_timestamp()+interval '2 minutes' FROM tenants t,migration_destinations d
        WHERE m.tenant_id=$1 AND m.id=$2 AND m.lease_owner=$3 AND m.fence=$4 AND m.lease_until>clock_timestamp()
        AND m.phase='exporting' AND m.writer='none' AND m.source_checkpoint=$5 AND m.source_fence=$6
        AND t.id=m.tenant_id AND t.generation=$7 AND t.state='pending'
        AND d.tenant_id=t.id AND d.migration_id=m.id AND d.state='reserved' AND d.generation=t.generation AND d.volume_id=$8
        AND d.source_checkpoint=m.source_checkpoint AND d.source_fence=m.source_fence RETURNING m.id`,
      [owner,input.operation,lease,operation.fence,input.checkpoint,operation.source_fence,operation.generation,input.volume]);
      if(!row.rowCount)throw new Error('Migration transfer authorization changed.');return action(client);
    });
    const guard=async()=>{
      await fenced(async()=>{});
      try{
        const checkpoint=await this.source.inspect(owner,input.operation);
        this.requireSource(input,operation.source_fence,checkpoint);
        if(!await this.source.frozen(owner,operation.source_fence))throw new Error('not frozen');
      }catch{throw new SourceChanged('Migration requires the exact complete frozen source checkpoint.');}
      await fenced(async()=>{});
    };
    let heartbeatBusy=false,heartbeatError:unknown;
    const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void guard().catch(error=>{heartbeatError=error;}).finally(()=>{heartbeatBusy=false;});},20000).unref();
    const authorize=async()=>{if(heartbeatError)throw heartbeatError;await guard();};
    const environment=path.join(input.workDirectory,'environment'),bundle=path.join(input.workDirectory,'encrypted'),journalPath=path.join(input.workDirectory,'transfer.json');
    try{
      await authorize();
      if(!fs.existsSync(input.workDirectory))fs.mkdirSync(input.workDirectory,{mode:0o700});
      const workspace=fs.lstatSync(input.workDirectory);
      if(!workspace.isDirectory()||workspace.isSymbolicLink()||fs.realpathSync(input.workDirectory)!==input.workDirectory||workspace.uid!==process.getuid?.()||(workspace.mode&0o077)!==0)throw new Error('Migration workspace is not private.');
      const binding={version:1,tenant:owner,operation:input.operation,checkpoint:input.checkpoint,sourceFence:operation.source_fence,volume:input.volume};
      const bindingPath=path.join(input.workDirectory,'binding.json');
      if(fs.existsSync(bindingPath)){
        const fd=openOwnedFile(input.workDirectory,'binding.json');
        try{if(fs.fstatSync(fd).size>4096||JSON.stringify(JSON.parse(fs.readFileSync(fd,'utf8')))!==JSON.stringify(binding))throw new Error('Migration workspace belongs to another export.');}finally{fs.closeSync(fd);}
      }else{
        if(fs.readdirSync(input.workDirectory).length)throw new Error('Unbound migration workspace requires reconciliation.');
        durable(bindingPath,binding);
      }
      const cleanPlaintext=()=>{
        for(const name of fs.readdirSync(input.workDirectory))if(name==='environment'||/^environment\.preparing-[a-f0-9]{16}$/.test(name)||/^\.snapshot-[A-Za-z0-9]{6}$/.test(name))fs.rmSync(path.join(input.workDirectory,name),{recursive:true,force:true});
      };
      let journal:Journal;
      if(fs.existsSync(journalPath)){
        const fd=openOwnedFile(input.workDirectory,'transfer.json');
        try{if(fs.fstatSync(fd).size>32*1024*1024)throw new Error('Migration journal exceeded.');journal=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
        this.validateJournal(input,operation.source_fence,journal);
      }else{
        if((await this.directory.pool.query('SELECT 1 FROM migration_transfers WHERE tenant_id=$1',[owner])).rowCount)throw new Error('Admitted migration bundle is missing locally; reconcile its immutable inventory.');
        // These exact, private unpublished paths are safe to discard after a
        // packaging crash. No object upload occurs before the durable journal.
        cleanPlaintext();fs.rmSync(bundle,{recursive:true,force:true});fs.rmSync(`${journalPath}.new`,{force:true});
        await this.envelopes.create(owner);await authorize();const key=await this.envelopes.key(owner);
        try{
          await authorize();
          const receipt=await prepareMigrationPackage({...input,destination:environment,targetKey:key});
          if(receipt.requiresFileInventory)throw new Error('The legacy file/profile inventory is incomplete.');
          await authorize();
          const backup=await backupEnvironment(environment,bundle,owner,key,'environment');
          const names=fs.readdirSync(bundle).sort(),parts:Part[]=[];
          if(names.length<2||names.length>MAX_BACKUP_PARTS)throw new Error('Invalid migration part inventory.');
          for(const name of names){backupLocation(owner,backup.id,name);parts.push(await partDigest(bundle,name));}
          if(parts.reduce((n,p)=>n+p.bytes,0)>MAX_BACKUP_BYTES)throw new Error('Migration transfer exceeds storage allowance.');
          const draft={version:1 as const,tenant:owner,operation:input.operation,checkpoint:input.checkpoint,sourceFence:operation.source_fence,volume:input.volume,backup:backup.id,parts,receipt};
          journal={...draft,packageHash:packageHash(draft)};await authorize();durable(journalPath,journal);
        }finally{key.fill(0);cleanPlaintext();}
      }
      this.validateJournal(input,operation.source_fence,journal);
      const names=fs.readdirSync(bundle).sort();if(JSON.stringify(names)!==JSON.stringify(journal.parts.map(p=>p.name)))throw new Error('Migration bundle inventory changed.');
      for(const part of journal.parts){const actual=await partDigest(bundle,part.name);if(actual.bytes!==part.bytes||actual.sha256!==part.sha256)throw new Error('Migration encrypted part changed.');}
      cleanPlaintext();
      await authorize();
      await fenced(async client=>{
        await client.query(`INSERT INTO migration_transfers(tenant_id,migration_id,source_checkpoint,source_fence,package_hash,backup_id,generation,volume_id,expected_parts,expected_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id) DO NOTHING`,[owner,input.operation,input.checkpoint,operation.source_fence,journal.packageHash,journal.backup,operation.generation,input.volume,journal.parts.length,journal.parts.reduce((n,p)=>n+p.bytes,0)]);
        const record=(await client.query('SELECT * FROM migration_transfers WHERE tenant_id=$1 FOR UPDATE',[owner])).rows[0];
        if(record.migration_id!==input.operation||record.source_checkpoint!==input.checkpoint||record.source_fence!==journal.sourceFence||record.package_hash!==journal.packageHash||record.backup_id!==journal.backup||String(record.generation)!==String(operation.generation)||record.volume_id!==input.volume||!['uploading','complete'].includes(record.state))throw new Error('Migration transfer binding cannot change.');
        await client.query(`INSERT INTO backups(tenant_id,id,generation,scope,expected_parts,expected_bytes,expires_at)
          VALUES($1,$2,$3,'environment',$4,$5,clock_timestamp()+interval '7 days') ON CONFLICT DO NOTHING`,[owner,journal.backup,operation.generation,journal.parts.length,record.expected_bytes]);
        const backup=(await client.query('SELECT * FROM backups WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[owner,journal.backup])).rows[0];
        if(backup.scope!=='environment'||String(backup.generation)!==String(operation.generation)||backup.expected_parts!==journal.parts.length||Number(backup.expected_bytes)!==Number(record.expected_bytes)||!['uploading','complete'].includes(backup.state))throw new Error('Migration backup identity changed.');
      });
      for(const part of journal.parts){
        await authorize();
        const admitted=await fenced(async client=>{
          const backup=(await client.query('SELECT state FROM backups WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[owner,journal.backup])).rows[0];
          if(!backup||!['uploading','complete'].includes(backup.state))throw new Error('Migration upload revoked.');
          const saved=(await client.query('SELECT * FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND name=$3',[owner,journal.backup,part.name])).rows[0];
          if(saved&&(saved.sha256!==part.sha256||Number(saved.bytes)!==part.bytes))throw new Error('Migration part cannot be substituted.');
          if(saved?.state==='ready')return false;
          if(backup.state==='complete'||saved?.state==='uploading'&&new Date(saved.lease_until).getTime()>Date.now())throw new Error('A migration upload is still outstanding.');
          await client.query(`INSERT INTO backup_parts(tenant_id,backup_id,name,bytes,sha256,state,lease_until)
            VALUES($1,$2,$3,$4,$5,'uploading',clock_timestamp()+interval '3 minutes')
            ON CONFLICT(tenant_id,backup_id,name) DO UPDATE SET state='uploading',lease_until=excluded.lease_until`,[owner,journal.backup,part.name,part.bytes,part.sha256]);
          return true;
        });
        if(!admitted)continue;
        const fd=openOwnedFile(bundle,part.name),body=fs.createReadStream('',{fd,autoClose:true});
        try{
          await authorize();
          // Source checks may wait. Start the bounded upload lease at actual
          // dispatch, and refuse if deletion admitted cleanup in the meantime.
          await fenced(async client=>{
            if(!(await client.query(`UPDATE backup_parts p SET lease_until=clock_timestamp()+interval '3 minutes' FROM backups b
              WHERE p.tenant_id=$1 AND p.backup_id=$2 AND p.name=$3 AND p.state='uploading' AND p.sha256=$4
              AND b.tenant_id=p.tenant_id AND b.id=p.backup_id AND b.state='uploading' RETURNING p.name`,[owner,journal.backup,part.name,part.sha256])).rowCount)throw new Error('Migration upload revoked before dispatch.');
          });
          await checkedBackupUpload(this.storage,owner,journal.backup,part,body,authorize,'migration');
          await authorize();
          await fenced(async client=>{
            const changed=await client.query(`UPDATE backup_parts p SET state='ready',lease_until=NULL FROM backups b
              WHERE p.tenant_id=$1 AND p.backup_id=$2 AND p.name=$3 AND b.tenant_id=p.tenant_id AND b.id=p.backup_id AND b.state='uploading' RETURNING p.name`,[owner,journal.backup,part.name]);
            if(!changed.rowCount)throw new Error('Migration upload revoked.');
          });
        }catch(error){
          // Preserve the bounded outstanding lease even on failure: an upstream
          // write may have completed after losing its response. Cleanup/retry
          // must not race that upload, and stale workers cannot clear a new lease.
          await fenced(async client=>{await client.query("UPDATE backups SET error_code='migration_upload_requires_retry' WHERE tenant_id=$1 AND id=$2",[owner,journal.backup]);}).catch(()=>{});throw error;
        }finally{body.destroy();}
      }
      await authorize();
      await fenced(async client=>{
        const parts=(await client.query("SELECT name,bytes,sha256,state FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 ORDER BY name",[owner,journal.backup])).rows;
        if(parts.length!==journal.parts.length||parts.some((p,i)=>p.state!=='ready'||p.name!==journal.parts[i].name||Number(p.bytes)!==journal.parts[i].bytes||p.sha256!==journal.parts[i].sha256))throw new Error('Migration upload inventory is incomplete.');
        if(!(await client.query("UPDATE backups SET state='complete',completed_at=COALESCE(completed_at,clock_timestamp()),error_code=NULL WHERE tenant_id=$1 AND id=$2 AND state IN ('uploading','complete') RETURNING id",[owner,journal.backup])).rowCount)throw new Error('Migration backup revoked.');
        await client.query("UPDATE migration_transfers SET state='complete',completed_at=COALESCE(completed_at,clock_timestamp()) WHERE tenant_id=$1 AND package_hash=$2",[owner,journal.packageHash]);
      });
      return {tenant:owner,operation:input.operation,checkpoint:input.checkpoint,packageHash:journal.packageHash,backup:journal.backup,volume:input.volume,reconnect:journal.receipt.reconnect,routingChanged:false as const};
    }catch(error){
      if(error instanceof SourceChanged){
        let owned=false,metadataUnavailable=false;
        try{owned=await this.directory.transaction(async client=>{
            await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner]);
            return !!(await client.query(`UPDATE migration_runs SET phase='reconciliation',writer='unknown',error_code='source_freeze_requires_reconciliation'
              WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND fence=$4 AND lease_until>clock_timestamp() RETURNING id`,[owner,input.operation,lease,operation.fence])).rowCount;
          });}catch{metadataUnavailable=true;}
        if(owned||metadataUnavailable){
          // No destination runtime is activated by this transfer. Stop/fence the
          // source through the trusted adapter; failure remains explicitly unknown.
          const stopped=await this.source.stop(owner,`${input.operation}:contain`,String(operation.fence)).catch(()=>false);
          if(stopped&&owned)await this.directory.pool.query("UPDATE migration_runs SET writer='none' WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND fence=$4 AND phase='reconciliation'",[owner,input.operation,lease,operation.fence]);
        }
      }
      throw error;
    }finally{
      clearInterval(heartbeat);
      await this.directory.pool.query('UPDATE migration_runs SET lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND fence=$4',[owner,input.operation,lease,operation.fence]);
    }
  }
  private requireSource(input:MigrationTransferInput,fence:string,source:SourceCheckpoint|null){
    if(!source||source.tenant!==input.tenant||source.checkpoint!==input.checkpoint||source.fence!==fence||source.writersStopped!==true||source.filesFrozen!==true)throw new Error('Migration requires the exact complete frozen source checkpoint.');
  }
  private validateJournal(input:MigrationTransferInput,fence:string,j:Journal){
    if(!j||j.version!==1||j.tenant!==input.tenant||j.operation!==input.operation||j.checkpoint!==input.checkpoint||j.sourceFence!==fence||j.volume!==input.volume||!Array.isArray(j.parts)||j.parts.length<2||j.parts.length>MAX_BACKUP_PARTS||j.packageHash!==packageHash(j)||j.receipt?.tenant!==input.tenant||j.receipt.volume!==input.volume||j.receipt.requiresFileInventory!==false)throw new Error('Migration journal does not match the admitted export.');
    backupLocation(j.tenant,j.backup);
    let total=0;const names=new Set<string>();
    for(const part of j.parts){backupLocation(j.tenant,j.backup,part.name);if(names.has(part.name)||!Number.isSafeInteger(part.bytes)||part.bytes<0||!digest(part.sha256))throw new Error('Invalid migration journal part.');names.add(part.name);total+=part.bytes;}
    if(total>MAX_BACKUP_BYTES||!names.has('manifest.bin'))throw new Error('Invalid migration journal inventory.');
  }

}

/** Used by the target adapter before installation/activation; no caller-provided
 * backup ID can substitute for the admitted owner/checkpoint/package binding. */
export async function verifiedMigrationTransfer(directory:Directory,tenant:string,packageHash:string,checkpoint:string){
  if(!digest(packageHash)||!digest(checkpoint))return null;
  return (await directory.pool.query(`SELECT x.* FROM migration_transfers x JOIN migration_runs m ON m.id=x.migration_id AND m.tenant_id=x.tenant_id
    JOIN migration_destinations d ON d.tenant_id=x.tenant_id AND d.migration_id=m.id AND d.state='reserved'
      AND d.volume_id=x.volume_id AND d.generation=x.generation AND d.source_checkpoint=x.source_checkpoint AND d.source_fence=x.source_fence
    JOIN tenants t ON t.id=x.tenant_id JOIN backups b ON b.tenant_id=x.tenant_id AND b.id=x.backup_id
    WHERE x.tenant_id=$1 AND x.package_hash=$2 AND x.source_checkpoint=$3 AND x.source_checkpoint=m.source_checkpoint
    AND x.source_fence=m.source_fence AND x.generation=t.generation AND x.state='complete' AND b.state='complete'
    AND b.scope='environment' AND b.generation=x.generation AND b.expected_parts=x.expected_parts AND b.expected_bytes=x.expected_bytes
    AND (m.phase='exporting' OR m.package_hash=x.package_hash) AND m.phase IN ('exporting','prepared','frozen','activating','active')
    AND t.state NOT IN ('deleting','deleted','failed')`,[tenant,packageHash,checkpoint])).rows[0]??null;
}
