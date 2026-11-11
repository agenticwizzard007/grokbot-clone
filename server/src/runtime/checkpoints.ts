/** Host-only snapshot taken on a held boot, before any workload is started. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {backupEnvironment} from '../platform/backup.js';
import {openOwnedFile} from '../security/files.js';
import {backupLocation,MAX_BACKUP_BYTES,MAX_BACKUP_PARTS} from '../platform/backup-storage.js';
import type {CheckpointPlan} from '../platform/host-checkpoints.js';
import type {HostOwner} from '../platform/host-control.js';

interface Part {name:string;bytes:number;sha256:string}
interface Journal {version:1;tenant:string;machine:string;generation:string;volume:string;id:string;revision:string;backup:string;parts:Part[]}
export interface CheckpointTransport {
  plan():Promise<CheckpointPlan|null>;
  begin(plan:CheckpointPlan,journal:Journal):Promise<void>;
  put(plan:CheckpointPlan,journal:Journal,part:Part,body:fs.ReadStream):Promise<void>;
  finishBackup(plan:CheckpointPlan,journal:Journal):Promise<void>;
  complete(plan:CheckpointPlan):Promise<{backup:string;receipt:string}>;
}
function durable(file:string,value:unknown){
  const fd=fs.openSync(`${file}.new`,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(`${file}.new`,file);const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
export class HostCheckpoint {
  private busy=false;
  constructor(private root:string,private journalRoot:string,private owner:HostOwner&{volume:string},private key:()=>Buffer,private transport:CheckpointTransport,private verifyHeld:(plan:CheckpointPlan)=>Promise<void>){
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
    const info=fs.lstatSync(journalRoot);
    if(fs.realpathSync(journalRoot)!==journalRoot||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('Checkpoint workspace is not private.');
  }
  private validPlan(plan:CheckpointPlan){
    backupLocation(this.owner.tenant,plan.id);
    if(plan.tenant!==this.owner.tenant||plan.machine!==this.owner.machine||plan.generation!==this.owner.generation||plan.volume!==this.owner.volume
      ||!/^[1-9]\d*$/.test(plan.revision)||!['pending','uploading','complete'].includes(plan.state))throw new Error('Checkpoint plan identity mismatch.');
  }
  async tick(){
    if(this.busy)throw new Error('Checkpoint already running.');this.busy=true;
    try{
      const plan=await this.transport.plan();if(!plan)return null;this.validPlan(plan);await this.verifyHeld(plan);
      const authorize=async()=>{
        const current=await this.transport.plan();
        if(!current)throw new Error('Checkpoint revoked.');this.validPlan(current);
        if(current.id!==plan.id||current.revision!==plan.revision)throw new Error('Checkpoint changed.');
        await this.verifyHeld(current);return current;
      };
      const directory=path.join(this.journalRoot,plan.id);
      if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
      if(fs.realpathSync(directory)!==directory||fs.lstatSync(directory).isSymbolicLink())throw new Error('Checkpoint journal redirected.');
      const file=path.join(directory,'journal.json'),bundle=path.join(directory,'encrypted');let journal:Journal;
      if(fs.existsSync(file)){
        const fd=openOwnedFile(directory,'journal.json');try{if(fs.fstatSync(fd).size>32*1024*1024)throw new Error('Checkpoint inventory exceeded.');journal=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
      }else{
        if(plan.backup)throw new Error('Admitted checkpoint journal is missing.');
        // Only this root-only, generation-bound request may discard its own
        // unfinished local snapshot. No plaintext user files are staged here.
        const binding={tenant:plan.tenant,machine:plan.machine,generation:plan.generation,volume:plan.volume,id:plan.id,revision:plan.revision};
        const bindingFile=path.join(directory,'binding.json');
        if(fs.existsSync(bindingFile)){
          const fd=openOwnedFile(directory,'binding.json');try{if(fs.fstatSync(fd).size>4096||JSON.stringify(JSON.parse(fs.readFileSync(fd,'utf8')))!==JSON.stringify(binding))throw new Error('Foreign checkpoint workspace.');}finally{fs.closeSync(fd);}
        }else{if(fs.readdirSync(directory).length)throw new Error('Unbound checkpoint workspace.');durable(bindingFile,binding);}
        fs.rmSync(bundle,{recursive:true,force:true});
        for(const name of fs.readdirSync(directory))if(/^\.snapshot-[A-Za-z0-9]{6}$/.test(name))fs.rmSync(path.join(directory,name),{recursive:true,force:true});
        await authorize();const master=this.key();let snapshot;
        try{snapshot=await backupEnvironment(this.root,bundle,plan.tenant,master,'environment');}finally{master.fill(0);}
        const parts:Part[]=[];
        for(const name of fs.readdirSync(bundle).sort()){
          backupLocation(plan.tenant,snapshot.id,name);const fd=openOwnedFile(bundle,name),info=fs.fstatSync(fd),hash=createHash('sha256');let bytes=0;
          try{for await(const chunk of fs.createReadStream('',{fd,autoClose:false})){bytes+=chunk.length;if(bytes>MAX_BACKUP_BYTES)throw new Error('Checkpoint part exceeded.');hash.update(chunk);}fs.fsyncSync(fd);}
          finally{fs.closeSync(fd);}
          if(info.size!==bytes)throw new Error('Checkpoint part changed.');parts.push({name,bytes,sha256:hash.digest('hex')});
        }
        journal={version:1,...binding,backup:snapshot.id,parts};await authorize();durable(file,journal);
      }
      if(journal.version!==1||journal.tenant!==plan.tenant||journal.machine!==plan.machine||journal.generation!==plan.generation||journal.volume!==plan.volume
        ||journal.id!==plan.id||journal.revision!==plan.revision||!Array.isArray(journal.parts)||journal.parts.length<2||journal.parts.length>MAX_BACKUP_PARTS
        ||plan.backup&&plan.backup!==journal.backup)throw new Error('Checkpoint journal identity mismatch.');
      backupLocation(plan.tenant,journal.backup);let total=0;const names=new Set<string>();
      for(const part of journal.parts){backupLocation(plan.tenant,journal.backup,part.name);if(names.has(part.name)||!Number.isSafeInteger(part.bytes)||part.bytes<0||!/^[a-f0-9]{64}$/.test(part.sha256))throw new Error('Invalid checkpoint part.');names.add(part.name);total+=part.bytes;}
      if(total<1||total>MAX_BACKUP_BYTES||!names.has('manifest.bin'))throw new Error('Checkpoint inventory exceeded.');
      await authorize();await this.transport.begin(plan,journal);
      for(const part of journal.parts){
        await authorize();const fd=openOwnedFile(bundle,part.name),body=fs.createReadStream('',{fd,autoClose:true});
        try{await this.transport.put(plan,journal,part,body);}finally{body.destroy();}
      }
      await authorize();await this.transport.finishBackup(plan,journal);
      await authorize();const receipt=await this.transport.complete(plan);
      if(receipt.backup!==journal.backup||!/^[a-f0-9]{64}$/.test(receipt.receipt))throw new Error('Checkpoint completion identity mismatch.');
      return {id:plan.id,...receipt};
    }finally{this.busy=false;}
  }
}
export function hostCheckpointTransport(origin:string,tokenFile:string):CheckpointTransport{
  const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||!tokenFile.startsWith('/run/swarm-host/'))throw new Error('Invalid checkpoint transport.');
  async function request(route:string,method='GET',body?:BodyInit,headers:Record<string,string>={}){
    const token=fs.readFileSync(tokenFile,'utf8').trim();
    const response=await fetch(new URL(route,url),{method,redirect:'error',signal:AbortSignal.timeout(125000),headers:{authorization:`Bearer ${token}`,...headers},body,duplex:'half'} as RequestInit);
    if(!response.ok){await response.body?.cancel();throw new Error('Checkpoint transport requires retry.');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing checkpoint response.');let bytes=0;const chunks:Uint8Array[]=[];
    try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>16384)throw new Error('Checkpoint response exceeded.');chunks.push(next.value);}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return {
    plan:async()=>(await request('/internal/host/checkpoints')).checkpoint,
    begin:async(p,j)=>{await request(`/internal/host/checkpoints/${p.id}`,'POST',JSON.stringify({backup:j.backup,parts:j.parts.length,bytes:j.parts.reduce((n,v)=>n+v.bytes,0)}),{'content-type':'application/json'});},
    put:async(_p,j,part,body)=>{await request(`/internal/host/backups/${j.backup}/${part.name}`,'PUT',body as any,{'content-type':'application/octet-stream','content-length':String(part.bytes),'x-backup-sha256':part.sha256});},
    finishBackup:async(_p,j)=>{await request(`/internal/host/backups/${j.backup}/complete`,'POST');},
    complete:p=>request(`/internal/host/checkpoints/${p.id}/complete`,'POST'),
  };
}
