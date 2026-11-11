import fs from 'node:fs';
import path from 'node:path';
import { createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { exportTenantDatabase } from './migration.js';
import { openOwnedFile,validateArchiveEntry } from '../security/files.js';

interface Reconnect { kind:string;id:string;reason:'ownership_requires_reconnection' }
const table=(db:Database.Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function cryptKey(secret:string,tenant:string){return Buffer.from(hkdfSync('sha256',secret,tenant,'swarm-private-secrets-v1',32));}
function seal(key:Buffer,tenant:string,purpose:string,value:unknown){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([tenant,purpose,1])));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return `private1:${Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')}`;
}
function open(key:Buffer,tenant:string,purpose:string,value:string){
  if(!value.startsWith('private1:'))throw new Error('Legacy credentials lack authenticated ownership.');
  const b=Buffer.from(value.slice(9),'base64url'),cipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
  cipher.setAuthTag(b.subarray(12,28));cipher.setAAD(Buffer.from(JSON.stringify([tenant,purpose,1])));
  const clear=Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]);try{return JSON.parse(clear.toString());}finally{clear.fill(0);}
}
/** Only cryptographically owner-bound secrets are rewrapped. Shared v1 credentials require reconnection. */
export function rewrapTenantCredentials(database:string,tenant:string,sourceSessionSecret:string,targetKey:Buffer){
  if(targetKey.length!==32||!sourceSessionSecret)throw new Error('Migration encryption keys required.');
  const sourceKey=cryptKey(sourceSessionSecret,tenant),destinationKey=Buffer.from(targetKey),db=new Database(database),reconnect:Reconnect[]=[];
  const missing=(kind:string,id:string)=>reconnect.push({kind,id,reason:'ownership_requires_reconnection'});
  try{
    if((db.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as any)?.tenant_id!==tenant||db.prepare('SELECT 1 FROM users WHERE id!=? LIMIT 1').get(tenant))throw new Error('Migration database owner mismatch.');
    db.transaction(()=>{
      if(table(db,'provider_connections'))for(const row of db.prepare('SELECT * FROM provider_connections').all() as any[]){
        if(row.user_id!==tenant||row.provider!=='openrouter')throw new Error('Unmapped provider credential.');
        if(!row.encrypted_key)continue;
        try{const value=open(sourceKey,tenant,'provider:openrouter',row.encrypted_key);if(typeof value!=='string')throw new Error();db.prepare('UPDATE provider_connections SET encrypted_key=? WHERE user_id=? AND provider=?').run(seal(destinationKey,tenant,'provider:openrouter',value),tenant,row.provider);}
        catch{db.prepare('UPDATE provider_connections SET encrypted_key=NULL,key_hint=NULL,key_hash=NULL WHERE user_id=? AND provider=?').run(tenant,row.provider);missing('provider',row.provider);}
      }
      if(table(db,'private_api_keys'))for(const row of db.prepare('SELECT * FROM private_api_keys').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign private key.');
        if(!row.secret)continue;
        try{const value=open(sourceKey,tenant,`api:${row.provider}`,row.secret);db.prepare('UPDATE private_api_keys SET secret=? WHERE user_id=? AND provider=?').run(seal(destinationKey,tenant,`api:${row.provider}`,value),tenant,row.provider);}
        catch{db.prepare('DELETE FROM private_api_keys WHERE user_id=? AND provider=?').run(tenant,row.provider);missing('api',row.provider);}
      }
      if(table(db,'apple_refresh_tokens'))for(const row of db.prepare('SELECT * FROM apple_refresh_tokens').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign Apple credential.');
        try{const value=open(sourceKey,tenant,`apple:${row.client_id}`,row.token);db.prepare('UPDATE apple_refresh_tokens SET token=? WHERE user_id=? AND client_id=?').run(seal(destinationKey,tenant,`apple:${row.client_id}`,value),tenant,row.client_id);}
        catch{db.prepare('DELETE FROM apple_refresh_tokens WHERE user_id=? AND client_id=?').run(tenant,row.client_id);missing('apple',row.client_id);}
      }
      if(table(db,'mcp_servers'))for(const row of db.prepare('SELECT * FROM mcp_servers').all() as any[]){
        if(row.user_id!==tenant)throw new Error('Foreign MCP credential.');
        let config:any,proven=true;
        try{config=open(sourceKey,tenant,`mcp:${row.id}`,row.config);if(!config||typeof config!=='object')throw new Error();}
        catch{proven=false;missing('mcp',row.id);config={name:'Reconnect MCP',transport:'http',url:'',command:'',args:[],cwd:'',bearerToken:'',headers:{},env:{},oauth:false};}
        // Discovery and approvals must be refreshed after crossing runtime boundaries.
        config={...config,enabled:false,botIds:[],folders:[],requireApproval:true};
        const revision=Number(row.revision??1)+1;
        db.prepare('UPDATE mcp_servers SET config=?,revision=?,tools=?,checked_at=NULL,error=NULL WHERE id=?').run(seal(destinationKey,tenant,`mcp:${row.id}`,config),revision,'[]',row.id);
        if(table(db,'mcp_oauth')){
          const oauth=db.prepare('SELECT * FROM mcp_oauth WHERE connection_id=?').get(row.id) as any;
          if(oauth){
            try{if(!proven||oauth.user_id!==tenant||oauth.revision!==row.revision)throw new Error();const value=open(sourceKey,tenant,`mcp-oauth:${row.id}:${row.revision}`,oauth.secret);delete value.verifier;db.prepare('UPDATE mcp_oauth SET revision=?,secret=? WHERE connection_id=?').run(revision,seal(destinationKey,tenant,`mcp-oauth:${row.id}:${revision}`,value),row.id);}
            catch{db.prepare('DELETE FROM mcp_oauth WHERE connection_id=?').run(row.id);missing('mcp-oauth',row.id);}
          }
        }
      }
      if(table(db,'approvals'))db.prepare("UPDATE approvals SET status='denied',resolved_at=? WHERE status='pending'").run(Date.now());
      if(table(db,'policies'))db.prepare("DELETE FROM policies WHERE tool LIKE 'mcp_%' OR tool LIKE '%:mcp_%'").run();
      if(table(db,'agent_jobs'))db.prepare("UPDATE agent_jobs SET state='uncertain',finished_at=? WHERE state='running'").run(Date.now());
      if(table(db,'tool_dispatches'))db.prepare("UPDATE tool_dispatches SET state='uncertain',finished_at=? WHERE state='dispatching'").run(Date.now());
    })();
    return reconnect;
  }finally{sourceKey.fill(0);destinationKey.fill(0);db.close();}
}

interface FileEntry { path:string;sha256:string;bytes:number;source:'bot-files'|'claude'|'codex'|'desktop' }
export interface MigrationPackageInput {
  sourceSnapshot:string;tenant:string;volume:string;destination:string;sourceSessionSecret:string;targetKey:Buffer;
  filesRoot?:string;cliProfilesRoot?:string;
  /** Offline legacy VM snapshot with tenant-manifest.json proving the recorded volume identity. */
  desktopSnapshot?:string;
}
async function digest(file:string){const hash=createHash('sha256');for await(const data of fs.createReadStream(file))hash.update(data);return hash.digest('hex');}
export async function prepareMigrationPackage(input:MigrationPackageInput){
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)||! /^[A-Za-z0-9_-]{1,120}$/.test(input.volume))throw new Error('Invalid migration owner.');
  if(!path.isAbsolute(input.destination)||fs.existsSync(input.destination))throw new Error('Migration requires a new absolute destination.');
  if(fs.existsSync(`${input.sourceSnapshot}-wal`))throw new Error('Use a stopped, checkpointed database snapshot.');
  const snapshotHash=await digest(input.sourceSnapshot),staging=`${input.destination}.preparing-${randomBytes(8).toString('hex')}`;
  fs.mkdirSync(staging,{mode:0o700});fs.mkdirSync(path.join(staging,'app'),{mode:0o700});
  const entries:FileEntry[]=[];let total=0;
  try{
    const source=new Database(input.sourceSnapshot,{readonly:true,fileMustExist:true});
    let bots:string[],volume:any;
    try{
      bots=table(source,'bots')?(source.prepare('SELECT id FROM bots WHERE user_id=?').all(input.tenant) as any[]).map(r=>r.id):[];
      if(bots.some(id=>! /^[A-Za-z0-9_-]{1,120}$/.test(id)))throw new Error('Unsafe bot identity.');
      volume=table(source,'vms')?source.prepare('SELECT volume_id FROM vms WHERE user_id=?').get(input.tenant):null;
    }finally{source.close();}
    await exportTenantDatabase(input.sourceSnapshot,path.join(staging,'app/swarm.db'),input.tenant,input.volume);
    const reconnect=rewrapTenantCredentials(path.join(staging,'app/swarm.db'),input.tenant,input.sourceSessionSecret,input.targetKey);
    async function copyTree(root:string,relative:string,destination:string,kind:FileEntry['source']){
      validateArchiveEntry(relative);validateArchiveEntry(destination);
      if(!path.isAbsolute(root)||fs.realpathSync(root)!==root)throw new Error('Migration source root must be an immutable canonical directory.');
      const location=path.join(root,relative),stat=fs.lstatSync(location);
      if(stat.isSymbolicLink())throw new Error('Migration symlink requires explicit resolution.');
      if(stat.isDirectory()){
        fs.mkdirSync(path.join(staging,destination),{recursive:true,mode:0o700});
        for(const name of fs.readdirSync(location))await copyTree(root,`${relative}/${name}`,`${destination}/${name}`,kind);
      }else{
        if(!stat.isFile()||stat.nlink!==1||entries.length>=100000||total+stat.size>12*1024**3)throw new Error('Invalid or oversized file inventory.');
        const fd=openOwnedFile(root,relative);
        if(fs.realpathSync(`/proc/self/fd/${fd}`)!==path.resolve(root,relative)){fs.closeSync(fd);throw new Error('Source directory changed during migration.');}
        const before=fs.fstatSync(fd),hash=createHash('sha256');let bytes=0;
        const target=path.join(staging,destination);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        const meter=new Transform({transform(chunk,_e,cb){bytes+=chunk.length;if(bytes>before.size)return cb(new Error('File changed during migration.'));hash.update(chunk);cb(null,chunk);}});
        try{await pipeline(fs.createReadStream('',{fd,autoClose:false}),meter,fs.createWriteStream(target,{flags:'wx',mode:0o600}));const after=fs.fstatSync(fd);if(bytes!==before.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('File changed during migration.');}
        finally{fs.closeSync(fd);}
        total+=bytes;entries.push({path:destination,sha256:hash.digest('hex'),bytes,source:kind});
      }
    }
    if(input.filesRoot)for(const bot of bots)if(fs.existsSync(path.join(input.filesRoot,bot)))await copyTree(input.filesRoot,bot,`files/${bot}`,'bot-files');
    if(input.cliProfilesRoot){
      const owner=createHash('sha256').update(input.tenant).digest('hex');
      for(const [provider,relative] of [['claude','.claude'],['claude','.claude.json'],['codex','.codex']] as const){
        const location=`${owner}/${relative}`;
        if(fs.existsSync(path.join(input.cliProfilesRoot,location)))await copyTree(input.cliProfilesRoot,location,`subscriptions/${provider}/${relative}`,provider);
      }
    }
    if(input.desktopSnapshot){
      const proof=JSON.parse(fs.readFileSync(path.join(input.desktopSnapshot,'tenant-manifest.json'),'utf8'));
      if(!volume?.volume_id||proof.tenantId!==input.tenant||proof.volumeId!==volume.volume_id)throw new Error('Legacy desktop volume ownership is unproven.');
      for(const bot of bots){
        for(const prefix of ['profiles','.swarm/profiles','.swarm/desktop-browser-profiles','.swarm/playwright','files']){
          const relative=`${prefix}/${bot}`;if(fs.existsSync(path.join(input.desktopSnapshot,relative)))await copyTree(input.desktopSnapshot,relative,`desktop/${relative}`,'desktop');
        }
      }
    }
    if(await digest(input.sourceSnapshot)!==snapshotHash||fs.existsSync(`${input.sourceSnapshot}-wal`))throw new Error('Source snapshot changed during migration.');
    fs.writeFileSync(path.join(staging,'tenant-manifest.json'),JSON.stringify({tenantId:input.tenant,volumeId:input.volume}),{mode:0o400});
    const receipt={version:1,tenant:input.tenant,volume:input.volume,sourceSnapshotHash:snapshotHash,databaseHash:await digest(path.join(staging,'app/swarm.db')),entries,reconnect,createdAt:new Date().toISOString(),requiresFileInventory:!input.filesRoot||!!volume?.volume_id&&!input.desktopSnapshot,requiresVerifiedIdentity:true,requiresConnectionVerification:true,routingChanged:false};
    fs.writeFileSync(path.join(staging,'migration-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    fs.renameSync(staging,input.destination);return receipt;
  }catch(error){fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
