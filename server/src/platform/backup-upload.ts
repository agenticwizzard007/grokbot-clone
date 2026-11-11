import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {finished} from 'node:stream/promises';
import type {BackupStorage} from './backup-storage.js';

/** The catalog verifies consumption itself; a storage acknowledgement alone is
 * insufficient. The two-minute dispatch deadline is shorter than its part lease. */
export async function checkedBackupUpload(storage:BackupStorage,tenant:string,id:string,part:{name:string;bytes:number;sha256:string},body:Readable,authorize:()=>Promise<void>,kind:'backup'|'migration'='backup'){
  const checksum=createHash('sha256');let bytes=0,checked=Date.now(),verified=false;
  const meter=new Transform({transform(chunk,_encoding,done){
    bytes+=chunk.length;if(bytes>part.bytes)return done(new Error('Backup part exceeded.'));checksum.update(chunk);
    if(Date.now()-checked>1000){checked=Date.now();void authorize().then(()=>done(null,chunk),error=>done(error instanceof Error?error:new Error('Backup upload revoked.')));}
    else done(null,chunk);
  },flush(done){verified=bytes===part.bytes&&checksum.digest('hex')===part.sha256;done(verified?undefined:new Error('Backup part integrity failed.'));}});
  const completion=finished(meter);void completion.catch(()=>{});
  let rejectFailure!:(error:Error)=>void;
  const failure=new Promise<never>((_resolve,reject)=>{rejectFailure=reject;});void failure.catch(()=>{});
  meter.once('error',rejectFailure);body.on('error',error=>meter.destroy(error));const stream=body.pipe(meter);
  const timer=setTimeout(()=>{const error=new Error('Backup upload deadline exceeded.');rejectFailure(error);body.destroy(error);meter.destroy(error);},120000).unref();
  try{await Promise.race([storage.put(tenant,id,part.name,stream,part.bytes,part.sha256),failure]);if(!verified)throw new Error(`Storage did not consume the complete ${kind} part.`);await completion;}
  finally{clearTimeout(timer);body.destroy();meter.destroy();meter.off('error',rejectFailure);}
}
