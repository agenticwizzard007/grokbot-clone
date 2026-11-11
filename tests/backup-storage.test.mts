import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3BackupStorage } from '../server/src/platform/backup-storage.js';
import {Readable} from 'node:stream';

test('S3 reads preserve empty encrypted file parts and reject missing/negative sizes',async()=>{
  for(const bytes of [0,undefined,-1,0.5]){
    const body=Readable.from([]),storage=new S3BackupStorage('test-bucket','swarm-backups',{send:async()=>({Body:body,ContentLength:bytes})} as any);
    if(bytes===0){const part=await storage.get('usr_owner123','0123456789abcdef0123456789abcdef','1.bin');assert.equal(part.bytes,0);part.body.destroy();}
    else{await assert.rejects(storage.get('usr_owner123','0123456789abcdef0123456789abcdef','1.bin'),/Invalid backup object/);assert.equal(body.destroyed,true);}
  }
});

test('S3 cleanup removes every owner version, delete marker and abandoned multipart upload',async()=>{
  const prefix='swarm-backups/usr_owner123/0123456789abcdef0123456789abcdef/',calls:any[]=[];
  let pages=0;
  const client={send:async(command:any)=>{
    calls.push({kind:command.constructor.name,input:command.input});
    if(command.constructor.name==='ListObjectVersionsCommand')return pages++===0?{Versions:[{Key:`${prefix}0.bin`,VersionId:'old'},{Key:`${prefix}0.bin`,VersionId:'new'}],IsTruncated:true,NextKeyMarker:`${prefix}0.bin`,NextVersionIdMarker:'new'}:{DeleteMarkers:[{Key:`${prefix}manifest.bin`,VersionId:'marker'}],Versions:[{Key:`${prefix}manifest.bin`,VersionId:'null'}]};
    if(command.constructor.name==='ListMultipartUploadsCommand')return {Uploads:[{Key:`${prefix}1.bin`,UploadId:'pending'}]};
    return {};
  }};
  await new S3BackupStorage('test-bucket','swarm-backups',client as any).remove('usr_owner123','0123456789abcdef0123456789abcdef');
  assert.deepEqual(calls.filter(c=>c.kind==='DeleteObjectsCommand').flatMap(c=>c.input.Delete.Objects.map((v:any)=>v.VersionId)),['old','new','null','marker']);
  assert.equal(calls.find(c=>c.kind==='AbortMultipartUploadCommand').input.UploadId,'pending');
  assert.ok(calls.every(c=>!c.input.Prefix||c.input.Prefix===prefix));
});
test('S3 foreign versions and repeated pagination markers fail cleanup without deleting foreign data',async()=>{
  for(const mode of ['foreign','marker','delete-error']){
    let deleted=0;
    const client={send:async(command:any)=>{
      if(command.constructor.name==='DeleteObjectsCommand'){deleted++;return mode==='delete-error'?{Errors:[{Code:'Denied'}]}:{};}
      if(command.constructor.name==='ListObjectVersionsCommand')return mode==='foreign'?{Versions:[{Key:'foreign/0.bin',VersionId:'1'}]}:mode==='marker'?{IsTruncated:true,NextKeyMarker:'repeat',NextVersionIdMarker:'1'}:{Versions:[{Key:'swarm-backups/usr_owner123/0123456789abcdef0123456789abcdef/0.bin',VersionId:'1'}]};
      return {};
    }};
    await assert.rejects(new S3BackupStorage('test-bucket','swarm-backups',client as any).remove('usr_owner123','0123456789abcdef0123456789abcdef'));
    if(mode==='foreign')assert.equal(deleted,0);
  }
});
