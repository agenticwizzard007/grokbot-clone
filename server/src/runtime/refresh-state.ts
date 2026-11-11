import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

export interface RuntimeBinding {tenant:string;machine:string;volume:string;generation:string}
interface RefreshState extends RuntimeBinding {version:1;current:string;pending?:string;bootstrapHash?:string}
export interface PendingRefresh extends RefreshState {pending:string}
const bearer=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sameBinding=(a:RuntimeBinding,b:RuntimeBinding)=>a.tenant===b.tenant&&a.machine===b.machine&&a.volume===b.volume&&a.generation===b.generation;

/** Root-only journal. Both sides of an exchange reach durable storage before
 * dispatch. The bootstrap digest survives consumption and config-file replay. */
export class RuntimeRefreshStore {
  constructor(private file:string,private binding:RuntimeBinding){
    if(!path.isAbsolute(file)||fs.realpathSync(path.dirname(file))!==path.dirname(file))throw new Error('Unsafe runtime credential directory.');
    if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(binding.tenant)||!binding.machine||!binding.volume||!/^[1-9]\d*$/.test(binding.generation))throw new Error('Invalid runtime binding.');
  }
  private read():RefreshState|undefined {
    let fd:number;
    try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error:any){if(error.code==='ENOENT')return;throw error;}
    try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>4096||(stat.mode&0o077)!==0)throw new Error('Unsafe runtime credential file.');
      const state=JSON.parse(fs.readFileSync(fd,'utf8'));
      if(state.version!==1||!bearer(state.current)||state.pending!==undefined&&!bearer(state.pending)
        ||state.bootstrapHash!==undefined&&!/^[a-f0-9]{64}$/.test(state.bootstrapHash))throw new Error('Runtime credential state requires rebootstrap.');
      return state;
    }finally{fs.closeSync(fd);}
  }
  private write(state:RefreshState){
    const temporary=`${this.file}.${randomBytes(12).toString('hex')}.new`;
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(temporary,this.file);const directory=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
    finally{fs.rmSync(temporary,{force:true});}
  }
  prepare(bootstrap?:string):PendingRefresh {
    if(bootstrap!==undefined&&!bearer(bootstrap))throw new Error('Invalid bootstrap credential.');
    const saved=this.read(),bootstrapHash=bootstrap===undefined?undefined:hash(bootstrap);
    let state:RefreshState;
    if(saved&&sameBinding(saved,this.binding)&&(!bootstrap||saved.bootstrapHash===bootstrapHash))state=saved;
    else {
      // A copied volume never carries its previous machine's bearer into an
      // exchange. A consumed bootstrap cannot be repurposed for a new owner.
      if(!bootstrap||saved?.bootstrapHash===bootstrapHash)throw new Error('Fresh runtime bootstrap required.');
      state={version:1,...this.binding,current:bootstrap,bootstrapHash};
    }
    const pending={...state,pending:state.pending??randomBytes(32).toString('base64url')};
    this.write(pending);return pending;
  }
  commit(attempt:PendingRefresh,successor:string){
    const saved=this.read();
    if(!saved||!sameBinding(attempt,this.binding)||!sameBinding(saved,this.binding)||saved.current!==attempt.current
      ||saved.pending!==attempt.pending||saved.bootstrapHash!==attempt.bootstrapHash||successor!==attempt.pending)throw new Error('Runtime refresh completion changed.');
    const {pending:_,...next}=saved;this.write({...next,current:successor});
  }
}
