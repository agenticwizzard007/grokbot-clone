import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';

export interface TenantGuest {cpu_kind:'shared'|'performance';cpus:number;memory_mb:number}
export interface TenantCapacity {guest:TenantGuest;volumeGb:number}
export interface CapacityPolicy {
  version:1;enabled:boolean;tiers:TenantGuest[];maxVolumeGb:number;volumeStepGb:number;
  cpuThreshold:number;memoryThreshold:number;diskThreshold:number;reserveGb:number;
  windowSeconds:number;cooldownSeconds:number;
}
export interface CapacitySample {
  tenant:string;generation:string;machine:string;volume:string;at:number;
  cpu:number;memory:number;usedBytes:number;
}
export interface CapacityChange {
  policyRevision:string;source:TenantCapacity;target:TenantCapacity;samples:CapacitySample[];
  evidence:{uri:string;sha256:string;reviewer:string};maintenanceAcknowledged:true;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,keys:string[])=>{if(!object(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Invalid capacity fields.');};
const integer=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
const fraction=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
export function validateGuest(value:unknown):asserts value is TenantGuest {
  exact(value,['cpu_kind','cpus','memory_mb']);const guest=value as TenantGuest;
  if(!['shared','performance'].includes(guest.cpu_kind)||!integer(guest.cpus,1,32)||!integer(guest.memory_mb,1024,131072)||guest.memory_mb%256)throw new Error('Invalid tenant guest size.');
}
export const sameGuest=(a:TenantGuest,b:TenantGuest)=>a.cpu_kind===b.cpu_kind&&a.cpus===b.cpus&&a.memory_mb===b.memory_mb;
export function validateCapacity(value:unknown):asserts value is TenantCapacity {
  exact(value,['guest','volumeGb']);const capacity=value as TenantCapacity;validateGuest(capacity.guest);
  if(!integer(capacity.volumeGb,10,10000))throw new Error('Invalid tenant volume size.');
}
export function validateCapacityPolicy(value:unknown):asserts value is CapacityPolicy {
  exact(value,['version','enabled','tiers','maxVolumeGb','volumeStepGb','cpuThreshold','memoryThreshold','diskThreshold','reserveGb','windowSeconds','cooldownSeconds']);
  const p=value as CapacityPolicy;
  if(p.version!==1||typeof p.enabled!=='boolean'||!Array.isArray(p.tiers)||!p.tiers.length||p.tiers.length>8)throw new Error('Invalid capacity policy.');
  p.tiers.forEach(validateGuest);
  for(let n=1;n<p.tiers.length;n++){
    const a=p.tiers[n-1],b=p.tiers[n];
    if(a.cpu_kind!==b.cpu_kind||b.cpus<a.cpus||b.memory_mb<a.memory_mb||sameGuest(a,b))throw new Error('Capacity tiers must increase within one approved CPU class.');
  }
  if(!integer(p.maxVolumeGb,10,10000)||!integer(p.volumeStepGb,1,p.maxVolumeGb)||!integer(p.reserveGb,1,p.maxVolumeGb)
    ||!integer(p.windowSeconds,60,3600)||!integer(p.cooldownSeconds,300,86400)
    ||![p.cpuThreshold,p.memoryThreshold,p.diskThreshold].every(v=>fraction(v)&&v>=0.5&&v<=0.99))throw new Error('Invalid capacity policy limits.');
}
/** This policy is installed only by a trusted operations command. Nothing in a
 * Bot, MCP result, browser request or tenant application can raise its ceiling. */
export async function setCapacityPolicy(client:PoolClient,tenant:string,policy:CapacityPolicy){
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant))throw new Error('Invalid tenant.');validateCapacityPolicy(policy);
  if(!(await client.query("SELECT 1 FROM tenants WHERE id=$1 AND state NOT IN ('deleting','deleted') FOR UPDATE",[tenant])).rowCount)throw new Error('Tenant unavailable.');
  // Do not silently abandon a held machine if its admitted policy is revoked.
  if((await client.query("SELECT 1 FROM environment_operations WHERE tenant_id=$1 AND phase NOT IN ('completed','cancelled')",[tenant])).rowCount)throw new Error('Finish or reconcile current environment maintenance first.');
  return String((await client.query(`INSERT INTO tenant_capacity_policies(tenant_id,policy) VALUES($1,$2)
    ON CONFLICT(tenant_id) DO UPDATE SET policy=excluded.policy,revision=tenant_capacity_policies.revision+1,updated_at=now() RETURNING revision`,[tenant,policy])).rows[0].revision);
}
export function recommendCapacity(policy:CapacityPolicy,source:TenantCapacity,samples:CapacitySample[],owner:{tenant:string;generation:string;machine:string;volume:string},now=Date.now()):TenantCapacity {
  validateCapacityPolicy(policy);validateCapacity(source);
  if(!policy.enabled)throw new Error('Capacity policy is disabled.');
  if(!Array.isArray(samples)||samples.length<3||samples.length>120)throw new Error('A bounded trusted usage window is required.');
  const tier=policy.tiers.findIndex(g=>sameGuest(g,source.guest));if(tier<0||source.volumeGb>policy.maxVolumeGb)throw new Error('Source is outside the approved capacity policy.');
  let previous=0,cpuSeconds=0,memorySeconds=0,usedBytes=0;
  for(const s of samples){
    exact(s,['tenant','generation','machine','volume','at','cpu','memory','usedBytes']);
    if(s.tenant!==owner.tenant||s.generation!==owner.generation||s.machine!==owner.machine||s.volume!==owner.volume
      ||!integer(s.at,1,Number.MAX_SAFE_INTEGER)||s.at>now||!fraction(s.cpu)||!fraction(s.memory)||!integer(s.usedBytes,0,source.volumeGb*1024**3)
      ||previous&&(s.at<=previous||s.at-previous>60000))throw new Error('Usage samples are stale, incomplete or owned by another environment.');
    if(previous){cpuSeconds+=s.cpu*(s.at-previous);memorySeconds+=s.memory*(s.at-previous);}previous=s.at;usedBytes=Math.max(usedBytes,s.usedBytes);
  }
  const duration=previous-samples[0].at;
  if(now-previous>60000||duration<policy.windowSeconds*1000||duration>3600000)throw new Error('Usage window is stale or too short.');
  const pressure=cpuSeconds/duration>=policy.cpuThreshold||memorySeconds/duration>=policy.memoryThreshold;
  if(pressure&&tier===policy.tiers.length-1)throw new Error('Approved compute capacity exhausted; review quota and policy.');
  const needed=Math.max(Math.ceil(usedBytes/1024**3+policy.reserveGb),Math.ceil(usedBytes/1024**3/policy.diskThreshold));
  const volumeGb=needed>source.volumeGb?Math.ceil(needed/policy.volumeStepGb)*policy.volumeStepGb:source.volumeGb;
  if(volumeGb>policy.maxVolumeGb)throw new Error('Approved storage capacity exhausted; review quota and policy.');
  return {guest:{...policy.tiers[tier+(pressure?1:0)]},volumeGb};
}
export function capacityDigest(change:CapacityChange){return createHash('sha256').update(JSON.stringify(change)).digest('hex');}
export async function validateCapacityChange(client:PoolClient,change:CapacityChange,owner:{tenant:string;generation:string;machine:string;volume:string},now=Date.now()){
  exact(change,['policyRevision','source','target','samples','evidence','maintenanceAcknowledged']);
  if(!/^[1-9]\d*$/.test(change.policyRevision)||change.maintenanceAcknowledged!==true)throw new Error('Reviewed maintenance acknowledgement is required.');
  exact(change.evidence,['uri','sha256','reviewer']);
  const {uri,sha256,reviewer}=change.evidence;
  if(typeof uri!=='string'||uri.length>2048||!/^https:\/\//.test(uri)||!/^([a-f0-9]{64})$/.test(sha256)||typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>200)throw new Error('Trusted usage evidence and reviewer are required.');
  const url=new URL(uri);if(url.username||url.password||url.hash)throw new Error('Evidence URI cannot carry credentials or fragments.');
  const row=(await client.query('SELECT revision,policy FROM tenant_capacity_policies WHERE tenant_id=$1 FOR UPDATE',[owner.tenant])).rows[0];
  if(!row||String(row.revision)!==change.policyRevision)throw new Error('Capacity policy changed or is missing.');
  const recommended=recommendCapacity(row.policy,change.source,change.samples,owner,now);validateCapacity(change.target);
  if(!sameGuest(recommended.guest,change.target.guest)||recommended.volumeGb!==change.target.volumeGb)throw new Error('Capacity target differs from the reviewed usage recommendation.');
  if(sameGuest(change.source.guest,change.target.guest)&&change.source.volumeGb===change.target.volumeGb)throw new Error('Usage does not require a capacity change.');
  if((await client.query("SELECT 1 FROM environment_operations WHERE tenant_id=$1 AND capacity_change IS NOT NULL AND created_at>now()-make_interval(secs=>$2) LIMIT 1",[owner.tenant,row.policy.cooldownSeconds])).rowCount)throw new Error('Capacity change cooldown is active.');
}
export async function assertCapacityQualified(client:Pick<PoolClient,'query'>,image:string){
  if(!(await client.query("SELECT 1 FROM release_gates WHERE name='tenant-capacity-resize' AND image_digest=$1 AND evidence_uri!=''",[image])).rowCount)throw new Error('Tenant capacity resize qualification is required.');
}
