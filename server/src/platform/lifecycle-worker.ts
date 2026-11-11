import type {PoolClient} from 'pg';
import {Directory,hashToken,opaqueToken} from './directory.js';
import type {FlyTenants} from './fly-tenants.js';
import {HostControl,setHostIntent} from './host-control.js';
class LifecyclePending extends Error {
  constructor(readonly code:'infrastructure_outcome_uncertain'|'host_readiness_pending'|'provider_cleanup_pending'|'migration_cleanup_pending'){super(code);}
}

export interface LifecycleDependencies {
  fly:Pick<FlyTenants,'name'|'deploymentVolumeName'|'inventory'|'ensureApp'|'ensureVolume'|'ensureMachine'|'configureBootstrap'|'action'|'machine'|'waitStopped'|'destroy'>;
  envelopes:{create(tenant:string):Promise<void>};
  backups:{prune(tenant:string):Promise<void>};
  image:string;region:string;
}
/** All persisted ownership transitions recheck the same lease and generation.
 * Unknown create responses can be resolved by inspection, never by reissuing a
 * creation request merely because the preceding process disappeared. */
export class LifecycleWorker {
  private worker=opaqueToken();
  private hosts:HostControl;
  constructor(readonly directory:Directory,private dependencies:LifecycleDependencies){this.hosts=new HostControl(directory);}
  async tick():Promise<'idle'|'completed'|'retry'> {
    const job=await this.directory.transaction(async client=>{
      const candidate=(await client.query(`SELECT j.*,t.generation AS tenant_generation FROM lifecycle_jobs j JOIN tenants t ON t.id=j.tenant_id
        WHERE ((j.state IN ('queued','failed') AND j.retry_at<=now()) OR (j.state='running' AND j.lease_until<now()))
        AND (j.operation='delete' AND t.state='deleting' OR j.operation!='delete' AND t.state NOT IN ('deleting','deleted','failed'))
        AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM migration_runs m WHERE m.tenant_id=j.tenant_id AND m.phase!='active'))
        AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM environment_operations o WHERE o.tenant_id=j.tenant_id AND o.phase NOT IN ('completed','cancelled')))
        AND NOT EXISTS(SELECT 1 FROM lifecycle_jobs other WHERE other.tenant_id=j.tenant_id AND other.id!=j.id AND other.state='running' AND other.lease_until>now())
        ORDER BY (j.state='running') DESC,j.created_at FOR UPDATE OF j,t SKIP LOCKED LIMIT 1`)).rows[0];
      if(!candidate)return null;
      const row=(await client.query("UPDATE lifecycle_jobs SET state='running',lease_owner=$2,lease_until=now()+interval '2 minutes',fence=fence+1,attempts=attempts+1 WHERE id=$1 RETURNING *",[candidate.id,this.worker])).rows[0];
      return {...row,generation:String(candidate.tenant_generation)};
    });
    if(!job)return 'idle';
    const fenced=async<T>(fn:(client:PoolClient,tenant:any)=>Promise<T>):Promise<T>=>this.directory.transaction(async client=>{
      const tenant=(await client.query(`SELECT t.* FROM lifecycle_jobs j JOIN tenants t ON t.id=j.tenant_id
        WHERE j.id=$1 AND j.lease_owner=$2 AND j.fence=$3 AND j.state='running' AND j.lease_until>now() AND t.generation=$4
        AND (j.operation='delete' AND t.state='deleting' OR j.operation!='delete' AND t.state NOT IN ('deleting','deleted','failed'))
        AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM migration_runs m WHERE m.tenant_id=j.tenant_id AND m.phase!='active'))
        AND (j.operation='delete' OR NOT EXISTS(SELECT 1 FROM environment_operations o WHERE o.tenant_id=j.tenant_id AND o.phase NOT IN ('completed','cancelled')))
        FOR UPDATE OF j,t`,[job.id,this.worker,job.fence,job.generation])).rows[0];
      if(!tenant)throw new Error('Lifecycle lease or owner revoked.');
      await client.query("UPDATE lifecycle_jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1",[job.id]);
      return fn(client,tenant);
    });
    const guard=()=>fenced(async()=>{});
    let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void guard().catch(()=>{}).finally(()=>{heartbeatBusy=false;});},20000).unref();
    const creation=(kind:string)=>()=>fenced(async client=>{
      const inserted=await client.query("INSERT INTO infrastructure_actions(tenant_id,generation,kind,state) VALUES($1,$2,$3,'dispatching') ON CONFLICT DO NOTHING RETURNING kind",[job.tenant_id,job.generation,kind]);
      if(!inserted.rowCount)throw new LifecyclePending('infrastructure_outcome_uncertain');
    });
    const observed=async(client:PoolClient,kind:string,id:string)=>{
      await client.query("UPDATE infrastructure_actions SET state='observed',resource_id=$4 WHERE tenant_id=$1 AND generation=$2 AND kind=$3",[job.tenant_id,job.generation,kind,id]);
      await client.query('UPDATE lifecycle_jobs SET step=$2 WHERE id=$1',[job.id,kind]);
    };
    const {fly,envelopes,backups,image,region}=this.dependencies;
    const bootstrapMachine=async(app:string,machine:string)=>{
      const bootstrap=opaqueToken();
      await fenced(async client=>{
        await client.query('DELETE FROM runtime_credentials WHERE tenant_id=$1',[job.tenant_id]);
        await client.query("INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at) VALUES($1,$2,$3,$4,'bootstrap',now()+interval '20 minutes')",[hashToken(bootstrap),job.tenant_id,machine,job.generation]);
        await setHostIntent(client,{tenant:job.tenant_id,machine,generation:job.generation},'hold',true);
      });
      await guard();await fly.configureBootstrap(app,machine,job.tenant_id,bootstrap,job.generation);await guard();
    };
    try{
      let tenant=await fenced(async(_client,t)=>t);
      if(job.operation==='create'){
        await fenced(async(client)=>{await client.query("UPDATE tenants SET state='provisioning' WHERE id=$1 AND state IN ('pending','provisioning')",[tenant.id]);});
        const {app,network}=await fly.ensureApp(tenant.id,creation('app'));
        await fenced(async client=>{await client.query('UPDATE tenants SET fly_app=$2,network_id=$3 WHERE id=$1',[tenant.id,app,network]);await observed(client,'app',app);});
        const location=tenant.region??region;if(!location)throw new Error('Tenant region required.');
        const volume=await fly.ensureVolume(app,tenant.id,location,creation('volume'));
        await fenced(async client=>{await client.query('UPDATE tenants SET volume_id=$2,region=$3 WHERE id=$1',[tenant.id,volume.id,location]);await observed(client,'volume',volume.id);});
        await guard();await envelopes.create(tenant.id);await guard();
        const machine=await fly.ensureMachine(app,tenant.id,volume.id,image,location,job.generation,creation('machine'));
        await fenced(async client=>{
          await client.query('UPDATE tenants SET machine_id=$2,image_digest=$3 WHERE id=$1',[tenant.id,machine.id,image]);await observed(client,'machine',machine.id);
        });
        if(['created','stopped'].includes(machine.state)){
          // Persist a bootstrap hash before putting the bearer in a stopped VM.
          // A failed update is safe to retry with a new token while it stays down.
          await bootstrapMachine(app,machine.id);
        }
        await fenced(client=>setHostIntent(client,{tenant:tenant.id,machine:machine.id,generation:job.generation},'run'));
        await guard();await fly.action(app,machine.id,'start',tenant.id,job.generation);await guard();
        if(!await this.hosts.ready({tenant:tenant.id,machine:machine.id,generation:job.generation}))throw new LifecyclePending('host_readiness_pending');
        await fenced(async client=>{await client.query("UPDATE tenants SET state='active' WHERE id=$1",[tenant.id]);});
      }else if(job.operation==='wake'||job.operation==='suspend'){
        if(!tenant.fly_app||!tenant.machine_id||!tenant.volume_id)throw new Error('Tenant infrastructure is missing.');
        await guard();const machine=await fly.machine(tenant.fly_app,tenant.id,tenant.machine_id,tenant.volume_id,job.generation);await guard();
        if(job.operation==='wake'){
          await fenced(async client=>{await client.query("UPDATE tenants SET state='provisioning' WHERE id=$1",[tenant.id]);});
          if(['stopped','created'].includes(machine.state))await bootstrapMachine(tenant.fly_app,tenant.machine_id);
          await fenced(async client=>{
            await client.query("UPDATE tenants SET state='provisioning' WHERE id=$1",[tenant.id]);
            await setHostIntent(client,{tenant:tenant.id,machine:tenant.machine_id,generation:job.generation},'run');
          });
          await guard();await fly.action(tenant.fly_app,tenant.machine_id,'start',tenant.id,job.generation);await guard();
          if(!await this.hosts.ready({tenant:tenant.id,machine:tenant.machine_id,generation:job.generation}))throw new LifecyclePending('host_readiness_pending');
        }else{
          await fenced(client=>setHostIntent(client,{tenant:tenant.id,machine:tenant.machine_id,generation:job.generation},'hold'));
          // Stop gives a durable inactive writer, unlike freezing a process whose
          // authorization timers and external writes would resume from memory.
          await guard();await fly.action(tenant.fly_app,tenant.machine_id,'stop',tenant.id,job.generation);
          await fly.waitStopped(tenant.fly_app,tenant.id,tenant.machine_id,job.generation);await guard();
        }
        await fenced(async client=>{await client.query('UPDATE tenants SET state=$2 WHERE id=$1',[tenant.id,job.operation==='wake'?'active':'suspended']);});
      }else if(job.operation==='delete'){
        // Deletion revokes tokens first; stop compute before waiting on upstream
        // disconnections or retention cleanup that might need many retries.
        // Directory writes can lose their fence after Fly accepts a creation.
        // Inspect the deterministic namespace even when no resource ID reached
        // the directory. An absent resource cannot settle an uncertain create.
        const app=fly.name(tenant.id);
        if(tenant.fly_app&&tenant.fly_app!==app)throw new Error('Foreign tenant application.');
        const operations=(await this.directory.pool.query('SELECT id FROM environment_operations WHERE tenant_id=$1',[tenant.id])).rows.map(r=>r.id);
        await guard();const inventory=await fly.inventory(app,tenant.id,operations);await guard();
        for(const machine of inventory.machines){
          await guard();
          try{await fly.action(app,machine.id,'stop',tenant.id);await fly.waitStopped(app,tenant.id,machine.id);}
          catch(error:any){if(error.status!==404)throw error;}
          await guard();
        }
        await fenced(async client=>{
          const unresolved=(await client.query("SELECT generation,kind FROM infrastructure_actions WHERE tenant_id=$1 AND state='dispatching'",[tenant.id])).rows;
          for(const action of unresolved){
            const match=/^environment:([a-f0-9]{32}):(volume|machine)$/.exec(action.kind),deployment=match&&operations.includes(match[1])?match:null;
            const kind=deployment?.[2]??action.kind;
            const found=kind==='app'&&inventory.present?app:kind==='volume'?deployment?inventory.volumes.find(v=>v.name===fly.deploymentVolumeName(tenant.id,deployment[1]))?.id:inventory.volumes.length===1?inventory.volumes[0].id:undefined
              :kind==='machine'?inventory.machines.find(m=>String(m.config?.metadata?.swarm_generation)===String(action.generation))?.id:undefined;
            if(found)await client.query("UPDATE infrastructure_actions SET state='observed',resource_id=$4 WHERE tenant_id=$1 AND generation=$2 AND kind=$3",[tenant.id,action.generation,action.kind,found]);
          }
        });
        if((await this.directory.pool.query("SELECT 1 FROM infrastructure_actions WHERE tenant_id=$1 AND state='dispatching' LIMIT 1",[tenant.id])).rowCount)throw new LifecyclePending('infrastructure_outcome_uncertain');
        // A stopped source still contains private data. Concrete source cleanup
        // must attest retirement as well as writer shutdown before deletion may
        // finish; unavailable adapters or a database-only hold are never enough.
        if((await this.directory.pool.query("SELECT 1 FROM migration_runs WHERE tenant_id=$1 AND (writer!='none' OR source_retired_at IS NULL OR source_retirement_digest IS NULL OR source_retirement_digest !~ '^[a-f0-9]{64}$') LIMIT 1",[tenant.id])).rowCount)throw new LifecyclePending('migration_cleanup_pending');
        const pending=await this.directory.pool.query("SELECT 1 FROM connected_accounts WHERE tenant_id=$1 AND state!='deleted' LIMIT 1",[tenant.id]);
        if(pending.rowCount)throw new LifecyclePending('provider_cleanup_pending');
        await guard();await backups.prune(tenant.id);await guard();
        await fly.destroy(app,tenant.id,operations);await guard();
        await fenced(async client=>{
          await client.query('DELETE FROM wake_events WHERE tenant_id=$1',[tenant.id]);
          await client.query('DELETE FROM host_policies WHERE tenant_id=$1',[tenant.id]);
          await client.query('DELETE FROM host_installations WHERE tenant_id=$1',[tenant.id]);
          await client.query("UPDATE retired_volumes SET state='deleted',error_code=NULL WHERE tenant_id=$1",[tenant.id]);
          await client.query("UPDATE tenants SET state='deleted',encrypted_data_key=NULL,machine_id=NULL,volume_id=NULL WHERE id=$1",[tenant.id]);
          await client.query("UPDATE lifecycle_jobs SET state='completed',lease_until=NULL,error_code=NULL WHERE id=$1",[job.id]);
        });
        return 'completed';
      }else throw new Error('Unsupported lifecycle operation.');
      await fenced(async client=>{await client.query("UPDATE lifecycle_jobs SET state='completed',lease_until=NULL,error_code=NULL WHERE id=$1",[job.id]);});
      return 'completed';
    }catch(error){
      await this.directory.pool.query("UPDATE lifecycle_jobs SET state='failed',lease_until=NULL,error_code=$4,retry_at=now()+interval '5 seconds'*least(attempts,12) WHERE id=$1 AND state='running' AND lease_owner=$2 AND fence=$3",[job.id,this.worker,job.fence,error instanceof LifecyclePending?error.code:'lifecycle_requires_retry']);
      return 'retry';
    }finally{clearInterval(heartbeat);}
  }
}
