import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { backupEnvironment } from '../platform/backup.js';

interface Pending { id:string;directory:string;scope:'database'|'environment';parts:{name:string;bytes:number;sha256:string}[] }
interface Journal { tenant:string;lastDatabase?:number;lastEnvironment?:number;pending?:Pending;error?:string;attemptedAt?:number }
export interface BackupTransport {
  begin(pending:Pending):Promise<void>;
  put(pending:Pending,part:Pending['parts'][number]):Promise<void>;
  complete(pending:Pending):Promise<void>;
  report?(status:{lastDatabase?:number;lastEnvironment?:number;pending?:string;error?:string}):Promise<void>;
}
export function hostBackupTransport(tokenFile:string,origin:string):BackupTransport {
  const endpoint=new URL('/internal/host/backups',origin);if(endpoint.protocol!=='https:')throw new Error('Backup transport requires TLS.');
  async function request(suffix:string,method:string,body:BodyInit|undefined,extra:Record<string,string>={}){
    const token=fs.readFileSync(tokenFile,'utf8').trim();
    const response=await fetch(`${endpoint.href}${suffix}`,{method,redirect:'error',signal:AbortSignal.timeout(125000),headers:{authorization:`Bearer ${token}`,...extra},body,duplex:'half'} as RequestInit);
    await response.body?.cancel();if(!response.ok)throw new Error('Backup transport requires retry.');
  }
  return {
    begin:p=>request('','POST',JSON.stringify({id:p.id,scope:p.scope,parts:p.parts.length,bytes:p.parts.reduce((n,f)=>n+f.bytes,0)}),{'content-type':'application/json'}),
    put:(p,f)=>request(`/${p.id}/${f.name}`,'PUT',fs.createReadStream(path.join(p.directory,f.name)) as any,{'content-type':'application/octet-stream','content-length':String(f.bytes),'x-backup-sha256':f.sha256}),
    complete:p=>request(`/${p.id}/complete`,'POST',undefined),
    report:status=>request('/status','POST',JSON.stringify(status),{'content-type':'application/json'}),
  };
}
/** Host-only durable schedule; workloads never receive this journal, transport token or backup directory. */
export class HostBackups {
  private busy=false;
  private journal:Journal;
  private directory:string;
  constructor(private root:string,private tenant:string,private key:()=>Buffer,private transport:BackupTransport,private quiesce:()=>Promise<()=>Promise<void>>,private clock=Date.now){
    this.directory=path.join(root,'host-backups');fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    if(fs.realpathSync(this.directory)!==this.directory||fs.lstatSync(this.directory).isSymbolicLink())throw new Error('Unsafe backup workspace.');
    const journalFile=path.join(this.directory,'journal.json');
    this.journal=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile,'utf8')):{tenant};
    if(this.journal.tenant!==tenant)throw new Error('Backup journal owner mismatch.');
    if(this.journal.pending){const p=this.journal.pending;if(!/^[a-f0-9]{32}$/.test(p.id)||path.dirname(p.directory)!==this.directory||fs.realpathSync(p.directory)!==p.directory||!Array.isArray(p.parts)||p.parts.some(f=>! /^(manifest|\d{1,6})\.bin$/.test(f.name)))throw new Error('Invalid pending backup.');}
    // Only this host writes here. A crash before journaling or after upload may
    // leave a bundle behind; never remove the journal's resumable upload.
    this.removeOrphans();
  }
  private removeOrphans(){
    for(const name of fs.readdirSync(this.directory)){
      const candidate=path.join(this.directory,name);
      if(!/^[a-f0-9]{32}$/.test(name)||candidate===this.journal.pending?.directory)continue;
      if(fs.lstatSync(candidate).isSymbolicLink())throw new Error('Unsafe backup workspace entry.');
      fs.rmSync(candidate,{recursive:true,force:true});
    }
  }
  private save(){const file=path.join(this.directory,'journal.json'),fd=fs.openSync(`${file}.new`,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.journal));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(`${file}.new`,file);const dir=fs.openSync(this.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  status(){return {lastDatabase:this.journal.lastDatabase,lastEnvironment:this.journal.lastEnvironment,error:this.journal.error,pending:this.journal.pending?.id};}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      this.removeOrphans();
      const time=this.clock();
      if(!this.journal.pending){
        const scope=!this.journal.lastEnvironment||time-this.journal.lastEnvironment>=23*3600000?'environment':!this.journal.lastDatabase||time-this.journal.lastDatabase>=4*60000?'database':null;
        if(!scope)return;
        this.journal.attemptedAt=time;this.save();
        const output=path.join(this.directory,randomBytes(16).toString('hex'));
        let resume:(()=>Promise<void>)|undefined;
        const master=this.key();
        let result;
        try{if(scope==='environment')resume=await this.quiesce();result=await backupEnvironment(this.root,output,this.tenant,master,scope);}
        finally{master.fill(0);await resume?.();}
        const parts:Pending['parts']=[];
        for(const name of fs.readdirSync(output)){
          if(!/^(manifest|\d{1,6})\.bin$/.test(name))throw new Error('Unexpected backup file.');
          const file=path.join(output,name),sha=createHash('sha256');
          for await (const chunk of fs.createReadStream(file))sha.update(chunk);
          parts.push({name,bytes:fs.statSync(file).size,sha256:sha.digest('hex')});
        }
        this.journal.pending={id:result.id,directory:output,scope,parts};this.save();
      }
      const pending=this.journal.pending!;
      await this.transport.begin(pending);
      for(const part of pending.parts)await this.transport.put(pending,part);
      await this.transport.complete(pending);
      // Cadence is measured from the snapshot, not from the end of an arbitrarily slow upload.
      this.journal.lastDatabase=this.journal.attemptedAt;
      if(pending.scope==='environment')this.journal.lastEnvironment=this.journal.attemptedAt;
      delete this.journal.pending;delete this.journal.error;this.save();
      fs.rmSync(pending.directory,{recursive:true,force:true});
    }catch{this.journal.error='backup_requires_retry';this.save();}
    finally{try{await this.transport.report?.(this.status());}catch{/* The next tick retries metadata reporting. */}this.busy=false;}
  }
}
