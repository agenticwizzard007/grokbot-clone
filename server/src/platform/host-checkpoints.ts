import {createHash} from 'node:crypto';
import {Hono} from 'hono';
import type {PoolClient} from 'pg';
import type {Directory} from './directory.js';
import type {RuntimeIdentity} from './runtime-identity.js';
import type {HostOwner} from './host-control.js';
import {backupLocation,MAX_BACKUP_BYTES,MAX_BACKUP_PARTS} from './backup-storage.js';

export interface CheckpointPlan extends HostOwner {id:string;volume:string;revision:string;state:'pending'|'uploading'|'complete';backup?:string;receipt?:string}
/** Trusted caller holds the current migration lease and tenant lock. A fresh
 * checkpoint is staged only after cloud stop is observed and before held boot. */
export async function stageHostCheckpoint(client:PoolClient,input:HostOwner&{id:string;volume:string;migration:string}){
  backupLocation(input.tenant,input.id);
  const owner=(await client.query(`SELECT p.revision FROM tenants t JOIN migration_runs m ON m.tenant_id=t.id
    JOIN host_policies p ON p.tenant_id=t.id AND p.machine_id=t.machine_id AND p.generation=t.generation
    WHERE t.id=$1 AND t.generation=$2 AND t.machine_id=$3 AND t.volume_id=$4 AND t.state='provisioning'
    AND m.id=$5 AND m.phase='rollback_pending' AND p.desired='hold' AND p.observed IS DISTINCT FROM 'running' FOR UPDATE OF t`,
  [input.tenant,input.generation,input.machine,input.volume,input.migration])).rows[0];
  if(!owner)throw new Error('Checkpoint requires a held rollback target.');
  await client.query(`INSERT INTO host_checkpoints(tenant_id,id,migration_id,machine_id,volume_id,generation,policy_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id) DO NOTHING`,[input.tenant,input.id,input.migration,input.machine,input.volume,input.generation,owner.revision]);
  const saved=(await client.query('SELECT * FROM host_checkpoints WHERE tenant_id=$1',[input.tenant])).rows[0];
  if(saved.id!==input.id||saved.migration_id!==input.migration||saved.machine_id!==input.machine||saved.volume_id!==input.volume
    ||String(saved.generation)!==input.generation||String(saved.policy_revision)!==String(owner.revision)||saved.state==='cancelled')throw new Error('Checkpoint identity cannot be replaced.');
}
/** Shared by upload admission/acknowledgement. Held hosts can write only the
 * exact checkpoint backup admitted through the dedicated protocol below. */
export const backupWriterAuthorized=`(t.state='active' AND b.checkpoint_id IS NULL OR t.state='provisioning' AND EXISTS(
  SELECT 1 FROM host_checkpoints q JOIN host_policies p ON p.tenant_id=q.tenant_id
    JOIN migration_runs m ON m.id=q.migration_id AND m.tenant_id=q.tenant_id
  WHERE q.tenant_id=t.id AND q.id=b.checkpoint_id AND q.backup_id=b.id AND q.generation=t.generation
    AND q.machine_id=t.machine_id AND q.volume_id=t.volume_id AND q.state IN ('uploading','complete')
    AND p.generation=q.generation AND p.machine_id=q.machine_id AND p.revision=q.policy_revision AND p.desired='hold'
    AND m.phase='rollback_pending'))`;
export class HostCheckpoints {
  constructor(readonly directory:Directory){}
  private async current(owner:HostOwner,client?:PoolClient):Promise<CheckpointPlan|null>{
    const row=(await (client??this.directory.pool).query(`SELECT q.* FROM host_checkpoints q JOIN tenants t ON t.id=q.tenant_id
      JOIN host_policies p ON p.tenant_id=t.id JOIN migration_runs m ON m.id=q.migration_id AND m.tenant_id=t.id
      WHERE q.tenant_id=$1 AND q.generation=$2 AND q.machine_id=$3 AND t.generation=q.generation AND t.machine_id=q.machine_id
        AND t.volume_id=q.volume_id AND t.state='provisioning' AND q.state!='cancelled' AND m.phase='rollback_pending'
        AND p.generation=q.generation AND p.machine_id=q.machine_id AND p.desired='hold' AND p.revision=q.policy_revision`,[owner.tenant,owner.generation,owner.machine])).rows[0];
    return row?{...owner,id:row.id,volume:row.volume_id,revision:String(row.policy_revision),state:row.state,backup:row.backup_id??undefined,receipt:row.receipt_hash??undefined}:null;
  }
  async plan(owner:HostOwner){return this.current(owner);}
  private async authorized<T>(owner:HostOwner,id:string,effect:(client:PoolClient,plan:CheckpointPlan)=>Promise<T>){
    return this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[owner.tenant]);
      const plan=await this.current(owner,client);
      if(!plan||plan.id!==id)throw new Error('Checkpoint authorization changed.');
      // The report must follow staging and acknowledge its exact hold revision.
      if(!(await client.query(`SELECT 1 FROM host_policies p JOIN host_checkpoints q ON q.tenant_id=p.tenant_id
        WHERE q.tenant_id=$1 AND p.observed='held' AND p.acknowledged_revision=q.policy_revision AND p.error_code IS NULL
        AND p.reported_at>=q.created_at AND p.reported_at>clock_timestamp()-interval '4 minutes'`,[owner.tenant])).rowCount)throw new Error('Checkpoint host has not acknowledged its current hold.');
      return effect(client,plan);
    });
  }
  async begin(owner:HostOwner,id:string,input:{backup:string;parts:number;bytes:number}){
    if(!input||Object.keys(input).some(k=>!['backup','parts','bytes'].includes(k)))throw new Error('Invalid checkpoint inventory.');
    backupLocation(owner.tenant,input.backup);
    if(!Number.isSafeInteger(input.parts)||input.parts<2||input.parts>MAX_BACKUP_PARTS||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>MAX_BACKUP_BYTES)throw new Error('Invalid checkpoint inventory.');
    await this.authorized(owner,id,async(client,plan)=>{
      if(plan.backup&&plan.backup!==input.backup)throw new Error('Checkpoint backup cannot be replaced.');
      if(!plan.backup&&(await client.query('SELECT 1 FROM backups WHERE tenant_id=$1 AND id=$2',[owner.tenant,input.backup])).rowCount)throw new Error('A checkpoint must use a fresh backup.');
      await client.query(`INSERT INTO backups(tenant_id,id,generation,scope,expected_parts,expected_bytes,expires_at,checkpoint_id)
        VALUES($1,$2,$3,'environment',$4,$5,clock_timestamp()+interval '7 days',$6) ON CONFLICT DO NOTHING`,[owner.tenant,input.backup,owner.generation,input.parts,input.bytes,id]);
      const backup=(await client.query('SELECT * FROM backups WHERE tenant_id=$1 AND id=$2',[owner.tenant,input.backup])).rows[0];
      if(backup.checkpoint_id!==id||backup.scope!=='environment'||String(backup.generation)!==owner.generation||backup.expected_parts!==input.parts
        ||Number(backup.expected_bytes)!==input.bytes||!['uploading','complete'].includes(backup.state))throw new Error('Checkpoint inventory changed.');
      await client.query("UPDATE host_checkpoints SET backup_id=$2,state=CASE WHEN state='complete' THEN state ELSE 'uploading' END WHERE tenant_id=$1",[owner.tenant,input.backup]);
    });
  }
  async complete(owner:HostOwner,id:string){
    return this.authorized(owner,id,async(client,plan)=>{
      const backup=(await client.query("SELECT * FROM backups WHERE tenant_id=$1 AND id=$2 AND checkpoint_id=$3 AND state='complete' AND scope='environment' AND generation=$4",[owner.tenant,plan.backup,id,owner.generation])).rows[0];
      if(!backup)throw new Error('Checkpoint backup is incomplete.');
      const parts=(await client.query('SELECT name,bytes,sha256,state FROM backup_parts WHERE tenant_id=$1 AND backup_id=$2 ORDER BY name',[owner.tenant,plan.backup])).rows;
      if(parts.length!==backup.expected_parts||parts.some(p=>p.state!=='ready')||parts.reduce((n,p)=>n+Number(p.bytes),0)!==Number(backup.expected_bytes))throw new Error('Checkpoint inventory is incomplete.');
      const receipt=createHash('sha256').update(JSON.stringify([1,owner.tenant,owner.machine,plan.volume,owner.generation,id,plan.revision,plan.backup,parts.map(p=>[p.name,Number(p.bytes),p.sha256])])).digest('hex');
      if(plan.receipt&&plan.receipt!==receipt)throw new Error('Checkpoint receipt changed.');
      await client.query("UPDATE host_checkpoints SET state='complete',receipt_hash=$2,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE tenant_id=$1",[owner.tenant,receipt]);
      return {receipt,backup:plan.backup!};
    });
  }
}
export function hostCheckpointRoutes(checkpoints:HostCheckpoints,runtime:RuntimeIdentity){
  const app=new Hono<{Variables:{owner:HostOwner}}>();
  app.use('*',async(c,next)=>{try{c.set('owner',await runtime.verify((c.req.header('authorization')??'').replace(/^Bearer /,''),'swarm-host'));}catch{return c.json({error:'Host authorization required.'},401);}return next();});
  app.onError((_error,c)=>c.json({error:'Checkpoint unavailable or requires retry.'},409));
  app.get('/',async c=>c.json({checkpoint:await checkpoints.plan(c.get('owner'))}));
  app.post('/:id',async c=>{await checkpoints.begin(c.get('owner'),c.req.param('id'),await c.req.json());return c.json({ok:true});});
  app.post('/:id/complete',async c=>c.json(await checkpoints.complete(c.get('owner'),c.req.param('id'))));
  return app;
}
