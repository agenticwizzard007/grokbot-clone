import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
export const image=`sha256:${'a'.repeat(64)}`;
export const foreignImage=`sha256:${'b'.repeat(64)}`;
export async function fakeDocker() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mt-b-engine-')),socket=path.join(root,'engine.sock');
  const networks=new Map<string,any>(),volumes=new Map<string,any>(),containers=new Map<string,any>();
  const calls:{method:string;route:string;body:any}[]=[];
  const state={networks,volumes,containers,calls,imageConfig:{Entrypoint:null,Cmd:['sleep','3600'],Env:['PATH=/bin:/usr/bin']},
    after:undefined as undefined|((method:string,route:string,result:any)=>void),failAfter:undefined as undefined|((method:string,route:string)=>boolean)};
  const id=()=>randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url!,'http://docker'),route=url.pathname.replace(/^\/v1\.44/,''),method=req.method!;
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
      const bytes=Buffer.concat(chunks),body=req.headers['content-type']==='application/x-tar'?bytes:bytes.length?JSON.parse(bytes.toString()):undefined;
      calls.push({method,route,body});
      const parts=route.split('/').filter(Boolean).map(decodeURIComponent);
      const found=(v:any)=>{if(!v)throw Object.assign(new Error('missing'),{status:404});return v;};
      let result:any={};
      if(route==='/info')result={MemoryLimit:true,SwapLimit:true,CpuCfsQuota:true,PidsLimit:true,SecurityOptions:['name=seccomp,profile=builtin']};
      else if(route==='/networks/create') {
        const network={...body,Id:id(),Scope:'local',Containers:{}};networks.set(network.Name,network);result={Id:network.Id};
      }else if(parts[0]==='networks') {
        const network=found([...networks.values()].find(n=>n.Name===parts[1]||n.Id===parts[1]));
        if(method==='DELETE') {if(Object.keys(network.Containers).length)throw Object.assign(new Error('attached'),{status:409});networks.delete(network.Name);}
        else result=network;
      }else if(route==='/volumes/create') {
        if(!volumes.has(body.Name))volumes.set(body.Name,{...body,Scope:'local',Options:null});result=volumes.get(body.Name);
      }else if(route==='/volumes')result={Volumes:[...volumes.values()],Warnings:null};
      else if(parts[0]==='volumes') {
        result=found(volumes.get(parts[1]));
        if(method==='DELETE') {
          if([...containers.values()].some(c=>c.Mounts.some((m:any)=>m.Name===parts[1])))throw Object.assign(new Error('attached'),{status:409});
          volumes.delete(parts[1]);result={};
        }
      }else if(parts[0]==='images')result={Id:parts[1],Config:state.imageConfig};
      else if(route==='/containers/create') {
        if([...containers.values()].some(c=>c.Name===`/${url.searchParams.get('name')}`))throw Object.assign(new Error('name conflict'),{status:409});
        const container={Id:id(),Name:`/${url.searchParams.get('name')}`,Config:{...body},HostConfig:{...body.HostConfig},State:{Running:false,Paused:false,Status:'created'},
          Mounts:body.HostConfig.Mounts.map((m:any)=>({Type:m.Type,Name:m.Source,Destination:m.Target,RW:!m.ReadOnly})),NetworkSettings:{Networks:{},Ports:{}}};
        const network=found(networks.get(body.HostConfig.NetworkMode));container.NetworkSettings.Networks[network.Name]={NetworkID:network.Id};
        containers.set(container.Id,container);result={Id:container.Id};
      }else if(route==='/containers/json') {
        let list=[...containers.values()];const filter=JSON.parse(url.searchParams.get('filters')??'{}');
        if(filter.volume)list=list.filter(c=>c.Mounts.some((m:any)=>filter.volume.includes(m.Name)));
        if(filter.network)list=list.filter(c=>filter.network.includes(c.HostConfig.NetworkMode));
        result=list.map(c=>({Id:c.Id,Names:[c.Name],Labels:c.Config.Labels,Mounts:c.Mounts,NetworkSettings:c.NetworkSettings}));
      }else if(parts[0]==='containers') {
        const container=found(containers.get(parts[1])??[...containers.values()].find(c=>c.Name===`/${parts[1]}`));
        const network=networks.get(container.HostConfig.NetworkMode);
        if(method==='DELETE') {containers.delete(container.Id);if(network)delete network.Containers[container.Id];}
        else if(parts[2]==='json')result=container;
        else if(parts[2]==='start') {container.State={Running:true,Paused:false,Status:'running'};network.Containers[container.Id]={Name:container.Name.slice(1)};container.NetworkSettings.Networks[network.Name]={NetworkID:network.Id};}
        else if(parts[2]==='stop') {container.State={Running:false,Paused:false,Status:'exited'};delete network.Containers[container.Id];container.NetworkSettings.Networks={};}
        else if(parts[2]==='archive') {container.bootstrapArchive=body;}
        else throw new Error('Unknown engine operation.');
      }else throw new Error('Unknown engine route.');
      state.after?.(method,route,result);
      if(state.failAfter?.(method,route))throw Object.assign(new Error('lost response with private content'),{status:500});
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error:any){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({message:error.message}));}
  }).listen(socket);
  await once(server,'listening');
  return {...state,get after(){return state.after;},set after(fn){state.after=fn;},get failAfter(){return state.failAfter;},set failAfter(fn){state.failAfter=fn;},host:`unix://${socket}`,
    close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}};
}
