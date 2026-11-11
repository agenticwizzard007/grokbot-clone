/** Trusted maintenance only. Reservation creates no VM, credentials or run permit. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Directory,opaqueToken} from './directory.js';
import type {FlyTenants} from './fly-tenants.js';
import type {MigrationSource} from './migration-coordinator.js';
import {assertQualifiedImage} from './release-policy.js';

export interface MigrationDestinationPlan {
  version:1;tenant:string;operation:string;checkpoint:string;sourceFence:string;
  generation:string;image:string;region:string;digest:string;
}
const digest=(plan:Omit<MigrationDestinationPlan,'digest'>)=>createHash('sha256').update(JSON.stringify([
  plan.version,plan.tenant,plan.operation,plan.checkpoint,plan.sourceFence,plan.generation,plan.image,plan.region,
])).digest('hex');
function validate(plan:MigrationDestinationPlan){
  if(plan.version!==1||!/^usr_[A-Za-z0-9_-]{8,100}$/.test(plan.tenant)||!/^[A-Za-z0-9_-]{1,120}$/.test(plan.operation)
    ||!/^[a-f0-9]{64}$/.test(plan.checkpoint)||!/^[A-Za-z0-9_:-]{1,200}$/.test(plan.sourceFence)
    ||!/^[1-9]\d*$/.test(plan.generation)||!/^[a-z0-9]{3,10}$/.test(plan.region)||plan.digest!==digest(plan))throw new Error('Invalid reviewed migration destination.');
}
/** Review this binding before reservation. No external request or directory mutation. */
export async function planMigrationDestination(directory:Directory,input:{tenant:string;image:string;region:string}):Promise<MigrationDestinationPlan>{
  await assertQualifiedImage(directory.pool,input.image);
  const row=(await directory.pool.query(`SELECT m.*,t.generation FROM migration_runs m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=$1 AND m.phase='exporting' AND m.writer='none' AND t.state='pending'`,[input.tenant])).rows[0];
  if(!row)throw new Error('A held migration export is required.');
  const plan={version:1 as const,tenant:input.tenant,operation:row.id,checkpoint:row.source_checkpoint,sourceFence:row.source_fence,generation:String(row.generation),image:input.image,region:input.region};
  const result={...plan,digest:digest(plan)};validate(result);return result;
}
type DestinationFly=Pick<FlyTenants,'name'|'network'|'volumeName'|'inventory'|'ensureApp'|'ensureVolume'>;
class SourceChanged extends Error {}
export class MigrationDestination {
  constructor(private directory:Directory,private fly:DestinationFly,private source:Pick<MigrationSource,'inspect'|'frozen'|'stop'>){}
  async reserve(plan:MigrationDestinationPlan){
    validate(plan);
    const lease=opaqueToken(),tenant=plan.tenant,app=this.fly.name(tenant),network=this.fly.network(tenant);
    const operation=await this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      await client.query('SELECT id FROM migration_runs WHERE tenant_id=$1 FOR UPDATE',[tenant]);
      await assertQualifiedImage(client,plan.image);
      const row=(await client.query(`UPDATE migration_runs m SET lease_owner=$3,lease_until=clock_timestamp()+interval '2 minutes',fence=fence+1
        FROM tenants t WHERE m.tenant_id=$1 AND m.id=$2 AND m.phase='exporting' AND m.writer='none'
        AND m.source_checkpoint=$4 AND m.source_fence=$5 AND (m.lease_until IS NULL OR m.lease_until<clock_timestamp())
        AND t.id=m.tenant_id AND t.generation=$6 AND t.state='pending' AND t.fly_app IS NULL AND t.machine_id IS NULL AND t.volume_id IS NULL
        RETURNING m.*`,[tenant,plan.operation,lease,plan.checkpoint,plan.sourceFence,plan.generation])).rows[0];
      if(!row)throw new Error('Migration destination is changed, revoked or already leased.');
      if((await client.query("SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1 AND (state!='cancelled' OR attempts>0)",[tenant])).rowCount
        ||(await client.query('SELECT 1 FROM migration_transfers WHERE tenant_id=$1',[tenant])).rowCount)throw new Error('Reserve the destination before transfer or provisioning.');
      await client.query(`INSERT INTO migration_destinations(tenant_id,migration_id,plan_digest,source_checkpoint,source_fence,generation,image_digest,region,fly_app,network_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id) DO NOTHING`,[tenant,plan.operation,plan.digest,plan.checkpoint,plan.sourceFence,plan.generation,plan.image,plan.region,app,network]);
      const saved=(await client.query('SELECT * FROM migration_destinations WHERE tenant_id=$1',[tenant])).rows[0];
      if(saved.plan_digest!==plan.digest||saved.migration_id!==plan.operation||saved.fly_app!==app||saved.network_id!==network)throw new Error('Migration destination binding cannot be replaced.');
      // Revalidation must withdraw the old reservation until the complete current
      // inventory is observed. A failed retry cannot leave stale transfer authority.
      await client.query("UPDATE migration_destinations SET state='allocating' WHERE tenant_id=$1",[tenant]);
      return row;
    });
    const fenced=async<T>(action:(client:PoolClient)=>Promise<T>)=>this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      await client.query('SELECT id FROM migration_runs WHERE tenant_id=$1 FOR UPDATE',[tenant]);
      const valid=await client.query(`UPDATE migration_runs m SET lease_until=clock_timestamp()+interval '2 minutes' FROM tenants t,migration_destinations d
        WHERE m.tenant_id=$1 AND m.id=$2 AND m.lease_owner=$3 AND m.fence=$4 AND m.lease_until>clock_timestamp()
        AND m.phase='exporting' AND m.writer='none' AND m.source_checkpoint=$5 AND m.source_fence=$6
        AND t.id=m.tenant_id AND t.state='pending' AND t.generation=$7 AND t.fly_app IS NULL AND t.machine_id IS NULL AND t.volume_id IS NULL
        AND d.tenant_id=t.id AND d.migration_id=m.id AND d.plan_digest=$8 RETURNING m.id`,
      [tenant,plan.operation,lease,operation.fence,plan.checkpoint,plan.sourceFence,plan.generation,plan.digest]);
      if(!valid.rowCount)throw new Error('Migration destination authorization changed.');
      return action(client);
    });
    const guard=async()=>{
      await fenced(async()=>{});
      try{
        const source=await this.source.inspect(tenant,plan.operation);
        if(!source||source.tenant!==tenant||source.checkpoint!==plan.checkpoint||source.fence!==plan.sourceFence
          ||source.writersStopped!==true||source.filesFrozen!==true||!await this.source.frozen(tenant,plan.sourceFence))throw new Error('source changed');
      }catch{throw new SourceChanged('The complete source hold is unavailable or changed.');}
      await fenced(async()=>{});
    };
    let heartbeatBusy=false,heartbeatError:unknown;
    const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void guard().catch(error=>{heartbeatError=error;}).finally(()=>{heartbeatBusy=false;});},20000).unref();
    const authorize=async()=>{if(heartbeatError)throw heartbeatError;await guard();};
    const beforeCreate=(kind:'app'|'volume')=>async()=>{
      await authorize();
      await fenced(async client=>{
        await assertQualifiedImage(client,plan.image);
        if(!(await client.query("INSERT INTO infrastructure_actions(tenant_id,generation,kind,state) VALUES($1,$2,$3,'dispatching') ON CONFLICT DO NOTHING RETURNING kind",[tenant,plan.generation,kind])).rowCount)throw new Error('Unobserved creation requires reconciliation; it cannot be replayed.');
      });
    };
    const observe=async(kind:'app'|'volume',resource:string)=>fenced(async client=>{
      const action=(await client.query('SELECT * FROM infrastructure_actions WHERE tenant_id=$1 AND generation=$2 AND kind=$3',[tenant,plan.generation,kind])).rows[0];
      if(!action||action.state==='observed'&&action.resource_id!==resource)throw new Error('Unadmitted destination resource requires reconciliation.');
      await client.query("UPDATE infrastructure_actions SET state='observed',resource_id=$4 WHERE tenant_id=$1 AND generation=$2 AND kind=$3",[tenant,plan.generation,kind,resource]);
    });
    try{
      await authorize();
      const initial=await this.fly.inventory(app,tenant);await authorize();
      if(initial.machines.length)throw new Error('Migration destination has an unexpected writer.');
      const created=await this.fly.ensureApp(tenant,beforeCreate('app'));await authorize();
      if(created.app!==app||created.network!==network)throw new Error('Destination network ownership changed.');
      await observe('app',app);
      const volume=await this.fly.ensureVolume(app,tenant,plan.region,beforeCreate('volume'));await authorize();
      if(!/^[A-Za-z0-9_-]{1,120}$/.test(volume.id)||volume.name!==this.fly.volumeName(tenant)||volume.encrypted!==true||volume.region!==plan.region)throw new Error('Destination volume ownership changed.');
      await observe('volume',volume.id);
      const inventory=await this.fly.inventory(app,tenant);await authorize();
      if(!inventory.present||inventory.machines.length||inventory.volumes.length!==1||inventory.volumes[0].id!==volume.id)throw new Error('Destination inventory changed.');
      await fenced(async client=>{
        await assertQualifiedImage(client,plan.image);
        const updated=await client.query(`UPDATE migration_destinations SET volume_id=$3,state='reserved',reserved_at=COALESCE(reserved_at,clock_timestamp())
          WHERE tenant_id=$1 AND plan_digest=$2 AND (volume_id IS NULL OR volume_id=$3) RETURNING tenant_id`,[tenant,plan.digest,volume.id]);
        if(!updated.rowCount)throw new Error('Destination volume cannot be substituted.');
        await client.query('UPDATE migration_runs SET error_code=NULL WHERE tenant_id=$1',[tenant]);
      });
      return {...plan,app,network,volume:volume.id as string,routingChanged:false as const};
    }catch(error){
      if(error instanceof SourceChanged){
        // Contain even when the directory write fails. No destination machine is
        // created here; source retirement is still required for deletion.
        let owned=false,metadataUnavailable=false;
        try{owned=await this.directory.transaction(async client=>{
          await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
          return !!(await client.query("UPDATE migration_runs SET phase='reconciliation',writer='unknown',error_code='source_hold_lost' WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp() RETURNING id",[tenant,lease,operation.fence])).rowCount;
        });}catch{metadataUnavailable=true;}
        if(owned||metadataUnavailable)await this.source.stop(tenant,`${plan.operation}:contain`,String(operation.fence)).catch(()=>false);
      }else{
        await this.directory.pool.query("UPDATE migration_runs SET error_code='migration_destination_requires_reconciliation' WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3",[tenant,lease,operation.fence]);
      }
      throw error;
    }finally{
      clearInterval(heartbeat);
      await this.directory.pool.query('UPDATE migration_runs SET lease_until=NULL WHERE tenant_id=$1 AND lease_owner=$2 AND fence=$3',[tenant,lease,operation.fence]);
    }
  }
}
