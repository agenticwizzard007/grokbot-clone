import {randomBytes} from 'node:crypto';
import {FlyTenants} from '../../server/src/platform/fly-tenants.js';
export class FakeFly extends FlyTenants {
  apps=new Map<string,any>();volumes=new Map<string,any[]>();machines=new Map<string,any[]>();calls:{method:string;route:string}[]=[];
  after:((method:string,route:string,result:any)=>Promise<void>)|undefined;
  before:((method:string,route:string)=>Promise<void>)|undefined;
  failBefore:((method:string,route:string)=>boolean)|undefined;
  constructor(){super('test-only','staging');}
  override async request(method:string,route:string,body?:any):Promise<any>{
    this.calls.push({method,route});
    await this.before?.(method,route);
    if(this.failBefore?.(method,route))throw new Error('response lost');
    const parts=route.split('/').filter(Boolean),app=decodeURIComponent(parts[1]??'');let result:any={};
    const missing=()=>{throw Object.assign(new Error('not found'),{status:404});};
    if(route==='/apps'&&method==='POST'){result={name:body.app_name,network:body.network};this.apps.set(body.app_name,result);}
    else if(parts.length===2&&method==='GET')result=this.apps.get(app)??missing();
    else if(parts.length===2&&method==='DELETE'){this.apps.delete(app);}
    else if(parts[2]==='volumes'){
      const list=this.volumes.get(app)??[];
      if(method==='GET')result=parts.length===3?list:list.find(v=>v.id===parts[3])??missing();
      if(method==='PUT'&&parts[4]==='extend'){const disk=list.find(v=>v.id===parts[3])??missing();disk.size_gb=body.size_gb;result={needs_restart:true};}
      if(method==='POST'){result={...body,id:`volume_${randomBytes(6).toString('hex')}`,state:'created'};list.push(result);this.volumes.set(app,list);}
      if(method==='DELETE'){
        if(this.machines.get(app)?.some(m=>m.config.mounts.some((mount:any)=>mount.volume===parts[3])))throw Object.assign(new Error('volume attached'),{status:409});
        this.volumes.set(app,list.filter(v=>v.id!==parts[3]));
      }
    }else if(parts[2]==='machines'){
      const list=this.machines.get(app)??[];
      if(parts.length===3&&method==='GET')result=list;
      else if(parts.length===3&&method==='POST'){
        if(list.some(m=>m.config.mounts.some((mount:any)=>body.config.mounts.some((next:any)=>next.volume===mount.volume))))throw Object.assign(new Error('volume attached'),{status:409});
        result={id:`machine_${randomBytes(6).toString('hex')}`,state:'created',config:body.config,region:body.region};list.push(result);this.machines.set(app,list);
      }
      else{
        const id=parts[3].split('?')[0],current=list.find(m=>m.id===id)??missing();
        if(method==='GET')result=current;
        else if(method==='DELETE')this.machines.set(app,list.filter(m=>m.id!==id));
        else if(parts[4]==='start')current.state='started';
        else if(parts[4]==='stop')current.state='stopped';
        else if(parts[4]==='suspend')current.state='suspended';
        else if(method==='POST'&&body?.config){current.config=body.config;}
      }
    }else throw new Error(`Unexpected fixture request ${method} ${route}`);
    const copy=structuredClone(result);await this.after?.(method,route,copy);return copy;
  }
}
