import {randomBytes,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Directory,hashToken,opaqueToken} from './directory.js';
import type {FlyTenants} from './fly-tenants.js';
import {HostControl,setHostIntent} from './host-control.js';
import {stageHostInstallation} from './host-installations.js';
import {assertQualifiedImage} from './release-policy.js';
import {backupLocation} from './backup-storage.js';

export interface EnvironmentPlan {
  version:1;tenant:string;kind:'restore'|'update';generation:string;machine:string;volume:string;sourceImage:string;
  image:string;region:string;fullBackup?:string;databaseBackup?:string;digest:string;
}
const planDigest=(plan:Omit<EnvironmentPlan,'digest'>)=>createHash('sha256').update(JSON.stringify([
  plan.version,plan.tenant,plan.kind,plan.generation,plan.machine,plan.volume,plan.sourceImage,plan.image,plan.region,plan.fullBackup??null,plan.databaseBackup??null,
])).digest('hex');
async function validateBackups(client:PoolClient,tenant:string,full?:string,database?:string){
  if(!full)throw new Error('An explicit full backup is required.');backupLocation(tenant,full);if(database)backupLocation(tenant,database);
  const rows=(await client.query("SELECT id,scope,created_at,generation FROM backups WHERE tenant_id=$1 AND id=ANY($2::text[]) AND state='complete' AND expires_at>now() FOR UPDATE",[tenant,[full,...(database?[database]:[])]] )).rows;
  const environment=rows.find(r=>r.id===full),latest=database?rows.find(r=>r.id===database):null;
  if(environment?.scope!=='environment'||database&&(latest?.scope!=='database'||new Date(latest.created_at)<new Date(environment.created_at)))throw new Error('The selected backups are unavailable or out of order.');
}
/** Read-only, reviewable plan. Queueing it checks the exact source binding again. */
export async function planEnvironmentOperation(directory:Directory,input:{tenant:string;kind:'restore'|'update';image:string;fullBackup?:string;databaseBackup?:string}):Promise<EnvironmentPlan>{
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)||!['restore','update'].includes(input.kind)||input.kind==='update'&&(input.fullBackup||input.databaseBackup))throw new Error('Invalid environment operation.');
  return directory.transaction(async client=>{
    await assertQualifiedImage(client,input.image);
    const source=(await client.query("SELECT * FROM tenants WHERE id=$1 AND state IN ('active','suspended')",[input.tenant])).rows[0];
    if(!source?.machine_id||!source.volume_id||!source.image_digest||!source.region||!source.fly_app)throw new Error('An isolated source environment is required.');
    if(input.kind==='restore')await validateBackups(client,input.tenant,input.fullBackup,input.databaseBackup);
    const plan:Omit<EnvironmentPlan,'digest'>={version:1,tenant:input.tenant,kind:input.kind,generation:String(source.generation),machine:source.machine_id,volume:source.volume_id,sourceImage:source.image_digest,image:input.image,region:source.region,...(input.fullBackup?{fullBackup:input.fullBackup}:{}),...(input.databaseBackup?{databaseBackup:input.databaseBackup}:{})};
    return {...plan,digest:planDigest(plan)};
  });
}
export async function queueEnvironmentOperation(directory:Directory,plan:EnvironmentPlan){
  if(!plan||plan.version!==1||!['restore','update'].includes(plan.kind)||plan.digest!==planDigest(plan)||!/^usr_[A-Za-z0-9_-]{8,100}$/.test(plan.tenant)||!/^[1-9]\d*$/.test(plan.generation)||plan.kind==='update'&&(plan.fullBackup||plan.databaseBackup))throw new Error('Invalid reviewed environment plan.');
  return directory.transaction(async client=>{
    const source=(await client.query("SELECT * FROM tenants WHERE id=$1 AND generation=$2 AND machine_id=$3 AND volume_id=$4 AND image_digest=$5 AND region=$6 AND state IN ('active','suspended') FOR UPDATE",[plan.tenant,plan.generation,plan.machine,plan.volume,plan.sourceImage,plan.region])).rows[0];
    if(!source)throw new Error('The reviewed source changed. Generate a new plan.');
    await assertQualifiedImage(client,plan.image);
    if((await client.query("SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1 AND state='running'",[plan.tenant])).rowCount
      ||(await client.query("SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND state='dispatching'",[plan.tenant])).rowCount
      ||(await client.query("SELECT 1 FROM migration_runs WHERE tenant_id=$1 AND phase!='active'",[plan.tenant])).rowCount)throw new Error('Source operations require reconciliation.');
    if(plan.kind==='restore')await validateBackups(client,plan.tenant,plan.fullBackup,plan.databaseBackup);
    const id=randomBytes(16).toString('hex'),generation=String(BigInt(plan.generation)+1n);
    await client.query(`INSERT INTO environment_operations(id,tenant_id,kind,source_generation,target_generation,source_machine,source_volume,source_image,image_digest,region,full_backup,database_backup)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,plan.tenant,plan.kind,plan.generation,generation,plan.machine,plan.volume,plan.sourceImage,plan.image,plan.region,plan.fullBackup??null,plan.databaseBackup??null]);
    // Revoke routing/runtime authority before any slow cloud operation. User
    // sessions survive this maintenance; no tenant process receives a Fly key.
    await client.query("UPDATE tenants SET state='suspended',generation=$2 WHERE id=$1",[plan.tenant,generation]);
    await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[plan.tenant]);
    await client.query('DELETE FROM companion_routes WHERE tenant_id=$1',[plan.tenant]);
    await client.query("UPDATE lifecycle_jobs SET state='cancelled',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND state IN ('queued','failed')",[plan.tenant]);
    return {id,tenant:plan.tenant,generation,phase:'stopping'};
  });
}
/** Rollback is safe without a new target checkpoint only before any run permit.
 * After activation, use a reviewed image update/current-volume or reconciled
 * backup restore plan; never route back to a stale source volume. */
export async function requestEnvironmentRollback(directory:Directory,id:string){
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid environment operation.');
  return directory.transaction(async client=>{
    const operation=(await client.query(`SELECT o.* FROM environment_operations o JOIN tenants t ON t.id=o.tenant_id WHERE o.id=$1
      AND o.phase NOT IN ('completed','cancelled') AND o.run_authorized_at IS NULL AND t.generation=o.target_generation
      AND t.state IN ('suspended','provisioning') FOR UPDATE OF o,t`,[id])).rows[0];
    if(!operation)throw new Error('Rollback requires an unactivated target; reconcile a fresh checkpoint instead.');
    await assertQualifiedImage(client,operation.source_image);
    await client.query("UPDATE tenants SET state='suspended' WHERE id=$1",[operation.tenant_id]);
    await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[operation.tenant_id]);
    await client.query("UPDATE environment_operations SET phase='aborting',fence=fence+1,lease_until=NULL,retry_at=now(),error_code=NULL WHERE id=$1",[id]);
    return {id,tenant:operation.tenant_id,phase:'aborting'};
  });
}
class PendingOperation extends Error {constructor(readonly code:'cloud_creation_uncertain'|'installation_pending'|'host_readiness_pending'){super(code);}}
type DeploymentFly=Pick<FlyTenants,'name'|'inventory'|'deploymentVolumeName'|'machine'|'action'|'waitStopped'|'removeStoppedMachine'|'ensureDeploymentVolume'|'ensureMachine'|'configureBootstrap'|'removeRetiredVolume'>;
export class EnvironmentWorker {
  private worker=opaqueToken();private hosts:HostControl;
  constructor(readonly directory:Directory,private fly:DeploymentFly){this.hosts=new HostControl(directory);}
  async tick():Promise<'idle'|'completed'|'retry'>{
    const operation=await this.directory.transaction(async client=>{
      const row=(await client.query(`SELECT o.* FROM environment_operations o JOIN tenants t ON t.id=o.tenant_id
        WHERE o.phase NOT IN ('completed','cancelled') AND o.retry_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
        AND t.generation=o.target_generation AND t.state IN ('suspended','provisioning')
        AND NOT EXISTS(SELECT 1 FROM lifecycle_jobs j WHERE j.tenant_id=o.tenant_id AND j.state='running')
        ORDER BY o.created_at FOR UPDATE OF o,t SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row)return null;
      return (await client.query("UPDATE environment_operations SET lease_owner=$2,lease_until=now()+interval '2 minutes',fence=fence+1,attempts=attempts+1 WHERE id=$1 RETURNING *",[row.id,this.worker])).rows[0];
    });
    if(!operation)return 'idle';
    const id=operation.id,tenant=operation.tenant_id,generation=String(operation.target_generation),app=this.fly.name(tenant),owner=()=>({tenant,generation,machine:operation.target_machine as string});
    const fenced=async<T>(fn:(client:PoolClient)=>Promise<T>)=>this.directory.transaction(async client=>{
      const valid=await client.query(`SELECT 1 FROM environment_operations o JOIN tenants t ON t.id=o.tenant_id WHERE o.id=$1 AND o.lease_owner=$2 AND o.fence=$3
        AND o.lease_until>now() AND o.phase NOT IN ('completed','cancelled') AND t.generation=o.target_generation AND t.state IN ('suspended','provisioning') FOR UPDATE OF o,t`,[id,this.worker,operation.fence]);
      if(!valid.rowCount)throw new Error('Environment operation ownership changed.');
      await client.query("UPDATE environment_operations SET lease_until=now()+interval '2 minutes' WHERE id=$1",[id]);
      return fn(client);
    });
    const guard=()=>fenced(async()=>{}),actionKind=(kind:string)=>`environment:${id}:${kind}`;
    const beforeCreate=(kind:string)=>()=>fenced(async client=>{
      if(!(await client.query("INSERT INTO infrastructure_actions(tenant_id,generation,kind,state) VALUES($1,$2,$3,'dispatching') ON CONFLICT DO NOTHING RETURNING kind",[tenant,generation,actionKind(kind)])).rowCount)throw new PendingOperation('cloud_creation_uncertain');
    });
    const observed=async(client:PoolClient,kind:string,resource:string)=>{await client.query("UPDATE infrastructure_actions SET state='observed',resource_id=$4 WHERE tenant_id=$1 AND generation=$2 AND kind=$3",[tenant,generation,actionKind(kind),resource]);};
    const phase=async(value:string)=>{await fenced(async client=>{await client.query('UPDATE environment_operations SET phase=$2,error_code=NULL WHERE id=$1',[id,value]);});operation.phase=value;};
    let heartbeatBusy=false;const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void guard().catch(()=>{}).finally(()=>{heartbeatBusy=false;});},20000).unref();
    try{
      await assertQualifiedImage(this.directory.pool,operation.phase==='aborting'?operation.source_image:operation.image_digest);await guard();
      const operations=(await this.directory.pool.query('SELECT id FROM environment_operations WHERE tenant_id=$1',[tenant])).rows.map(r=>r.id);
      const inventory=await this.fly.inventory(app,tenant,operations);await guard();
      if(!inventory.present)throw new Error('Tenant application disappeared.');
      if(operation.phase==='aborting'){
        // The durable run marker is set in the same transaction as its permit.
        // Thus stopped/held state alone cannot conceal a previously active writer.
        if(operation.run_authorized_at)throw new Error('An activated target requires checkpoint reconciliation.');
        for(const machine of inventory.machines){
          await guard();await this.fly.action(app,machine.id,'stop',tenant);await this.fly.waitStopped(app,tenant,machine.id);await guard();
        }
        await fenced(async client=>{
          for(const kind of ['volume','machine']){
            const found=kind==='volume'?inventory.volumes.find(v=>v.name===this.fly.deploymentVolumeName(tenant,id))?.id:inventory.machines.find(m=>String(m.config?.metadata?.swarm_generation)===generation)?.id;
            if(found)await observed(client,kind,found);
          }
        });
        if((await this.directory.pool.query("SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND generation=$2 AND state='dispatching'",[tenant,generation])).rowCount)throw new PendingOperation('cloud_creation_uncertain');
        const source=inventory.volumes.find(v=>v.id===operation.source_volume);
        if(!source||source.encrypted!==true||source.region!==operation.region)throw new Error('Preserved source volume is unavailable.');
        for(const machine of inventory.machines){await guard();await this.fly.removeStoppedMachine(app,tenant,machine.id,String(machine.config.metadata.swarm_generation));await guard();}
        const unused=inventory.volumes.find(v=>v.name===this.fly.deploymentVolumeName(tenant,id));
        if(unused&&unused.id!==operation.source_volume){await this.fly.removeRetiredVolume(app,tenant,unused.id,operations);await guard();}
        await fenced(async client=>{
          await assertQualifiedImage(client,operation.source_image);
          const replacement=randomBytes(16).toString('hex'),nextGeneration=String(BigInt(generation)+1n);
          await client.query("UPDATE environment_operations SET phase='cancelled',lease_until=NULL,rollback_operation=$2,error_code=NULL WHERE id=$1",[id,replacement]);
          await client.query(`INSERT INTO environment_operations(id,tenant_id,kind,source_generation,target_generation,source_machine,source_volume,source_image,image_digest,region,source_removed)
            VALUES($1,$2,'update',$3,$4,$5,$6,$7,$7,$8,true)`,[replacement,tenant,generation,nextGeneration,operation.source_machine,operation.source_volume,operation.source_image,operation.region]);
          await client.query("UPDATE tenants SET state='suspended',generation=$2,machine_id=$3,volume_id=$4,image_digest=$5 WHERE id=$1",[tenant,nextGeneration,operation.source_machine,operation.source_volume,operation.source_image]);
          await client.query('DELETE FROM host_installations WHERE tenant_id=$1',[tenant]);
        });
        return 'completed';
      }
      if(operation.phase==='stopping'){
        if(!operation.source_removed){
          try{
            await this.fly.machine(app,tenant,operation.source_machine,operation.source_volume,String(operation.source_generation));await guard();
            await this.fly.action(app,operation.source_machine,'stop',tenant,String(operation.source_generation));
            await this.fly.waitStopped(app,tenant,operation.source_machine,String(operation.source_generation));await guard();
          }catch(error:any){if(error.status!==404)throw error;}
          await this.fly.removeStoppedMachine(app,tenant,operation.source_machine,String(operation.source_generation));await guard();
          await fenced(async client=>{await client.query("UPDATE environment_operations SET source_removed=true,phase='allocating' WHERE id=$1",[id]);});
          operation.source_removed=true;operation.phase='allocating';
        }else await phase('allocating');
      }
      if(operation.phase==='allocating'){
        let volume:string;
        if(operation.kind==='restore'){
          const created=await this.fly.ensureDeploymentVolume(app,tenant,id,operation.region,operations,beforeCreate('volume'));volume=created.id;
        }else{
          const current=inventory.volumes.find(v=>v.id===operation.source_volume);
          if(!current||current.encrypted!==true||current.region!==operation.region)throw new Error('The source volume is unavailable or foreign.');
          volume=operation.source_volume;
        }
        await fenced(async client=>{
          await client.query('UPDATE environment_operations SET target_volume=$2 WHERE id=$1',[id,volume]);
          if(operation.kind==='restore')await observed(client,'volume',volume);
        });operation.target_volume=volume;
        await guard();const machine=await this.fly.ensureMachine(app,tenant,volume,operation.image_digest,operation.region,generation,beforeCreate('machine'));await guard();
        await fenced(async client=>{
          await client.query('UPDATE environment_operations SET target_machine=$2 WHERE id=$1',[id,machine.id]);await observed(client,'machine',machine.id);
          await client.query("UPDATE tenants SET machine_id=$2,volume_id=$3,image_digest=$4,state='provisioning' WHERE id=$1",[tenant,machine.id,volume,operation.image_digest]);
          await client.query('DELETE FROM host_installations WHERE tenant_id=$1 AND generation!=$2',[tenant,generation]);
          await setHostIntent(client,{tenant,generation,machine:machine.id},'hold');
          if(operation.kind==='restore')await stageHostInstallation(client,{tenant,generation,machine:machine.id,volume,id,fullBackup:operation.full_backup,databaseBackup:operation.database_backup??undefined});
        });operation.target_machine=machine.id;
        await phase(operation.kind==='restore'?'installing':'starting');
      }
      if(!operation.target_machine||!operation.target_volume)throw new Error('Replacement ownership is missing.');
      const machine=await this.fly.machine(app,tenant,operation.target_machine,operation.target_volume,generation);await guard();
      if(['created','stopped'].includes(machine.state)){
        const bootstrap=opaqueToken();
        await fenced(async client=>{
          await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[tenant]);
          await client.query("INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at) VALUES($1,$2,$3,$4,'bootstrap',now()+interval '20 minutes')",[hashToken(bootstrap),tenant,operation.target_machine,generation]);
          await setHostIntent(client,owner(),'hold',true);
        });
        await guard();await this.fly.configureBootstrap(app,operation.target_machine,tenant,bootstrap,generation);await guard();
      }
      if(operation.phase==='installing'){
        await guard();await this.fly.action(app,operation.target_machine,'start',tenant,generation);await guard();
        if(!(await this.directory.pool.query("SELECT 1 FROM host_installations WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND machine_id=$4 AND volume_id=$5 AND state='installed'",[tenant,id,generation,operation.target_machine,operation.target_volume])).rowCount)throw new PendingOperation('installation_pending');
        await phase('starting');
      }
      if(operation.phase==='starting'){
        await fenced(async client=>{await setHostIntent(client,owner(),'run');await client.query('UPDATE environment_operations SET run_authorized_at=COALESCE(run_authorized_at,now()) WHERE id=$1',[id]);});
        await guard();await this.fly.action(app,operation.target_machine,'start',tenant,generation);await guard();
        if(!await this.hosts.ready(owner()))throw new PendingOperation('host_readiness_pending');
        await fenced(async client=>{
          if(operation.target_volume!==operation.source_volume)await client.query("INSERT INTO retired_volumes(tenant_id,volume_id,operation_id,delete_after) VALUES($1,$2,$3,now()+interval '7 days') ON CONFLICT DO NOTHING",[tenant,operation.source_volume,id]);
          await client.query("UPDATE tenants SET state='active' WHERE id=$1 AND machine_id=$2 AND volume_id=$3",[tenant,operation.target_machine,operation.target_volume]);
          await client.query("UPDATE environment_operations SET phase='completed',completed_at=now(),lease_until=NULL,error_code=NULL WHERE id=$1",[id]);
        });
        return 'completed';
      }
      throw new Error('Environment phase requires reconciliation.');
    }catch(error){
      await this.directory.pool.query("UPDATE environment_operations SET error_code=$4,retry_at=now()+interval '5 seconds'*least(attempts,12),lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND fence=$3 AND phase NOT IN ('completed','cancelled')",[id,this.worker,operation.fence,error instanceof PendingOperation?error.code:'environment_requires_reconciliation']);
      return 'retry';
    }finally{clearInterval(heartbeat);}
  }
  async pruneRetiredVolumes(){
    const rows=(await this.directory.pool.query("SELECT r.* FROM retired_volumes r JOIN tenants t ON t.id=r.tenant_id WHERE r.state!='deleted' AND r.delete_after<=now() AND t.state='active' LIMIT 100")).rows;
    for(const row of rows){
      try{
        // Serialize against queueing a new operation or account deletion while
        // checking the current volume. Destruction targets one immutable old ID.
        const allowed=await this.directory.transaction(async client=>{
          const owner=(await client.query("SELECT volume_id FROM tenants WHERE id=$1 AND state='active' FOR UPDATE",[row.tenant_id])).rows[0];
          if(!owner||owner.volume_id===row.volume_id)return false;
          await client.query("UPDATE retired_volumes SET state='deleting' WHERE tenant_id=$1 AND volume_id=$2",[row.tenant_id,row.volume_id]);return true;
        });
        if(!allowed)continue;
        const ids=(await this.directory.pool.query('SELECT id FROM environment_operations WHERE tenant_id=$1',[row.tenant_id])).rows.map(r=>r.id);
        await this.fly.removeRetiredVolume(this.fly.name(row.tenant_id),row.tenant_id,row.volume_id,ids);
        await this.directory.pool.query("UPDATE retired_volumes SET state='deleted',error_code=NULL WHERE tenant_id=$1 AND volume_id=$2",[row.tenant_id,row.volume_id]);
      }catch{await this.directory.pool.query("UPDATE retired_volumes SET error_code='volume_cleanup_requires_retry' WHERE tenant_id=$1 AND volume_id=$2",[row.tenant_id,row.volume_id]);}
    }
  }
}
