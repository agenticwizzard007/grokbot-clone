import fs from 'node:fs';
import path from 'node:path';
import { createHash,hkdfSync,randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { exportTenantDatabase } from './migration.js';
import { openSecret,sealSecret } from '../security/secret-envelope.js';
import { inventoryLegacySource,openInventoryPath,type LegacyInventoryInput } from './migration-inventory.js';

interface Reconnect { kind:string;id:string;reason:'ownership_requires_reconnection' }
const table=(db:Database.Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function cryptKey(secret:string,tenant:string){return Buffer.from(hkdfSync('sha256',secret,tenant,'swarm-private-secrets-v1',32));}
const seal=sealSecret;
const open=(key:Buffer,tenant:string,purpose:string,value:string)=>openSecret<any>(key,tenant,purpose,value);
/** Only cryptographically owner-bound secrets are rewrapped. Shared v1 credentials require reconnection. */
export function rewrapTenantCredentials(database:string,tenant:string,sourceSessionSecret:string,targetKey:Buffer){
  if(targetKey.length!==32||!sourceSessionSecret)throw new Error('Migration encryption keys required.');
  const sourceKey=cryptKey(sourceSessionSecret,tenant),destinationKey=Buffer.from(targetKey);
  try{return rewrapCredentials(database,tenant,sourceKey,destinationKey,false);}
  finally{sourceKey.fill(0);destinationKey.fill(0);}
}
/** Prepare ONLY an isolated, owner-verified rollback snapshot. This never merges
 * into a live shared DB or grants source resume permission. Invalid target
 * credentials roll back the entire transaction rather than silently deleting
 * them. The qualified source image must support owner-bound private1 envelopes. */
export function rewrapLegacyRollbackCredentials(database:string,tenant:string,targetKey:Buffer,legacySessionSecret:string){
  if(targetKey.length!==32||!legacySessionSecret)throw new Error('Migration encryption keys required.');
  const sourceKey=Buffer.from(targetKey),destinationKey=cryptKey(legacySessionSecret,tenant);
  try{
    rewrapCredentials(database,tenant,sourceKey,destinationKey,true);
    return {tenant,requiresReconciledImport:true as const,routingChanged:false as const};
  }finally{sourceKey.fill(0);destinationKey.fill(0);}
}
function rewrapCredentials(database:string,tenant:string,sourceKey:Buffer,destinationKey:Buffer,rollback:boolean){
  const db=new Database(database,{fileMustExist:true}),reconnect:Reconnect[]=[];
  const missing=(kind:string,id:string)=>{if(rollback)throw new Error('Rollback credential ownership or integrity requires reconciliation.');reconnect.push({kind,id,reason:'ownership_requires_reconnection'});};
  try{
    db.transaction(()=>{
      if((db.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as any)?.tenant_id!==tenant||db.prepare('SELECT 1 FROM users WHERE id!=? LIMIT 1').get(tenant))throw new Error('Migration database owner mismatch.');
      if(table(db,'provider_connections'))for(const row of db.prepare('SELECT * FROM provider_connections').all() as any[]){
        if(row.user_id!==tenant||row.provider!=='openrouter')throw new Error('Unmapped provider credential.');
        if(!row.encrypted_key)continue;
        try{const value=open(sourceKey,tenant,'provider:openrouter',row.encrypted_key);if(typeof value!=='string')throw new Error();db.prepare('UPDATE provider_connections SET encrypted_key=? WHERE user_id=? AND provider=?').run(seal(destinationKey,tenant,'provider:openrouter',value),tenant,row.provider);}
        catch{db.prepare('UPDATE provider_connections SET encrypted_key=NULL,key_hint=NULL,key_hash=NULL WHERE user_id=? AND provider=?').run(tenant,row.provider);missing('provider',row.provider);}
      }
      if(table(db,'private_api_keys'))for(const row of db.prepare('SELECT * FROM private_api_keys').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign private key.');
        if(!row.secret)continue;
        try{const value=open(sourceKey,tenant,`api:${row.provider}`,row.secret);if(typeof value!=='string')throw new Error();db.prepare('UPDATE private_api_keys SET secret=? WHERE user_id=? AND provider=?').run(seal(destinationKey,tenant,`api:${row.provider}`,value),tenant,row.provider);}
        catch{db.prepare('DELETE FROM private_api_keys WHERE user_id=? AND provider=?').run(tenant,row.provider);missing('api',row.provider);}
      }
      if(table(db,'apple_refresh_tokens'))for(const row of db.prepare('SELECT * FROM apple_refresh_tokens').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign Apple credential.');
        try{const value=open(sourceKey,tenant,`apple:${row.client_id}`,row.token);if(typeof value!=='string')throw new Error();db.prepare('UPDATE apple_refresh_tokens SET token=? WHERE user_id=? AND client_id=?').run(seal(destinationKey,tenant,`apple:${row.client_id}`,value),tenant,row.client_id);}
        catch{db.prepare('DELETE FROM apple_refresh_tokens WHERE user_id=? AND client_id=?').run(tenant,row.client_id);missing('apple',row.client_id);}
      }
      if(table(db,'mcp_servers'))for(const row of db.prepare('SELECT * FROM mcp_servers').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign MCP credential.');
        let config:any,proven=true;
        try{config=open(sourceKey,tenant,`mcp:${row.id}`,row.config);if(!config||typeof config!=='object'||Array.isArray(config))throw new Error();}
        catch{proven=false;missing('mcp',row.id);config={name:'Reconnect MCP',transport:'http',url:'',command:'',args:[],cwd:'',bearerToken:'',headers:{},env:{},oauth:false};}
        // Discovery and approvals must be refreshed after crossing runtime boundaries.
        config={...config,enabled:false,botIds:[],folders:[],requireApproval:true};
        const revision=Number(row.revision??1)+1;
        db.prepare('UPDATE mcp_servers SET config=?,revision=?,tools=?,checked_at=NULL,error=NULL WHERE id=?').run(seal(destinationKey,tenant,`mcp:${row.id}`,config),revision,'[]',row.id);
        if(table(db,'mcp_oauth')){
          const oauth=db.prepare('SELECT * FROM mcp_oauth WHERE connection_id=?').get(row.id) as any;
          if(oauth){
            try{if(!proven||oauth.user_id!==tenant||oauth.revision!==row.revision)throw new Error();const value=open(sourceKey,tenant,`mcp-oauth:${row.id}:${row.revision}`,oauth.secret);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();delete value.verifier;db.prepare('UPDATE mcp_oauth SET revision=?,secret=? WHERE connection_id=?').run(revision,seal(destinationKey,tenant,`mcp-oauth:${row.id}:${revision}`,value),row.id);}
            catch{db.prepare('DELETE FROM mcp_oauth WHERE connection_id=?').run(row.id);missing('mcp-oauth',row.id);}
          }
        }
      }
      if(table(db,'approvals'))db.prepare("UPDATE approvals SET status='denied',resolved_at=? WHERE status='pending'").run(Date.now());
      if(table(db,'policies'))db.prepare("DELETE FROM policies WHERE tool LIKE 'mcp_%' OR tool LIKE '%:mcp_%'").run();
      if(table(db,'agent_jobs'))db.prepare("UPDATE agent_jobs SET state='uncertain',finished_at=? WHERE state='running'").run(Date.now());
      if(table(db,'tool_dispatches'))db.prepare("UPDATE tool_dispatches SET state='uncertain',finished_at=? WHERE state='dispatching'").run(Date.now());
    }).immediate();
    return reconnect;
  }finally{db.close();}
}

interface FileEntry { path:string;sha256:string;bytes:number;source:'bot-files'|'claude'|'codex'|'desktop' }
export interface MigrationPackageInput extends LegacyInventoryInput {
  volume:string;destination:string;sourceSessionSecret:string;targetKey:Buffer;
  reviewedInventoryHash?:string;
}
async function digest(file:string){const hash=createHash('sha256');for await(const data of fs.createReadStream(file))hash.update(data);return hash.digest('hex');}
export async function prepareMigrationPackage(input:MigrationPackageInput){
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)||! /^[A-Za-z0-9_-]{1,120}$/.test(input.volume))throw new Error('Invalid migration owner.');
  if(!path.isAbsolute(input.destination)||fs.existsSync(input.destination))throw new Error('Migration requires a new absolute destination.');
  const inventory=await inventoryLegacySource(input),snapshotHash=inventory.snapshot.sha256;
  if(input.reviewedInventoryHash!==undefined&&input.reviewedInventoryHash!==inventory.inventoryHash)throw new Error('The reviewed source inventory changed.');
  const staging=`${input.destination}.preparing-${randomBytes(8).toString('hex')}`;
  fs.mkdirSync(staging,{mode:0o700});fs.mkdirSync(path.join(staging,'app'),{mode:0o700});
  const entries:FileEntry[]=[];
  try{
    await exportTenantDatabase(input.sourceSnapshot,path.join(staging,'app/swarm.db'),input.tenant,input.volume);
    const reconnect=rewrapTenantCredentials(path.join(staging,'app/swarm.db'),input.tenant,input.sourceSessionSecret,input.targetKey);
    for(const entry of inventory.entries){
      const root=input[entry.root]!,target=path.join(staging,entry.destination);
      if(entry.kind==='directory'){fs.mkdirSync(target,{recursive:true,mode:0o700});continue;}
      const fd=openInventoryPath(root,entry.relative,false),before=fs.fstatSync(fd),hash=createHash('sha256');let bytes=0;
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      const meter=new Transform({transform(chunk,_e,cb){bytes+=chunk.length;if(bytes>entry.bytes)return cb(new Error('File changed during migration.'));hash.update(chunk);cb(null,chunk);}});
      try{
        await pipeline(fs.createReadStream('',{fd,autoClose:false}),meter,fs.createWriteStream(target,{flags:'wx',mode:0o600}));
        const after=fs.fstatSync(fd),sha256=hash.digest('hex');
        if(bytes!==entry.bytes||sha256!==entry.sha256||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('File changed during migration.');
        entries.push({path:entry.destination,sha256,bytes,source:entry.source});
      }finally{fs.closeSync(fd);}
    }
    // Re-enumeration catches added/removed files and empty directories as well as
    // changed bytes. It remains an observation, not a source writer fence.
    if((await inventoryLegacySource(input)).inventoryHash!==inventory.inventoryHash)throw new Error('Source inventory changed during migration.');
    fs.writeFileSync(path.join(staging,'tenant-manifest.json'),JSON.stringify({tenantId:input.tenant,volumeId:input.volume}),{mode:0o400});
    const receipt={version:1,tenant:input.tenant,volume:input.volume,sourceSnapshotHash:snapshotHash,databaseHash:await digest(path.join(staging,'app/swarm.db')),entries,reconnect,createdAt:new Date().toISOString(),sourceInventoryHash:inventory.inventoryHash,inventoryIssues:inventory.issues,requiresFileInventory:inventory.requiresFileInventory,requiresVerifiedIdentity:true,requiresConnectionVerification:true,routingChanged:false};
    fs.writeFileSync(path.join(staging,'migration-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    fs.renameSync(staging,input.destination);return receipt;
  }catch(error){fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
