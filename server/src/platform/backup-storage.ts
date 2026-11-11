import { S3Client, DeleteObjectsCommand, ListObjectVersionsCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, Transform } from 'node:stream';
import { createHash } from 'node:crypto';

export const MAX_BACKUP_BYTES=13*1024**3;
export const MAX_BACKUP_PARTS=100001;
export function backupLocation(tenant:string,id:string,name?:string){
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant)||!/^([a-f0-9]{32})$/.test(id)|| (name!==undefined&&!/^(manifest|\d{1,6})\.bin$/.test(name)))throw new Error('Invalid backup location.');
  return `${tenant}/${id}/${name??''}`;
}
export interface BackupStorage {
  put(tenant:string,id:string,name:string,body:Readable,bytes:number,sha256:string):Promise<void>;
  get(tenant:string,id:string,name:string):Promise<{body:Readable;bytes:number}>;
  remove(tenant:string,id:string):Promise<void>;
}
/** Only the trusted platform owns S3 credentials. Every key has an immutable tenant prefix. */
export class S3BackupStorage implements BackupStorage {
  constructor(private bucket=process.env.BACKUP_BUCKET!,private prefix=process.env.BACKUP_PREFIX??'swarm-backups',private client=new S3Client({})){
    if(!bucket||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||! /^[A-Za-z0-9_-]{1,80}$/.test(prefix))throw new Error('Scoped backup bucket configuration is required.');
  }
  private key(tenant:string,id:string,name?:string){return `${this.prefix}/${backupLocation(tenant,id,name)}`;}
  async put(tenant:string,id:string,name:string,body:Readable,bytes:number,sha256:string){
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_BACKUP_BYTES||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid backup part.');
    const hash=createHash('sha256');let count=0;
    const meter=new Transform({transform(chunk,_encoding,callback){count+=chunk.length;if(count>bytes)return callback(new Error('Backup byte limit exceeded.'));hash.update(chunk);callback(null,chunk);}});
    const stream=body.pipe(meter);
    body.on('error',error=>meter.destroy(error));
    const upload=new Upload({client:this.client,params:{Bucket:this.bucket,Key:this.key(tenant,id,name),Body:stream,ContentLength:bytes,ContentType:'application/octet-stream',ServerSideEncryption:'AES256',Metadata:{sha256}},partSize:8*1024*1024,queueSize:1,leavePartsOnError:false});
    const timeout=setTimeout(()=>{body.destroy(new Error('Backup upload timed out.'));void upload.abort().catch(()=>{});},120000).unref();
    try{await upload.done();if(count!==bytes||hash.digest('hex')!==sha256)throw new Error('Backup checksum mismatch.');}
    catch(error){await upload.abort().catch(()=>{});throw error;}
    finally{clearTimeout(timeout);body.destroy();meter.destroy();}
  }
  async get(tenant:string,id:string,name:string){
    const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:this.key(tenant,id,name)}),{abortSignal:AbortSignal.timeout(120000)});
    if(!(result.Body instanceof Readable)||typeof result.ContentLength!=='number'||!Number.isSafeInteger(result.ContentLength)||result.ContentLength<0||result.ContentLength>MAX_BACKUP_BYTES){(result.Body as Readable|undefined)?.destroy?.();throw new Error('Invalid backup object.');}
    return {body:result.Body,bytes:result.ContentLength};
  }
  async remove(tenant:string,id:string){
    const Prefix=this.key(tenant,id);let versionKey:string|undefined,versionId:string|undefined;
    do{
      // Delete historical versions and delete markers too. Deleting only the
      // current key leaves recoverable credentials behind in versioned buckets.
      const page=await this.client.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix,KeyMarker:versionKey,VersionIdMarker:versionId,MaxKeys:1000}));
      const keys=[...(page.Versions??[]),...(page.DeleteMarkers??[])].map(o=>({Key:o.Key!,VersionId:o.VersionId}));
      if(keys.some(o=>!o.Key?.startsWith(Prefix)||!o.VersionId))throw new Error('Foreign or unidentified backup version returned.');
      if(keys.length){const deleted=await this.client.send(new DeleteObjectsCommand({Bucket:this.bucket,Delete:{Objects:keys,Quiet:true}}));if(deleted.Errors?.length)throw new Error('Backup deletion requires retry.');}
      if(page.IsTruncated&&(!page.NextKeyMarker||(versionKey===page.NextKeyMarker&&versionId===page.NextVersionIdMarker)))throw new Error('Incomplete storage listing.');
      versionKey=page.IsTruncated?page.NextKeyMarker:undefined;versionId=page.NextVersionIdMarker;
    }while(versionKey);
    // A crashed uploader can leave multipart state that ordinary object listing cannot see.
    let keyMarker:string|undefined,uploadMarker:string|undefined;
    do{
      const page=await this.client.send(new ListMultipartUploadsCommand({Bucket:this.bucket,Prefix,KeyMarker:keyMarker,UploadIdMarker:uploadMarker,MaxUploads:1000}));
      for(const upload of page.Uploads??[]){if(!upload.Key?.startsWith(Prefix)||!upload.UploadId)throw new Error('Foreign upload returned.');await this.client.send(new AbortMultipartUploadCommand({Bucket:this.bucket,Key:upload.Key,UploadId:upload.UploadId}));}
      keyMarker=page.IsTruncated?page.NextKeyMarker:undefined;uploadMarker=page.NextUploadIdMarker;
      if(page.IsTruncated&&!keyMarker)throw new Error('Incomplete multipart listing.');
    }while(keyMarker);
  }
}
