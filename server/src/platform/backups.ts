import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { Directory,opaqueToken } from './directory.js';
import type {PoolClient} from 'pg';
import type { RuntimeIdentity } from './runtime-identity.js';
import { backupLocation, MAX_BACKUP_BYTES, MAX_BACKUP_PARTS, type BackupStorage } from './backup-storage.js';
import {checkedBackupUpload} from './backup-upload.js';
import {backupWriterAuthorized} from './host-checkpoints.js';

export class BackupCatalog {
  constructor(readonly directory:Directory,readonly storage:BackupStorage){}
  async report(owner:{tenant:string;generation:string},input:{lastDatabase?:number;lastEnvironment?:number;pending?:string;error?:string}){
    if(Object.keys(input).some(k=>!['lastDatabase','lastEnvironment','pending','error'].includes(k))||[input.lastDatabase,input.lastEnvironment].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0||n>Date.now()+60000))||input.pending!==undefined&&!/^[a-f0-9]{32}$/.test(input.pending)||input.error!==undefined&&input.error!=='backup_requires_retry')throw new Error('Invalid backup status.');
    const stored=await this.directory.pool.query(`INSERT INTO backup_status(tenant_id,generation,last_database_at,last_environment_at,pending_id,error_code)
      SELECT id,generation,$3,$4,$5,$6 FROM tenants WHERE id=$1 AND generation=$2 AND state='active'
      ON CONFLICT(tenant_id) DO UPDATE SET generation=excluded.generation,last_database_at=excluded.last_database_at,last_environment_at=excluded.last_environment_at,pending_id=excluded.pending_id,error_code=excluded.error_code,reported_at=now() RETURNING tenant_id`,
      [owner.tenant,owner.generation,input.lastDatabase===undefined?null:new Date(input.lastDatabase),input.lastEnvironment===undefined?null:new Date(input.lastEnvironment),input.pending??null,input.error??null]);
    if(!stored.rowCount)throw new Error('Runtime revoked.');
  }
  /** Metadata-only input for an operator's alert exporter; never returns backup contents. */
  async health(){
    return (await this.directory.pool.query(`SELECT t.id AS tenant,t.state,s.error_code,
      s.reported_at,s.last_database_at,s.last_environment_at,
      (s.tenant_id IS NULL OR s.reported_at<now()-interval '3 minutes') AS reporter_stale,
      (s.last_database_at IS NULL OR s.last_database_at<now()-interval '5 minutes') AS database_overdue,
      (s.last_environment_at IS NULL OR s.last_environment_at<now()-interval '24 hours') AS environment_overdue
      FROM tenants t LEFT JOIN backup_status s ON s.tenant_id=t.id WHERE t.state='active'`)).rows;
  }
  async begin(owner:{tenant:string;generation:string},input:{id:string;scope:string;parts:number;bytes:number}){
    backupLocation(owner.tenant,input.id);
    if(!['database','environment'].includes(input.scope)||!Number.isSafeInteger(input.parts)||input.parts<2||input.parts>MAX_BACKUP_PARTS||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>MAX_BACKUP_BYTES)throw new Error('Invalid backup inventory.');
    await this.directory.transaction(async c=>{
      if(!(await c.query("SELECT 1 FROM tenants WHERE id=$1 AND generation=$2 AND state='active' FOR UPDATE",[owner.tenant,owner.generation])).rowCount)throw new Error('Runtime revoked.');
      await c.query(`INSERT INTO backups(tenant_id,id,generation,scope,expected_parts,expected_bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+CASE WHEN $4='database' THEN interval '1 hour' ELSE interval '7 days' END)
        ON CONFLICT DO NOTHING`,[owner.tenant,input.id,owner.generation,input.scope,input.parts,input.bytes]);
      const b=(await c.query('SELECT * FROM backups WHERE tenant_id=$1 AND id=$2',[owner.tenant,input.id])).rows[0];
      if(b.scope!==input.scope||Number(b.expected_parts)!==input.parts||Number(b.expected_bytes)!==input.bytes||String(b.generation)!==owner.generation||!['uploading','complete'].includes(b.state))throw new Error('Backup already finalized or changed.');
    });
  }
  async put(owner:{tenant:string;generation:string},id:string,name:string,body:Readable,bytes:number,sha256:string){
    try{
    backupLocation(owner.tenant,id,name);
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_BACKUP_BYTES||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid backup part.');
    const upload=opaqueToken();
    const admitted=await this.directory.transaction(async c=>{
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner.tenant]);
      const b=(await c.query(`SELECT b.* FROM backups b JOIN tenants t ON t.id=b.tenant_id WHERE b.tenant_id=$1 AND b.id=$2
        AND b.generation=$3 AND t.generation=b.generation AND ${backupWriterAuthorized} AND b.state IN ('uploading','complete') FOR UPDATE OF b`,[owner.tenant,id,owner.generation])).rows[0];
      if(!b)throw new Error('Backup unavailable.');
      const existing=(await c.query('SELECT *,lease_until>clock_timestamp() AS busy FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND name=$3',[owner.tenant,id,name])).rows[0];
      if(existing){if(Number(existing.bytes)!==bytes||existing.sha256!==sha256)throw new Error('Part cannot be replaced.');if(existing.state==='ready')return false;if(existing.state==='uploading'&&existing.busy)throw new Error('Upload already running.');}
      if(b.state==='complete')throw new Error('Finalized backup cannot change.');
      const totals=(await c.query('SELECT count(*) n,COALESCE(sum(bytes),0) bytes FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND name!=$3',[owner.tenant,id,name])).rows[0];
      if(Number(totals.n)+1>Number(b.expected_parts)||Number(totals.bytes)+bytes>Number(b.expected_bytes))throw new Error('Inventory limit exceeded.');
      await c.query(`INSERT INTO backup_parts(tenant_id,backup_id,name,bytes,sha256,state,lease_until,upload_owner) VALUES($1,$2,$3,$4,$5,'uploading',clock_timestamp()+interval '3 minutes',$6)
        ON CONFLICT(tenant_id,backup_id,name) DO UPDATE SET state='uploading',lease_until=excluded.lease_until,upload_owner=excluded.upload_owner`,[owner.tenant,id,name,bytes,sha256,upload]);
      return true;
    });
    if(!admitted){body.destroy();return;}
    const authorized=async<T>(action:(client:PoolClient)=>Promise<T>,dispatch=false)=>this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner.tenant]);
      await client.query('SELECT id FROM backups WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[owner.tenant,id]);
      const valid=await client.query(`UPDATE backup_parts p SET lease_until=CASE WHEN $6 THEN clock_timestamp()+interval '3 minutes' ELSE p.lease_until END
        FROM backups b,tenants t WHERE p.tenant_id=$1 AND p.backup_id=$2 AND p.name=$3 AND p.upload_owner=$5
        AND p.state='uploading' AND p.lease_until>clock_timestamp() AND b.tenant_id=p.tenant_id AND b.id=p.backup_id AND b.state='uploading'
        AND b.generation=$4 AND t.id=b.tenant_id AND t.generation=$4 AND ${backupWriterAuthorized} RETURNING p.name`,[owner.tenant,id,name,owner.generation,upload,dispatch]);
      if(!valid.rowCount)throw new Error('Backup upload authorization changed.');
      return action(client);
    });
    try{
      await authorized(async()=>{},true);
      await checkedBackupUpload(this.storage,owner.tenant,id,{name,bytes,sha256},body,()=>authorized(async()=>{}));
      await authorized(async client=>{await client.query("UPDATE backup_parts SET state='ready',lease_until=NULL,upload_owner=NULL WHERE tenant_id=$1 AND backup_id=$2 AND name=$3 AND upload_owner=$4",[owner.tenant,id,name,upload]);});
    }catch(error){
      // Keep the outstanding lease on failure/lost acknowledgement. An old
      // request must never release its successor's lease or authorize cleanup.
      await this.directory.pool.query(`UPDATE backups b SET error_code='backup_upload_requires_retry' WHERE b.tenant_id=$1 AND b.id=$2 AND b.state='uploading'
        AND EXISTS(SELECT 1 FROM backup_parts p WHERE p.tenant_id=b.tenant_id AND p.backup_id=b.id AND p.name=$3 AND p.upload_owner=$4 AND p.state='uploading')`,[owner.tenant,id,name,upload]).catch(()=>{});
      throw error;
    }
    }finally{body.destroy();}
  }
  async complete(owner:{tenant:string;generation:string},id:string){
    backupLocation(owner.tenant,id);
    return this.directory.transaction(async c=>{
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner.tenant]);
      const b=(await c.query(`SELECT b.* FROM backups b JOIN tenants t ON t.id=b.tenant_id WHERE b.tenant_id=$1 AND b.id=$2 AND t.generation=$3
        AND b.generation=t.generation AND ${backupWriterAuthorized} AND b.state IN ('uploading','complete') FOR UPDATE OF b`,[owner.tenant,id,owner.generation])).rows[0];
      if(!b)throw new Error('Backup unavailable.');
      const parts=(await c.query('SELECT name,bytes,state FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2',[owner.tenant,id])).rows;
      if(parts.length!==b.expected_parts||parts.some(p=>p.state!=='ready')||parts.reduce((n,p)=>n+Number(p.bytes),0)!==Number(b.expected_bytes)||!parts.some(p=>p.name==='manifest.bin'))throw new Error('Backup inventory is incomplete.');
      await c.query("UPDATE backups SET state='complete',completed_at=COALESCE(completed_at,now()),error_code=NULL WHERE tenant_id=$1 AND id=$2",[owner.tenant,id]);
    });
  }
  /** Retryable expiration. Account deletion waits for this before deleting its key. */
  async prune(tenant?:string){
    if(tenant&&!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant))throw new Error('Invalid backup owner.');
    const rows=(await this.directory.pool.query(`SELECT tenant_id,id FROM backups WHERE state!='deleted' AND
      (($1::text IS NOT NULL AND tenant_id=$1) OR ($1::text IS NULL AND (expires_at<=now() OR (state='uploading' AND created_at<now()-interval '1 day')))) LIMIT 100`,[tenant??null])).rows;
    for(const row of rows){
      const admitted=await this.directory.transaction(async client=>{
        // Same lock order as installation staging. A recovery admitted before
        // expiry retains its immutable inputs until publication or revocation.
        await client.query('SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE',[row.tenant_id]);
        const result=await client.query(`UPDATE backups b SET state='deleting' WHERE tenant_id=$1 AND id=$2 AND
          ($3::boolean OR NOT EXISTS(SELECT 1 FROM host_installations i JOIN tenants t ON t.id=i.tenant_id
            WHERE i.tenant_id=b.tenant_id AND i.state='pending' AND i.generation=t.generation AND t.state='provisioning'
            AND (i.full_backup=b.id OR i.database_backup=b.id)) AND NOT EXISTS(SELECT 1 FROM environment_operations o JOIN tenants t ON t.id=o.tenant_id
              WHERE o.tenant_id=b.tenant_id AND o.target_generation=t.generation AND o.phase NOT IN ('completed','cancelled')
              AND t.state NOT IN ('deleting','deleted') AND (o.full_backup=b.id OR o.database_backup=b.id))
            AND NOT EXISTS(SELECT 1 FROM migration_transfers x JOIN migration_runs m ON m.id=x.migration_id JOIN tenants t ON t.id=x.tenant_id
              WHERE x.tenant_id=b.tenant_id AND x.backup_id=b.id AND x.state IN ('uploading','complete')
              AND m.phase NOT IN ('active','rolled_back','cancelled') AND t.state NOT IN ('deleting','deleted'))
            AND NOT EXISTS(SELECT 1 FROM host_checkpoints q JOIN migration_runs m ON m.id=q.migration_id JOIN tenants t ON t.id=q.tenant_id
              WHERE q.tenant_id=b.tenant_id AND q.id=b.checkpoint_id AND q.backup_id=b.id AND q.state!='cancelled'
              AND m.phase NOT IN ('rolled_back','cancelled') AND t.state NOT IN ('deleting','deleted'))) RETURNING id`,[row.tenant_id,row.id,!!tenant]);
        return !!result.rowCount;
      });
      if(!admitted)continue;
      const busy=await this.directory.pool.query("SELECT 1 FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND state='uploading' AND lease_until>now()",[row.tenant_id,row.id]);
      if(busy.rowCount)throw new Error('Backup upload cleanup is pending.');
      try{await this.storage.remove(row.tenant_id,row.id);await this.directory.pool.query("UPDATE backups SET state='deleted',error_code=NULL WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);}
      catch(error){await this.directory.pool.query("UPDATE backups SET error_code='storage_cleanup_requires_retry' WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);throw error;}
    }
    if(tenant&&(await this.directory.pool.query("SELECT 1 FROM backups WHERE tenant_id=$1 AND state!='deleted' LIMIT 1",[tenant])).rowCount)throw new Error('Backup cleanup has remaining batches.');
  }
}
export function backupRoutes(catalog:BackupCatalog,runtime:RuntimeIdentity){
  const app=new Hono<{Variables:{owner:{tenant:string;generation:string}}}>();
  app.use('*',async(c,next)=>{
    try{c.set('owner',await runtime.verify((c.req.header('authorization')??'').replace(/^Bearer /,''),'swarm-host'));}
    catch{return c.json({error:'Host authorization required.'},401);}return next();
  });
  app.onError((_e,c)=>c.json({error:'Backup operation refused or requires retry.'},409));
  app.post('/',async c=>{const b=await c.req.json();if(Object.keys(b).some(k=>!['id','scope','parts','bytes'].includes(k)))return c.json({error:'Invalid backup inventory.'},400);await catalog.begin(c.get('owner'),b);return c.json({ok:true});});
  app.post('/status',async c=>{await catalog.report(c.get('owner'),await c.req.json());return c.json({ok:true});});
  app.put('/:id/:name',async c=>{
    const bytes=Number(c.req.header('content-length'));
    if(!c.req.raw.body&&bytes!==0)return c.json({error:'Missing backup part.'},400);
    await catalog.put(c.get('owner'),c.req.param('id'),c.req.param('name'),c.req.raw.body?Readable.fromWeb(c.req.raw.body as any):Readable.from([]),bytes,c.req.header('x-backup-sha256')??'');return c.json({ok:true});
  });
  app.post('/:id/complete',async c=>{await catalog.complete(c.get('owner'),c.req.param('id'));return c.json({ok:true});});
  app.get('/',async c=>c.json({backups:(await catalog.directory.pool.query("SELECT id,scope,state,created_at,completed_at,expires_at,error_code FROM backups WHERE tenant_id=$1 AND state!='deleted' ORDER BY created_at DESC LIMIT 500",[c.get('owner').tenant])).rows}));
  return app;
}
