import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {Directory,hashToken,opaqueToken} from './directory.js';
import type {FlyTenants} from './fly-tenants.js';
import type {MigrationSource,MigrationTarget,TargetCheckpoint} from './migration-coordinator.js';
import {verifiedMigrationTransfer} from './migration-transfer.js';
import {assertQualifiedImage} from './release-policy.js';
import {HostControl,setHostIntent,type HostOwner} from './host-control.js';
import {stageHostInstallation,installReceipt} from './host-installations.js';
import {HostCheckpoints,stageHostCheckpoint} from './host-checkpoints.js';

const tokenId=(...values:string[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,32);
type TargetFly=Pick<FlyTenants,'name'|'network'|'inventory'|'machine'|'ensureMachine'|'configureBootstrap'|'action'|'waitStopped'>;
/** Trusted maintenance adapter. Source quiescence is a required, qualified
 * dependency. This class never enables a legacy source or generic provisioning. */
export class FlyMigrationTarget implements MigrationTarget {
  private hosts:HostControl;private checkpoints:HostCheckpoints;
  constructor(private directory:Directory,private fly:TargetFly,private source:Pick<MigrationSource,'inspect'|'frozen'>,
    private wait=(ms:number)=>delay(ms),private timeoutMs=30*60_000){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30*60_000)throw new Error('Invalid migration target deadline.');
    this.hosts=new HostControl(directory);this.checkpoints=new HostCheckpoints(directory);
  }
  private async context(tenant:string){
    const row=(await this.directory.pool.query(`SELECT m.*,t.state AS tenant_state,t.generation AS current_generation,d.generation,d.volume_id,d.image_digest,d.region,d.fly_app,d.network_id,d.state AS destination_state,
      r.machine_id,r.installation_id,r.run_authorized_at FROM migration_runs m JOIN tenants t ON t.id=m.tenant_id
      JOIN migration_destinations d ON d.tenant_id=t.id AND d.migration_id=m.id
      LEFT JOIN migration_targets r ON r.tenant_id=t.id AND r.migration_id=m.id WHERE t.id=$1`,[tenant])).rows[0];
    if(!row||row.fly_app!==this.fly.name(tenant)||row.network_id!==this.fly.network(tenant)||row.destination_state!=='reserved')throw new Error('Migration destination is unavailable.');
    return row;
  }
  private async fenced<T>(tenant:string,operation:string,fence:string,phases:string[],action:(client:PoolClient,row:any)=>Promise<T>,stopping=false){
    if(!/^[1-9]\d*$/.test(fence))throw new Error('Invalid migration fence.');
    return this.directory.transaction(async client=>{
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
      await client.query('SELECT id FROM migration_runs WHERE tenant_id=$1 FOR UPDATE',[tenant]);
      const row=(await client.query(`SELECT m.*,t.generation,t.state AS tenant_state FROM migration_runs m JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=$1 AND m.fence=$2 AND ($3 OR m.lease_until>clock_timestamp() AND t.state NOT IN ('deleting','deleted','failed'))`,[tenant,fence,stopping])).rows[0];
      if(!row||!([row.id,`${row.id}:rollback`,`${row.id}:contain`].includes(operation))||!stopping&&!phases.includes(row.phase))throw new Error('Migration target authorization changed.');
      return action(client,row);
    });
  }
  private async guard(tenant:string,operation:string,fence:string,phases:string[],requireSource:boolean){
    const row=await this.fenced(tenant,operation,fence,phases,async(client,r)=>{
      const destination=(await client.query('SELECT image_digest FROM migration_destinations WHERE tenant_id=$1 AND migration_id=$2',[tenant,r.id])).rows[0];
      if(!destination)throw new Error('Migration destination changed.');await assertQualifiedImage(client,destination.image_digest);return r;
    });
    if(requireSource){
      const source=await this.source.inspect(tenant,row.id);
      if(!source||source.tenant!==tenant||source.checkpoint!==row.source_checkpoint||source.fence!==row.source_fence||!source.writersStopped||!source.filesFrozen
        ||!await this.source.frozen(tenant,row.source_fence))throw new Error('Migration source hold changed.');
    }
    await this.fenced(tenant,operation,fence,phases,async()=>{});
  }
  private owner(tenant:string,row:any):HostOwner{return {tenant,generation:String(row.generation),machine:row.machine_id};}
  async verify(tenant:string,packageHash:string,sourceCheckpoint:string){
    const transfer=await verifiedMigrationTransfer(this.directory,tenant,packageHash,sourceCheckpoint);if(!transfer)return false;
    try{
      const context=await this.context(tenant);await assertQualifiedImage(this.directory.pool,context.image_digest);
      if(context.volume_id!==transfer.volume_id||String(context.generation)!==String(transfer.generation))return false;
      const inventory=await this.fly.inventory(context.fly_app,tenant);
      if(!inventory.present||inventory.volumes.length!==1||inventory.volumes[0].id!==context.volume_id||inventory.volumes[0].encrypted!==true||inventory.volumes[0].region!==context.region)return false;
      if(inventory.machines.length){
        if(inventory.machines.length!==1||inventory.machines[0].id!==context.machine_id)return false;
        const machine=await this.fly.machine(context.fly_app,tenant,context.machine_id,context.volume_id,String(context.generation));
        if(machine.config.image!==context.image_digest)return false;
      }
      return !!await verifiedMigrationTransfer(this.directory,tenant,packageHash,sourceCheckpoint);
    }catch{return false;}
  }
  private async recordAction(tenant:string,operation:string,fence:string,kind:string,phases:string[],authorize:()=>Promise<void>){
    await authorize();
    await this.fenced(tenant,operation,fence,phases,async(client,row)=>{
      if(!(await client.query("INSERT INTO infrastructure_actions(tenant_id,generation,kind,state) VALUES($1,$2,$3,'dispatching') ON CONFLICT DO NOTHING RETURNING kind",[tenant,row.generation,kind])).rowCount)throw new Error('Migration cloud outcome requires reconciliation.');
    });
  }
  private async observed(client:PoolClient,tenant:string,generation:string,kind:string,resource:string){
    const existing=(await client.query('SELECT * FROM infrastructure_actions WHERE tenant_id=$1 AND generation=$2 AND kind=$3',[tenant,generation,kind])).rows[0];
    if(!existing||existing.state==='observed'&&existing.resource_id!==resource)throw new Error('Unadmitted migration infrastructure.');
    await client.query("UPDATE infrastructure_actions SET state='observed',resource_id=$4 WHERE tenant_id=$1 AND generation=$2 AND kind=$3",[tenant,generation,kind,resource]);
  }
  private async boot(tenant:string,operation:string,fence:string,row:any,kind:string,phases:string[],authorize:()=>Promise<void>){
    const owner=this.owner(tenant,row),app=row.fly_app;await authorize();
    const machine=await this.fly.machine(app,tenant,owner.machine,row.volume_id,owner.generation);await authorize();
    if(['started','starting'].includes(machine.state))return;
    if(!['created','stopped'].includes(machine.state))throw new Error('Target boot state requires reconciliation.');
    if((await this.directory.pool.query('SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND generation=$2 AND kind=$3',[tenant,owner.generation,kind])).rowCount)throw new Error('A previous start may still be outstanding.');
    const bootstrap=opaqueToken();
    await this.fenced(tenant,operation,fence,phases,async client=>{
      await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[tenant]);
      await client.query("INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at) VALUES($1,$2,$3,$4,'bootstrap',clock_timestamp()+interval '20 minutes')",[hashToken(bootstrap),tenant,owner.machine,owner.generation]);
    });
    await this.fly.configureBootstrap(app,owner.machine,tenant,bootstrap,owner.generation,authorize);await authorize();
    await this.fly.action(app,owner.machine,'start',tenant,owner.generation,()=>this.recordAction(tenant,operation,fence,kind,phases,authorize));
    await this.fenced(tenant,operation,fence,phases,client=>this.observed(client,tenant,owner.generation,kind,owner.machine));
  }
  async activate(tenant:string,operation:string,fence:string):Promise<TargetCheckpoint>{
    const phases=['activating'],authorize=()=>this.guard(tenant,operation,fence,phases,true);await authorize();
    let row=await this.context(tenant);
    if(row.id!==operation||String(row.generation)!==String(row.current_generation)||!await this.verify(tenant,row.package_hash,row.source_checkpoint))throw new Error('Target package/destination changed.');
    const transfer=await verifiedMigrationTransfer(this.directory,tenant,row.package_hash,row.source_checkpoint);if(!transfer)throw new Error('Target transfer unavailable.');
    const installation=tokenId(tenant,operation,row.package_hash);
    await this.fenced(tenant,operation,fence,phases,async client=>{
      await assertQualifiedImage(client,row.image_digest);
      await client.query(`INSERT INTO migration_targets(tenant_id,migration_id,generation,volume_id,installation_id,image_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[tenant,operation,row.generation,row.volume_id,installation,row.image_digest]);
      const saved=(await client.query('SELECT * FROM migration_targets WHERE tenant_id=$1',[tenant])).rows[0];
      if(saved.migration_id!==operation||String(saved.generation)!==String(row.generation)||saved.volume_id!==row.volume_id||saved.installation_id!==installation||saved.image_digest!==row.image_digest)throw new Error('Migration target binding changed.');
    });
    const machine=await this.fly.ensureMachine(row.fly_app,tenant,row.volume_id,row.image_digest,row.region,String(row.generation),()=>this.recordAction(tenant,operation,fence,'machine',phases,authorize));await authorize();
    await this.fenced(tenant,operation,fence,phases,async client=>{
      await this.observed(client,tenant,String(row.generation),'machine',machine.id);
      await client.query('UPDATE migration_targets SET machine_id=$2 WHERE tenant_id=$1',[tenant,machine.id]);
      await client.query("UPDATE tenants SET state='provisioning',fly_app=$2,network_id=$3,volume_id=$4,machine_id=$5,image_digest=$6,region=$7 WHERE id=$1",[tenant,row.fly_app,row.network_id,row.volume_id,machine.id,row.image_digest,row.region]);
      const owner={tenant,generation:String(row.generation),machine:machine.id};await setHostIntent(client,owner,'hold');
      await stageHostInstallation(client,{...owner,id:installation,volume:row.volume_id,fullBackup:transfer.backup_id});
    });
    row=await this.context(tenant);await this.boot(tenant,operation,fence,row,'migration-install-start',phases,authorize);
    const owner=this.owner(tenant,row),deadline=Date.now()+this.timeoutMs;
    for(;;){
      await authorize();
      if((await this.directory.pool.query("SELECT 1 FROM host_installations WHERE tenant_id=$1 AND id=$2 AND machine_id=$3 AND volume_id=$4 AND generation=$5 AND state='installed'",[tenant,installation,owner.machine,row.volume_id,owner.generation])).rowCount)break;
      if(Date.now()>=deadline)throw new Error('Migration installation deadline exceeded.');await this.wait(1000);
    }
    await authorize();
    await this.fenced(tenant,operation,fence,phases,async client=>{
      await assertQualifiedImage(client,row.image_digest);await setHostIntent(client,owner,'run');
      await client.query('UPDATE migration_targets SET run_authorized_at=COALESCE(run_authorized_at,clock_timestamp()) WHERE tenant_id=$1',[tenant]);
    });
    for(;;){
      await authorize();if(await this.hosts.ready(owner))break;
      if(Date.now()>=deadline)throw new Error('Migration readiness deadline exceeded.');await this.wait(1000);
    }
    await authorize();return {...owner,checkpoint:installReceipt({...owner,volume:row.volume_id,id:installation,fullBackup:transfer.backup_id,state:'installed'}),volume:row.volume_id};
  }
  async inspect(tenant:string,operation:string):Promise<{state:'absent'|'active'|'uncertain';checkpoint?:TargetCheckpoint}>{
    const row=await this.context(tenant);if(operation!==row.id)throw new Error('Migration operation changed.');
    const targets=(await this.directory.pool.query('SELECT 1 FROM migration_targets WHERE tenant_id=$1',[tenant])).rowCount;
    if(!targets)return {state:'absent'};
    if(!row.machine_id||!row.run_authorized_at||String(row.current_generation)!==String(row.generation)||!await this.verify(tenant,row.package_hash,row.source_checkpoint))return {state:'uncertain'};
    const owner=this.owner(tenant,row),machine=await this.fly.machine(row.fly_app,tenant,row.machine_id,row.volume_id,owner.generation);
    const installed=(await this.directory.pool.query("SELECT * FROM host_installations WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND machine_id=$4 AND volume_id=$5 AND state='installed'",[tenant,row.installation_id,owner.generation,owner.machine,row.volume_id])).rows[0];
    if(machine.state!=='started'||!installed||!await this.hosts.ready(owner))return {state:'uncertain'};
    return {state:'active',checkpoint:{...owner,volume:row.volume_id,checkpoint:installed.receipt_hash}};
  }
  async stop(tenant:string,operation:string,fence:string){
    const guard=()=>this.fenced(tenant,operation,fence,[],async()=>{},true);await guard();
    const row=await this.context(tenant);
    await this.fenced(tenant,operation,fence,[],async(client,current)=>{
      // Containment may already have advanced generation. Revoke the old run
      // policy directly; do not pretend that old hosts own the new generation.
      await client.query("UPDATE host_policies SET desired='hold',revision=revision+1,observed=NULL,acknowledged_revision=NULL,reported_at=NULL WHERE tenant_id=$1 AND desired!='hold'",[tenant]);
      await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[tenant]);
      if(current.phase==='rollback_pending'&&String(current.generation)===String(row.generation))await client.query("UPDATE tenants SET state='provisioning' WHERE id=$1",[tenant]);
    },true);
    const inventory=await this.fly.inventory(row.fly_app,tenant);await guard();
    for(const machine of inventory.machines){await this.fly.action(row.fly_app,machine.id,'stop',tenant,undefined,guard);await this.fly.waitStopped(row.fly_app,tenant,machine.id);await guard();}
    const final=await this.fly.inventory(row.fly_app,tenant);await guard();
    if(final.machines.some(m=>!['created','stopped'].includes(m.state)))return false;
    // A lost start response can still represent a delayed cloud action. Keep it
    // visible for explicit reconciliation instead of treating a stop as proof.
    return !(await this.directory.pool.query("SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND kind IN ('migration-install-start','migration-checkpoint-start') AND state='dispatching'",[tenant])).rowCount;
  }
  async freeze(tenant:string,operation:string,fence:string):Promise<TargetCheckpoint&{writersStopped:boolean}>{
    const phases=['rollback_pending'],authorize=()=>this.guard(tenant,operation,fence,phases,false);await authorize();
    let row=await this.context(tenant);
    if(operation!==`${row.id}:rollback`||!row.machine_id||!row.run_authorized_at||String(row.current_generation)!==String(row.generation))throw new Error('Rollback target binding changed.');
    if(!await this.stop(tenant,operation,fence))throw new Error('Target shutdown requires reconciliation.');
    await authorize();row=await this.context(tenant);const owner=this.owner(tenant,row),id=tokenId(tenant,operation,String(row.generation));
    await this.fenced(tenant,operation,fence,phases,async client=>{
      await setHostIntent(client,owner,'hold');await stageHostCheckpoint(client,{...owner,id,volume:row.volume_id,migration:row.id});
    });
    await this.boot(tenant,operation,fence,row,'migration-checkpoint-start',phases,authorize);
    const deadline=Date.now()+this.timeoutMs;let checkpoint;
    for(;;){
      await authorize();checkpoint=await this.checkpoints.plan(owner);
      if(checkpoint?.state==='complete'&&checkpoint.receipt&&checkpoint.backup)break;
      if(Date.now()>=deadline)throw new Error('Rollback checkpoint deadline exceeded.');await this.wait(1000);
    }
    if(!await this.stop(tenant,operation,fence))throw new Error('Snapshot host shutdown requires reconciliation.');
    await authorize();
    const final=await this.checkpoints.plan(owner);
    if(final?.state!=='complete'||final.receipt!==checkpoint.receipt||final.backup!==checkpoint.backup)throw new Error('Rollback checkpoint changed after shutdown.');
    return {...owner,volume:row.volume_id,checkpoint:final.receipt!,writersStopped:true};
  }
}
