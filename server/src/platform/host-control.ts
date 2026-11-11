import {Hono} from 'hono';
import type {PoolClient} from 'pg';
import type {Directory} from './directory.js';
import type {RuntimeIdentity} from './runtime-identity.js';
export interface HostOwner {tenant:string;generation:string;machine:string}
export interface HostPolicy {tenant:string;generation:string;machine:string;revision:string;desired:'hold'|'run'}

/** Trusted lifecycle control only; no browser/tenant mutation route is mounted.
 * Call within the transaction that checks the current lifecycle/migration fence. */
export async function setHostIntent(client:PoolClient,owner:HostOwner,desired:'hold'|'run',restart=false){
  const tenant=await client.query("SELECT 1 FROM tenants WHERE id=$1 AND generation=$2 AND machine_id=$3 AND state IN ('active','provisioning','suspended') FOR UPDATE",[owner.tenant,owner.generation,owner.machine]);
  if(!tenant.rowCount)throw new Error('Host ownership changed.');
  if(desired==='run'&&(await client.query("SELECT 1 FROM host_installations WHERE tenant_id=$1 AND (generation!=$2 OR machine_id!=$3 OR state!='installed')",[owner.tenant,owner.generation,owner.machine])).rowCount)throw new Error('Environment installation is not acknowledged.');
  if(desired==='run'&&(await client.query("SELECT 1 FROM host_checkpoints WHERE tenant_id=$1 AND state!='cancelled'",[owner.tenant])).rowCount)throw new Error('A reconciled checkpoint still requires its writer hold.');
  const result=await client.query(`INSERT INTO host_policies(tenant_id,generation,machine_id,desired) VALUES($1,$2,$3,$4)
    ON CONFLICT(tenant_id) DO UPDATE SET generation=excluded.generation,machine_id=excluded.machine_id,desired=excluded.desired,
      revision=host_policies.revision+1,acknowledged_revision=NULL,observed=NULL,reported_at=NULL,error_code=NULL
    WHERE host_policies.generation!=excluded.generation OR host_policies.machine_id!=excluded.machine_id OR host_policies.desired!=excluded.desired OR $5
    RETURNING revision`,[owner.tenant,owner.generation,owner.machine,desired,restart]);
  return String(result.rows[0]?.revision??(await client.query('SELECT revision FROM host_policies WHERE tenant_id=$1',[owner.tenant])).rows[0].revision);
}
export class HostControl {
  constructor(readonly directory:Directory){}
  async policy(owner:HostOwner):Promise<HostPolicy>{
    const result=(await this.directory.pool.query(`SELECT p.* FROM host_policies p JOIN tenants t ON t.id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.generation=$2 AND p.machine_id=$3 AND t.generation=p.generation AND t.machine_id=p.machine_id
      AND t.state IN ('active','provisioning')`,[owner.tenant,owner.generation,owner.machine])).rows[0];
    // Missing explicit policy is a hold, never implicit permission to start.
    return {...owner,revision:result?String(result.revision):'0',desired:result?.desired??'hold'};
  }
  async report(owner:HostOwner,input:{revision:string;state:'held'|'running';error?:string}){
    if(Object.keys(input).some(k=>!['revision','state','error'].includes(k))||!/^\d+$/.test(input.revision)||!['held','running'].includes(input.state)||input.error!==undefined&&input.error!=='host_requires_reconciliation')throw new Error('Invalid host readiness report.');
    const result=await this.directory.pool.query(`UPDATE host_policies p SET acknowledged_revision=p.revision,observed=$5,error_code=$6,reported_at=now()
      FROM tenants t WHERE p.tenant_id=$1 AND p.generation=$2 AND p.machine_id=$3 AND p.revision=$4 AND t.id=p.tenant_id
      AND t.generation=p.generation AND t.machine_id=p.machine_id AND t.state IN ('active','provisioning')
      AND (p.desired='run' AND $5='running' OR $5='held') RETURNING p.tenant_id`,[owner.tenant,owner.generation,owner.machine,input.revision,input.state,input.error??null]);
    if(!result.rowCount)throw new Error('Host readiness authorization changed.');
  }
  async ready(owner:HostOwner){
    return !!(await this.directory.pool.query(`SELECT 1 FROM host_policies p WHERE tenant_id=$1 AND generation=$2 AND machine_id=$3 AND desired='run'
      AND observed='running' AND acknowledged_revision=revision AND error_code IS NULL AND reported_at>now()-interval '4 minutes'`,[owner.tenant,owner.generation,owner.machine])).rowCount;
  }
}
export function hostControlRoutes(control:HostControl,runtime:RuntimeIdentity){
  const app=new Hono<{Variables:{owner:HostOwner}}>();
  app.use('*',async(c,next)=>{
    try{c.set('owner',await runtime.verify((c.req.header('authorization')??'').replace(/^Bearer /,''),'swarm-host'));}
    catch{return c.json({error:'Host authorization required.'},401);}return next();
  });
  app.onError((_error,c)=>c.json({error:'Host readiness changed or requires retry.'},409));
  app.get('/policy',async c=>c.json(await control.policy(c.get('owner'))));
  app.post('/state',async c=>{await control.report(c.get('owner'),await c.req.json());return c.json({ok:true});});
  return app;
}
