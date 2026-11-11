import { createHash } from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import { pinnedImage } from '../runtime/container-policy.js';
import {validateGuest,sameGuest,type TenantGuest,type TenantCapacity} from './tenant-capacity.js';
const segment=(s:string)=>encodeURIComponent(s);
export type BeforeCreate=()=>Promise<void>;
export interface TenantMachine {id:string;state:string;region?:string;config:any}
export class FlyTenants {
  constructor(private token=process.env.FLY_API_TOKEN,private org=process.env.FLY_ORG_SLUG) {if(!token||!org)throw new Error('Fly provisioner credentials are required.');}
  async request(method:string,route:string,body?:unknown):Promise<any>{
    const result=await fetch(`https://api.machines.dev/v1${route}`,{method,redirect:'error',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45_000)});
    if(!result.ok){await result.body?.cancel();throw Object.assign(new Error(`Fly request failed (${result.status}).`),{status:result.status});}
    if(result.status===204){await result.body?.cancel();return {};}
    const reader=result.body?.getReader();if(!reader)return {};
    let bytes=0;const chunks:Uint8Array[]=[];
    try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>8*1024*1024)throw new Error('Fly response limit exceeded.');chunks.push(next.value);}}finally{await reader.cancel();}
    const text=Buffer.concat(chunks).toString();return text?JSON.parse(text):{};
  }
  name(tenant:string){if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant))throw new Error('Invalid tenant.');return `swarm-u-${createHash('sha256').update(tenant).digest('hex').slice(0,32)}`;}
  network(tenant:string){this.name(tenant);return `tenant-${createHash('sha256').update(tenant).digest('hex').slice(0,32)}`;}
  volumeName(tenant:string){this.name(tenant);return `tenant_${createHash('sha256').update(tenant).digest('hex').slice(0,16)}`;}
  deploymentVolumeName(tenant:string,operation:string){this.name(tenant);if(!/^[a-f0-9]{32}$/.test(operation))throw new Error('Invalid deployment operation.');return `v_${createHash('sha256').update(JSON.stringify([tenant,operation])).digest('hex').slice(0,26)}`;}
  private appName(app:string,tenant:string){if(app!==this.name(tenant))throw new Error('Foreign tenant application.');}
  async ensureApp(tenant:string,beforeCreate?:BeforeCreate){
    const app=this.name(tenant),network=this.network(tenant);
    let actual;
    try{actual=await this.request('GET',`/apps/${segment(app)}`);}catch(e:any){
      if(e.status!==404)throw e;await beforeCreate?.();
      await this.request('POST','/apps',{app_name:app,org_slug:this.org,network});actual=await this.request('GET',`/apps/${segment(app)}`);
    }
    // A separate app is not itself a network boundary. Provider attestation is mandatory.
    const selected=typeof actual.network==='string'?actual.network:actual.network?.name;
    if(selected!==network)throw new Error('Fly private-network isolation could not be verified. Provisioning stopped.');
    return {app,network};
  }
  async ensureVolume(app:string,tenant:string,region:string,beforeCreate?:BeforeCreate){
    this.appName(app,tenant);
    const name=this.volumeName(tenant),volumes=await this.request('GET',`/apps/${segment(app)}/volumes`);
    if(!Array.isArray(volumes))throw new Error('Invalid volume inventory.');
    const existing=volumes.filter((v:any)=>v.name===name&&v.state!=='destroyed');
    if(existing.length>1)throw new Error('Ambiguous tenant volumes require reconciliation.');
    if(!existing.length)await beforeCreate?.();
    const volume=existing[0]??await this.request('POST',`/apps/${segment(app)}/volumes`,{name,region,size_gb:10,encrypted:true});
    if(volume.encrypted!==true||volume.region!==region||!volume.id)throw new Error('Encrypted volume identity could not be verified.');
    return volume;
  }
  private checkMachine(machine:TenantMachine,tenant:string,volume?:string,generation?:string){
    const c=machine.config;
    if(!machine.id||c?.metadata?.swarm_tenant!==tenant||c.services?.length||c.mounts?.length!==1||c.mounts[0].path!=='/data'
      ||c.env?.SWARM_TENANT_ID!==tenant||(volume&&c.mounts[0].volume!==volume)||c.env?.SWARM_VOLUME_ID!==c.mounts[0].volume
      ||(generation&&(String(c.metadata.swarm_generation)!==generation||c.env?.SWARM_RUNTIME_GENERATION!==generation)))throw new Error('Unsafe or foreign tenant machine.');
    pinnedImage(c.image);
  }
  async machine(app:string,tenant:string,id:string,volume?:string,generation?:string):Promise<TenantMachine>{
    this.appName(app,tenant);const machine=await this.request('GET',`/apps/${segment(app)}/machines/${segment(id)}`);
    if(machine.id!==id)throw new Error('Machine identity changed.');this.checkMachine(machine,tenant,volume,generation);return machine;
  }
  async ensureMachine(app:string,tenant:string,volume:string,image:string,region:string,generation:string,beforeCreate?:BeforeCreate,guest:TenantGuest={cpu_kind:'shared',cpus:2,memory_mb:4096}){
    this.appName(app,tenant);pinnedImage(image);validateGuest(guest);
    const machines=await this.request('GET',`/apps/${segment(app)}/machines`);
    if(!Array.isArray(machines)||machines.some((m:any)=>m.state!=='destroyed'&&m.config?.metadata?.swarm_tenant!==tenant))throw new Error('Foreign machine in tenant application.');
    const existing=machines.filter((m:any)=>m.state!=='destroyed');
    if(existing.length>1)throw new Error('Multiple tenant writers require reconciliation.');
    if(existing[0]){this.checkMachine(existing[0],tenant,volume,generation);if(existing[0].config.image!==image)throw new Error('Runtime image update requires an explicit lifecycle operation.');if(!sameGuest(existing[0].config.guest,guest))throw new Error('Machine size differs from the admitted operation.');return existing[0] as TenantMachine;}
    await beforeCreate?.();
    const machine=await this.request('POST',`/apps/${segment(app)}/machines`,{name:'tenant',region,skip_launch:true,config:{
      image,guest:{...guest},mounts:[{volume,path:'/data'}],
      services:[],metadata:{swarm_tenant:tenant,swarm_generation:generation},
      env:{SWARM_TENANT_ID:tenant,SWARM_VOLUME_ID:volume,SWARM_RUNTIME_GENERATION:generation,PLATFORM_URL:process.env.PLATFORM_URL,COMPOSIO_GATEWAY_URL:process.env.COMPOSIO_GATEWAY_URL},
      restart:{policy:'on-failure',max_retries:5},
    }});
    this.checkMachine(machine,tenant,volume,generation);if(!sameGuest(machine.config.guest,guest))throw new Error('Created machine size is unverified.');return machine as TenantMachine;
  }
  async capacity(app:string,tenant:string,machine:string,volume:string,generation:string,region:string,operations:string[]=[],image?:string):Promise<TenantCapacity>{
    const inventory=await this.inventory(app,tenant,operations),current=await this.machine(app,tenant,machine,volume,generation);
    const disk=inventory.volumes.find(v=>v.id===volume);validateGuest(current.config.guest);
    if(image&&current.config.image!==image||current.region!==region||!disk||disk.encrypted!==true||disk.region!==region||!Number.isSafeInteger(disk.size_gb)||disk.size_gb<10||disk.size_gb>10000)throw new Error('Tenant capacity ownership or source image is unverified.');
    return {guest:{...current.config.guest},volumeGb:disk.size_gb};
  }
  /** A lost extension response is an uncertain write. The caller durably marks
   * dispatch before this request and refuses another dispatch until inspection
   * proves the target size. No relative increments or volume shrinking. */
  async extendVolume(app:string,tenant:string,volume:string,region:string,sourceGb:number,targetGb:number,operations:string[],beforeEffect:BeforeCreate){
    if(!Number.isSafeInteger(sourceGb)||!Number.isSafeInteger(targetGb)||sourceGb<10||targetGb<=sourceGb||targetGb>10000)throw new Error('Invalid volume growth.');
    const inspect=async()=>{
      const inventory=await this.inventory(app,tenant,operations),disk=inventory.volumes.find(v=>v.id===volume);
      if(!disk||disk.encrypted!==true||disk.region!==region||![sourceGb,targetGb].includes(disk.size_gb)||disk.size_gb!==targetGb&&inventory.machines.some(m=>m.config?.mounts?.some((v:any)=>v.volume===volume)))throw new Error('Volume growth requires a verified detached tenant volume.');
      return disk;
    };
    let disk=await inspect();if(disk.size_gb===targetGb)return disk;
    await beforeEffect();await this.request('PUT',`/apps/${segment(app)}/volumes/${segment(volume)}/extend`,{size_gb:targetGb});
    disk=await inspect();if(disk.size_gb!==targetGb)throw new Error('Volume growth outcome requires reconciliation.');return disk;
  }
  async configureBootstrap(app:string,machine:string,tenant:string,bootstrap:string,generation?:string,beforeEffect?:BeforeCreate){
    const current=await this.machine(app,tenant,machine,undefined,generation);
    if(!['created','stopped'].includes(current.state))throw new Error('Bootstrap changes require a stopped machine.');
    await beforeEffect?.();
    await this.request('POST',`/apps/${segment(app)}/machines/${segment(machine)}`,{skip_launch:true,config:{...current.config,files:[{guest_path:'/run/swarm-host/bootstrap',raw_value:Buffer.from(bootstrap).toString('base64')}]}});
  }
  async action(app:string,machine:string,operation:'start'|'suspend'|'stop',tenant:string,generation?:string,beforeEffect?:BeforeCreate){
    const current=await this.machine(app,tenant,machine,undefined,generation);
    if(operation==='start'&&['started','starting'].includes(current.state)||operation==='stop'&&['stopped','stopping'].includes(current.state)||operation==='suspend'&&['suspended','suspending'].includes(current.state))return;
    await beforeEffect?.();
    await this.request('POST',`/apps/${segment(app)}/machines/${segment(machine)}/${operation}`,{});
  }
  async waitStopped(app:string,tenant:string,machine:string,generation?:string,wait=(ms:number)=>delay(ms)){
    for(let n=0;n<30;n++){const current=await this.machine(app,tenant,machine,undefined,generation);if(['stopped','created'].includes(current.state))return current;await wait(1000);}
    throw new Error('Machine stop outcome requires reconciliation.');
  }
  async removeStoppedMachine(app:string,tenant:string,id:string,generation:string){
    const machine=await this.machine(app,tenant,id,undefined,generation).catch((e:any)=>{if(e.status===404)return null;throw e;});
    if(!machine)return;
    if(!['stopped','created'].includes(machine.state))throw new Error('Machine removal requires a stopped writer.');
    await this.request('DELETE',`/apps/${segment(app)}/machines/${segment(id)}`).catch((e:any)=>{if(e.status!==404)throw e;});
    const remaining=await this.machine(app,tenant,id,undefined,generation).catch((e:any)=>{if(e.status===404)return null;throw e;});
    if(remaining&&remaining.state!=='destroyed')throw new Error('Machine removal is not confirmed.');
  }
  async ensureDeploymentVolume(app:string,tenant:string,operation:string,region:string,operations:string[],beforeCreate:BeforeCreate,sizeGb=10){
    if(!Number.isSafeInteger(sizeGb)||sizeGb<10||sizeGb>10000)throw new Error('Invalid restore volume size.');
    const inventory=await this.inventory(app,tenant,operations);if(!inventory.present)throw new Error('Existing tenant application is missing.');
    const name=this.deploymentVolumeName(tenant,operation),matching=inventory.volumes.filter(v=>v.name===name&&v.state!=='destroyed');
    if(matching.length>1)throw new Error('Ambiguous restore volumes.');
    if(!matching.length)await beforeCreate();
    const volume=matching[0]??await this.request('POST',`/apps/${segment(app)}/volumes`,{name,region,size_gb:sizeGb,encrypted:true});
    if(volume.name!==name||!volume.id||volume.encrypted!==true||volume.region!==region||volume.size_gb!==sizeGb)throw new Error('Restore volume ownership or size is unverified.');
    return volume;
  }
  async removeRetiredVolume(app:string,tenant:string,id:string,operations:string[]){
    const inventory=await this.inventory(app,tenant,operations),volume=inventory.volumes.find(v=>v.id===id);
    if(!volume)return;
    if(inventory.machines.some(m=>m.config?.mounts?.some((mount:any)=>mount.volume===id)))throw new Error('Retired volume remains attached.');
    await this.request('DELETE',`/apps/${segment(app)}/volumes/${segment(id)}`).catch((e:any)=>{if(e.status!==404)throw e;});
    const remaining=await this.inventory(app,tenant,operations);
    if(remaining.volumes.some(v=>v.id===id&&v.state!=='destroyed'))throw new Error('Retired volume deletion is not confirmed.');
  }
  async destroy(app:string,tenant:string,operations:string[]=[]){
    const {present,machines,volumes}=await this.inventory(app,tenant,operations);
    if(!present)return;
    for(const m of machines)await this.request('DELETE',`/apps/${segment(app)}/machines/${segment(m.id)}?force=true`).catch((e:any)=>{if(e.status!==404)throw e;});
    for(const v of volumes)await this.request('DELETE',`/apps/${segment(app)}/volumes/${segment(v.id)}`).catch((e:any)=>{if(e.status!==404)throw e;});
    await this.request('DELETE',`/apps/${segment(app)}`).catch((e:any)=>{if(e.status!==404)throw e;});
    const remaining=await this.request('GET',`/apps/${segment(app)}`).catch((e:any)=>{if(e.status===404)return null;throw e;});
    if(remaining)throw new Error('Tenant application deletion is not confirmed.');
  }
  async inventory(app:string,tenant:string,operations:string[]=[]):Promise<{present:boolean;machines:TenantMachine[];volumes:any[]}>{
    this.appName(app,tenant);
    const actual=await this.request('GET',`/apps/${segment(app)}`).catch((e:any)=>{if(e.status===404)return null;throw e;});
    if(!actual)return {present:false,machines:[],volumes:[]};
    if((typeof actual.network==='string'?actual.network:actual.network?.name)!==this.network(tenant))throw new Error('Foreign application network; cleanup requires reconciliation.');
    const machines=await this.request('GET',`/apps/${segment(app)}/machines`).catch((e:any)=>{if(e.status===404)return [];throw e;});
    const volumes=await this.request('GET',`/apps/${segment(app)}/volumes`).catch((e:any)=>{if(e.status===404)return [];throw e;});
    const names=new Set([this.volumeName(tenant),...operations.map(id=>this.deploymentVolumeName(tenant,id))]);
    if(!Array.isArray(machines)||!Array.isArray(volumes)||machines.some(m=>m.config?.metadata?.swarm_tenant!==tenant)||volumes.some(v=>!names.has(v.name)))throw new Error('Foreign resource in tenant application; cleanup requires reconciliation.');
    // Validate the complete inventory before the first destructive effect.
    return {present:true,machines,volumes};
  }
}
