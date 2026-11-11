import {Hono} from 'hono';
import {Readable,Transform} from 'node:stream';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Directory} from './directory.js';
import type {RuntimeIdentity} from './runtime-identity.js';
import type {HostOwner} from './host-control.js';
import {backupLocation,MAX_BACKUP_BYTES,MAX_BACKUP_PARTS,type BackupStorage} from './backup-storage.js';

export interface InstallPlan extends HostOwner {id:string;volume:string;fullBackup:string;databaseBackup?:string;state:'pending'|'installed'}
export interface InstallPart {name:string;bytes:number;sha256:string}
export function installReceipt(plan:InstallPlan){return createHash('sha256').update(JSON.stringify([1,plan.tenant,plan.machine,plan.volume,plan.generation,plan.id,plan.fullBackup,plan.databaseBackup??null])).digest('hex');}

/** Called only by a trusted, fenced recovery/migration operation. The caller's
 * transaction must hold its lifecycle lease; no public staging API exists. */
export async function stageHostInstallation(client:PoolClient,plan:Omit<InstallPlan,'state'>){
  backupLocation(plan.tenant,plan.id);backupLocation(plan.tenant,plan.fullBackup);if(plan.databaseBackup)backupLocation(plan.tenant,plan.databaseBackup);
  const owner=await client.query(`SELECT 1 FROM tenants t WHERE id=$1 AND generation=$2 AND machine_id=$3 AND volume_id=$4 AND state='provisioning'
    AND NOT EXISTS(SELECT 1 FROM host_policies p WHERE p.tenant_id=t.id AND (p.desired='run' OR p.observed='running')) FOR UPDATE`,[plan.tenant,plan.generation,plan.machine,plan.volume]);
  if(!owner.rowCount)throw new Error('Installation requires a held, unpublished environment.');
  for(const [id,scope] of [[plan.fullBackup,'environment'],[plan.databaseBackup,'database']]){
    if(!id)continue;
    const transfer=(await client.query(`SELECT x.*,m.phase,m.package_hash AS approved_hash,m.source_checkpoint AS current_checkpoint,m.source_fence AS current_fence,
      (d.state='reserved' AND d.volume_id=x.volume_id AND d.generation=x.generation AND d.source_checkpoint=x.source_checkpoint AND d.source_fence=x.source_fence) AS destination_valid FROM migration_transfers x
      JOIN migration_runs m ON m.id=x.migration_id LEFT JOIN migration_destinations d ON d.tenant_id=x.tenant_id AND d.migration_id=m.id
      WHERE x.tenant_id=$1 AND x.backup_id=$2 AND m.phase!='active'`,[plan.tenant,id])).rows[0];
    if(transfer&&(transfer.state!=='complete'||transfer.destination_valid!==true||!['prepared','frozen','activating'].includes(transfer.phase)||transfer.approved_hash!==transfer.package_hash||transfer.source_checkpoint!==transfer.current_checkpoint||transfer.source_fence!==transfer.current_fence||String(transfer.generation)!==plan.generation||transfer.volume_id!==plan.volume))throw new Error('Migration installation binding changed.');
    if(!(await client.query(`SELECT 1 FROM backups b WHERE tenant_id=$1 AND id=$2 AND scope=$3 AND state='complete'
      AND (expires_at>now() OR EXISTS(SELECT 1 FROM environment_operations o WHERE o.tenant_id=b.tenant_id AND o.id=$4 AND o.target_generation=$5
        AND o.phase NOT IN ('completed','cancelled') AND (o.full_backup=b.id OR o.database_backup=b.id))
        OR EXISTS(SELECT 1 FROM migration_transfers x JOIN migration_runs m ON m.id=x.migration_id
          WHERE x.tenant_id=b.tenant_id AND x.backup_id=b.id AND x.state='complete' AND x.generation=$5
          AND x.volume_id=$6 AND x.source_checkpoint=m.source_checkpoint AND x.source_fence=m.source_fence
          AND m.package_hash=x.package_hash AND m.phase IN ('prepared','frozen','activating'))) FOR UPDATE`,[plan.tenant,id,scope,plan.id,plan.generation,plan.volume])).rowCount)throw new Error('Installation backup unavailable.');
  }
  await client.query(`INSERT INTO host_installations(tenant_id,id,machine_id,volume_id,generation,full_backup,database_backup)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id) DO NOTHING`,[plan.tenant,plan.id,plan.machine,plan.volume,plan.generation,plan.fullBackup,plan.databaseBackup??null]);
  const saved=(await client.query('SELECT * FROM host_installations WHERE tenant_id=$1',[plan.tenant])).rows[0];
  if(saved.id!==plan.id||saved.machine_id!==plan.machine||saved.volume_id!==plan.volume||String(saved.generation)!==plan.generation||saved.full_backup!==plan.fullBackup||(saved.database_backup??null)!==(plan.databaseBackup??null))throw new Error('Installation identity cannot be replaced.');
}
export class HostInstallations {
  constructor(readonly directory:Directory,private storage:BackupStorage){}
  async plan(owner:HostOwner):Promise<InstallPlan|null>{
    const row=(await this.directory.pool.query(`SELECT i.* FROM host_installations i JOIN tenants t ON t.id=i.tenant_id
      WHERE i.tenant_id=$1 AND i.generation=$2 AND i.machine_id=$3 AND t.generation=i.generation AND t.machine_id=i.machine_id
      AND t.volume_id=i.volume_id AND t.state='provisioning' AND NOT EXISTS(SELECT 1 FROM host_policies p WHERE p.tenant_id=t.id AND p.desired='run')`,[owner.tenant,owner.generation,owner.machine])).rows[0];
    return row?{...owner,id:row.id,volume:row.volume_id,fullBackup:row.full_backup,databaseBackup:row.database_backup??undefined,state:row.state}:null;
  }
  private async authorized(owner:HostOwner,id:string,backup?:string){
    const plan=await this.plan(owner);
    if(!plan||plan.id!==id||backup!==undefined&&backup!==plan.fullBackup&&backup!==plan.databaseBackup)throw new Error('Installation unavailable.');
    if(backup&&!(await this.directory.pool.query("SELECT 1 FROM backups WHERE tenant_id=$1 AND id=$2 AND state='complete'",[owner.tenant,backup])).rowCount)throw new Error('Installation backup unavailable.');
    return plan;
  }
  async parts(owner:HostOwner,id:string,backup:string,after:string=''){
    await this.authorized(owner,id,backup);backupLocation(owner.tenant,backup);if(after)backupLocation(owner.tenant,backup,after);
    const totals=(await this.directory.pool.query("SELECT expected_parts,expected_bytes FROM backups WHERE tenant_id=$1 AND id=$2 AND state='complete'",[owner.tenant,backup])).rows[0];
    if(!totals||totals.expected_parts>MAX_BACKUP_PARTS||Number(totals.expected_bytes)>MAX_BACKUP_BYTES)throw new Error('Invalid installation inventory.');
    const rows=(await this.directory.pool.query("SELECT name,bytes,sha256 FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND state='ready' AND name>$3 ORDER BY name LIMIT 500",[owner.tenant,backup,after])).rows;
    return {parts:rows.map(p=>({...p,bytes:Number(p.bytes)})),count:totals.expected_parts,bytes:Number(totals.expected_bytes),next:rows.length===500?rows.at(-1)!.name:null};
  }
  async part(owner:HostOwner,id:string,backup:string,name:string){
    backupLocation(owner.tenant,backup,name);await this.authorized(owner,id,backup);
    const part=(await this.directory.pool.query("SELECT bytes,sha256 FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 AND name=$3 AND state='ready'",[owner.tenant,backup,name])).rows[0];
    if(!part)throw new Error('Installation part unavailable.');
    const object=await this.storage.get(owner.tenant,backup,name);
    try{await this.authorized(owner,id,backup);if(object.bytes!==Number(part.bytes))throw new Error('Installation size mismatch.');}
    catch(error){object.body.destroy();throw error;}
    let bytes=0,lastChecked=Date.now();const hash=createHash('sha256');
    const stream=new Transform({transform:(chunk,_encoding,done)=>{
      bytes+=chunk.length;if(bytes>object.bytes){done(new Error('Installation size exceeded.'));return;}
      hash.update(chunk);
      if(Date.now()-lastChecked>1000){lastChecked=Date.now();void this.authorized(owner,id,backup).then(()=>done(null,chunk),()=>done(new Error('Installation revoked.')));}
      else done(null,chunk);
    },flush(done){done(bytes!==object.bytes||hash.digest('hex')!==part.sha256?new Error('Installation integrity mismatch.'):undefined);}});
    object.body.on('error',error=>stream.destroy(error));stream.on('close',()=>object.body.destroy());object.body.pipe(stream);
    return {body:stream,bytes:object.bytes,sha256:part.sha256};
  }
  async complete(owner:HostOwner,id:string,receipt:string){
    const plan=await this.authorized(owner,id);
    if(receipt!==installReceipt(plan))throw new Error('Installation receipt mismatch.');
    const result=await this.directory.pool.query(`UPDATE host_installations i SET state='installed',receipt_hash=$4,installed_at=COALESCE(installed_at,now())
      FROM tenants t WHERE i.tenant_id=$1 AND i.generation=$2 AND i.machine_id=$3 AND i.id=$5 AND t.id=i.tenant_id
      AND t.generation=i.generation AND t.machine_id=i.machine_id AND t.volume_id=i.volume_id AND t.state='provisioning'
      AND NOT EXISTS(SELECT 1 FROM host_policies p WHERE p.tenant_id=t.id AND p.desired='run') RETURNING i.id`,[owner.tenant,owner.generation,owner.machine,receipt,id]);
    if(!result.rowCount)throw new Error('Installation revoked.');
  }
}
export function hostInstallationRoutes(installations:HostInstallations,identity:RuntimeIdentity){
  const app=new Hono<{Variables:{owner:HostOwner}}>();
  app.use('*',async(c,next)=>{try{c.set('owner',await identity.verify((c.req.header('authorization')??'').replace(/^Bearer /,''),'swarm-host'));}catch{return c.json({error:'Host authorization required.'},401);}return next();});
  app.onError((_error,c)=>c.json({error:'Installation unavailable or requires retry.'},409));
  app.get('/',async c=>c.json({installation:await installations.plan(c.get('owner'))}));
  app.get('/:id/:backup',async c=>c.json(await installations.parts(c.get('owner'),c.req.param('id'),c.req.param('backup'),c.req.query('after'))));
  app.get('/:id/:backup/:name',async c=>{const part=await installations.part(c.get('owner'),c.req.param('id'),c.req.param('backup'),c.req.param('name'));return new Response(Readable.toWeb(part.body) as ReadableStream,{headers:{'content-type':'application/octet-stream','content-length':String(part.bytes),'cache-control':'no-store','x-backup-sha256':part.sha256}});});
  app.post('/:id/complete',async c=>{const body=await c.req.json();if(Object.keys(body).some(k=>k!=='receipt'))throw new Error('Invalid receipt.');await installations.complete(c.get('owner'),c.req.param('id'),body.receipt);return c.json({ok:true});});
  return app;
}
