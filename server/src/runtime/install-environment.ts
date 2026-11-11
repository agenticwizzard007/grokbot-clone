import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {restoreEnvironment} from '../platform/backup.js';
import {backupLocation,MAX_BACKUP_BYTES,MAX_BACKUP_PARTS} from '../platform/backup-storage.js';
import {installReceipt,type InstallPlan,type InstallPart} from '../platform/host-installations.js';
import type {RuntimeBinding} from './refresh-state.js';
export interface InstallTransport {
  plan():Promise<InstallPlan|null>;
  parts(plan:InstallPlan,backup:string,after?:string):Promise<{parts:InstallPart[];count:number;bytes:number;next:string|null}>;
  part(plan:InstallPlan,backup:string,part:InstallPart):Promise<Readable>;
  complete(plan:InstallPlan,receipt:string):Promise<void>;
}
export function hostInstallTransport(origin:string,tokenFile:string,request=fetch):InstallTransport {
  const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||!tokenFile.startsWith('/run/swarm-host/'))throw new Error('Invalid installation transport.');
  async function call(suffix:string,body?:unknown){
    const token=fs.readFileSync(tokenFile,'utf8').trim();
    const response=await request(new URL(`/internal/host/installations${suffix}`,origin),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(125000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error('Installation transport unavailable.');}return response;
  }
  async function json(suffix:string,body?:unknown){
    const response=await call(suffix,body),reader=response.body!.getReader(),chunks:Uint8Array[]=[];let count=0;
    try{for(;;){const next=await reader.read();if(next.done)break;count+=next.value.length;if(count>256*1024)throw new Error('Installation inventory too large.');chunks.push(next.value);}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return {
    plan:async()=>(await json('')).installation,
    parts:(plan,backup,after)=>json(`/${plan.id}/${backup}${after?`?after=${encodeURIComponent(after)}`:''}`),
    part:async(plan,backup,part)=>{const response=await call(`/${plan.id}/${backup}/${part.name}`);if(response.headers.get('content-length')!==String(part.bytes)||response.headers.get('x-backup-sha256')!==part.sha256){await response.body?.cancel();throw new Error('Installation part identity changed.');}return Readable.fromWeb(response.body as any);},
    complete:async(plan,receipt)=>{await json(`/${plan.id}/complete`,{receipt});},
  };
}
function durableFile(file:string,value:unknown){
  const temp=`${file}.${randomBytes(8).toString('hex')}.new`,fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);syncDirectory(path.dirname(file));
}
function syncDirectory(directory:string){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncTree(directory:string){for(const entry of fs.readdirSync(directory)){const file=path.join(directory,entry),info=fs.lstatSync(file);if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw new Error('Unsafe restored entry.');if(info.isDirectory())syncTree(file);else{const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}syncDirectory(directory);}

/** Runs only before workload startup. Publishes a complete, owner-verified
 * directory and durable pointer before acknowledging activation to the platform. */
export class HostInstaller {
  constructor(private root:string,private binding:RuntimeBinding,private key:()=>Buffer,private transport:InstallTransport){
    if(!path.isAbsolute(root)||fs.realpathSync(root)!==root)throw new Error('Unsafe installation root.');
  }
  private validate(plan:InstallPlan,currentRuntime=true){
    if(!plan||plan.tenant!==this.binding.tenant||currentRuntime&&(plan.machine!==this.binding.machine||plan.generation!==this.binding.generation)||plan.volume!==this.binding.volume||!['pending','installed'].includes(plan.state))throw new Error('Installation owner changed.');
    backupLocation(plan.tenant,plan.id);backupLocation(plan.tenant,plan.fullBackup);if(plan.databaseBackup)backupLocation(plan.tenant,plan.databaseBackup);
  }
  private published(plan:InstallPlan){
    const directory=path.join(this.root,'environments',plan.id);
    if(fs.realpathSync(directory)!==directory)throw new Error('Unsafe installed environment.');
    const receipt=JSON.parse(fs.readFileSync(path.join(directory,'installation-receipt.json'),'utf8'));
    if(receipt.hash!==installReceipt(plan))throw new Error('Installed environment receipt mismatch.');
    return directory;
  }
  activeRoot(){
    const file=path.join(this.root,'active-environment.json');if(!fs.existsSync(file))return this.root;
    if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>4096)throw new Error('Unsafe environment pointer.');
    // An image update reuses the same owned volume with a fresh runtime identity.
    // The root-only data pointer keeps its original installation receipt; it is
    // storage authority only, never a reusable machine credential.
    const pointer=JSON.parse(fs.readFileSync(file,'utf8'));this.validate(pointer,false);return this.published(pointer);
  }
  private async download(plan:InstallPlan,backup:string,bundle:string){
    fs.mkdirSync(bundle,{mode:0o700});let after:string|undefined,count=0,total=0,expectedCount:number|undefined,expectedBytes:number|undefined;
    const seen=new Set<string>();
    do{
      const page=await this.transport.parts(plan,backup,after);
      if(!Array.isArray(page.parts)||page.parts.length>500||!Number.isSafeInteger(page.count)||page.count<2||page.count>MAX_BACKUP_PARTS||!Number.isSafeInteger(page.bytes)||page.bytes<1||page.bytes>MAX_BACKUP_BYTES||expectedCount!==undefined&&page.count!==expectedCount||expectedBytes!==undefined&&page.bytes!==expectedBytes)throw new Error('Invalid installation inventory.');
      expectedCount=page.count;expectedBytes=page.bytes;
      for(const part of page.parts){
        backupLocation(plan.tenant,backup,part.name);
        if(seen.has(part.name)||after&&part.name<=after||!Number.isSafeInteger(part.bytes)||part.bytes<0||!/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('Invalid installation part.');
        seen.add(part.name);count++;total+=part.bytes;
        if(count>page.count||total>page.bytes||part.name==='manifest.bin'&&part.bytes>32*1024*1024)throw new Error('Installation inventory exceeded.');
        let bytes=0;const hash=createHash('sha256'),meter=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>part.bytes){done(new Error('Installation part exceeded.'));return;}hash.update(chunk);done(null,chunk);}});
        await pipeline(await this.transport.part(plan,backup,part),meter,fs.createWriteStream(path.join(bundle,part.name),{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(125000)});
        if(bytes!==part.bytes||hash.digest('hex')!==part.sha256)throw new Error('Installation part integrity mismatch.');
      }
      if(page.next!==null&&(page.parts.length===0||page.next!==page.parts.at(-1)!.name||after!==undefined&&page.next<=after))throw new Error('Installation pagination did not advance.');
      after=page.next??undefined;
    }while(after);
    if(count!==expectedCount||total!==expectedBytes||!seen.has('manifest.bin'))throw new Error('Incomplete installation inventory.');
  }
  async tick(){
    const plan=await this.transport.plan();if(!plan)return;
    this.validate(plan);
    const parent=path.join(this.root,'environments');fs.mkdirSync(parent,{recursive:true,mode:0o700});if(fs.realpathSync(parent)!==parent)throw new Error('Unsafe installation parent.');
    const destination=path.join(parent,plan.id),work=path.join(parent,`.install-${plan.id}`);
    if(!fs.existsSync(destination)){
      // Never overwrite a previous live environment. An interrupted unpublished
      // restore is discarded; encrypted source objects remain immutable.
      if(plan.state==='installed')throw new Error('Acknowledged environment is missing.');
      fs.rmSync(work,{recursive:true,force:true});fs.mkdirSync(work,{mode:0o700});const master=this.key();
      try{
        const fullBundle=path.join(work,'full');await this.download(plan,plan.fullBackup,fullBundle);
        const restored=path.join(work,'restored'),full=await restoreEnvironment(fullBundle,restored,plan.tenant,plan.fullBackup,plan.volume,master);
        if(full.scope!=='environment')throw new Error('Invalid full installation backup.');
        if(plan.databaseBackup){
          const dbBundle=path.join(work,'database');await this.download(plan,plan.databaseBackup,dbBundle);
          const dbRoot=path.join(work,'database-restored'),database=await restoreEnvironment(dbBundle,dbRoot,plan.tenant,plan.databaseBackup,plan.volume,master);
          if(database.scope!=='database'||!Number.isFinite(Date.parse(database.createdAt))||Date.parse(database.createdAt)<Date.parse(full.createdAt))throw new Error('Invalid database installation checkpoint.');
          fs.copyFileSync(path.join(dbRoot,'app/swarm.db'),path.join(restored,'app/swarm.db'));
        }
        const current=await this.transport.plan();if(!current||installReceipt(current)!==installReceipt(plan))throw new Error('Installation authorization changed.');this.validate(current);
        durableFile(path.join(restored,'installation-receipt.json'),{hash:installReceipt(plan)});syncTree(restored);
        fs.renameSync(restored,destination);syncDirectory(parent);
      }finally{master.fill(0);fs.rmSync(work,{recursive:true,force:true});}
    }
    this.published(plan);
    const current=await this.transport.plan();if(!current||installReceipt(current)!==installReceipt(plan))throw new Error('Installation authorization changed.');this.validate(current);
    durableFile(path.join(this.root,'active-environment.json'),plan);
    await this.transport.complete(plan,installReceipt(plan));
  }
}
