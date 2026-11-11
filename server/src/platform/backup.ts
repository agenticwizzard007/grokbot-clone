/** Trusted backup/restore tooling. Never mounted into an MCP or subscription container. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import { openOwnedFile, validateArchiveEntry } from '../security/files.js';
import {openSecret,sealSecret} from '../security/secret-envelope.js';

const MAX_FILES = 100_000;
const MAX_TOTAL = 12 * 1024 ** 3;
const checkTenant = (id: string) => { if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid backup owner.'); };
const checkId = (id: string) => { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid backup identity.'); };
const keyFor = (master: Buffer, tenant: string, id: string) => {
  checkTenant(tenant); checkId(id);
  if (master.length !== 32) throw new Error('Invalid backup key.');
  return Buffer.from(hkdfSync('sha256', master, id, `swarm-backup:${tenant}:v1`, 32));
};
interface Entry { path: string; blob: string; size: number; hash: string; iv: string; tag: string }
interface Manifest { version: 1; tenant: string; id: string; createdAt: string; scope?: 'database'|'environment'; entries: Entry[] }
function owner(database: string, tenant: string) {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    if ((db.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as any)?.tenant_id !== tenant) throw new Error('Backup database owner mismatch.');
    if (db.prepare('SELECT 1 FROM users WHERE id!=? LIMIT 1').get(tenant)) throw new Error('Backup contains foreign users.');
    if ((db.pragma('integrity_check') as any[])[0]?.integrity_check !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Invalid backup database.');
  } finally { db.close(); }
}
function meter(maximum: number, digest = createHash('sha256')) {
  let size = 0;
  const stream = new Transform({ transform(chunk, _encoding, cb) {
    size += chunk.length;
    if (size > maximum) return cb(new Error('Backup size limit exceeded.'));
    digest.update(chunk); cb(null, chunk);
  } });
  return { stream, result: () => ({ size, hash: digest.digest('hex') }) };
}
function list(root: string, relative: string, result: string[]) {
  const target = path.join(root, relative), info = fs.lstatSync(target);
  if (info.isSymbolicLink()) throw new Error('Backup symlinks require explicit migration.');
  if (info.isDirectory()) {
    for (const name of fs.readdirSync(target)) list(root, `${relative}/${name}`, result);
  } else if (info.isFile()) {
    if (result.length >= MAX_FILES) throw new Error('Backup file limit exceeded.');
    result.push(validateArchiveEntry(relative));
  } else throw new Error('Backup contains a special file.');
}
/** Creates an encrypted, immutable bundle. The caller supplies a stopped/quiesced
 * environment for profile consistency; SQLite itself uses its online backup API. */
export async function backupEnvironment(root: string, output: string, tenant: string, master: Buffer, scope: 'database'|'environment' = 'environment') {
  checkTenant(tenant);
  const manifestOwner = JSON.parse(fs.readFileSync(path.join(root,'tenant-manifest.json'),'utf8'));
  if (manifestOwner.tenantId !== tenant) throw new Error('Backup volume owner mismatch.');
  owner(path.join(root,'app/swarm.db'),tenant);
  fs.mkdirSync(output,{recursive:false,mode:0o700});
  const staging=fs.mkdtempSync(path.join(path.dirname(output),'.snapshot-'));
  const id=randomBytes(16).toString('hex'),key=keyFor(master,tenant,id);
  try {
    const snapshot=path.join(staging,'swarm.db'),source=new Database(path.join(root,'app/swarm.db'),{readonly:true,fileMustExist:true});
    try { await source.backup(snapshot); } finally { source.close(); }
    const files: string[]=[];
    // Refresh/bootstrap tokens, Docker state, host credentials and caches are deliberately excluded.
    if(scope==='environment')for (const dir of ['files','desktop','subscriptions']) if(fs.existsSync(path.join(root,dir)))list(root,dir,files);
    const entries:Entry[]=[];let total=0;
    for (const relative of ['app/swarm.db',...files]) {
      const blob=`${entries.length}.bin`,iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(JSON.stringify([tenant,id,relative,1])));
      const [scope, ...segments]=relative.split('/');
      const fd=relative==='app/swarm.db'?fs.openSync(snapshot,'r'):openOwnedFile(path.join(root,scope),segments.join('/'));
      const before=fs.fstatSync(fd),m=meter(MAX_TOTAL-total);
      await pipeline(fs.createReadStream('',{fd,autoClose:true}),m.stream,cipher,fs.createWriteStream(path.join(output,blob),{flags:'wx',mode:0o600}));
      const result=m.result();total+=result.size;
      if(result.size!==before.size)throw new Error('File changed during backup; retry with workloads stopped.');
      entries.push({path:relative,blob,...result,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')});
    }
    const manifest:Manifest={version:1,tenant,id,createdAt:new Date().toISOString(),scope,entries};
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([tenant,id,'manifest',1])));
    const payload=Buffer.concat([cipher.update(JSON.stringify(manifest)),cipher.final()]);
    fs.writeFileSync(path.join(output,'manifest.bin'),Buffer.concat([iv,cipher.getAuthTag(),payload]),{flag:'wx',mode:0o600});
    return {id,tenant,scope,files:entries.length,bytes:total};
  } catch(e) { fs.rmSync(output,{recursive:true,force:true});throw e; }
  finally { key.fill(0);fs.rmSync(staging,{recursive:true,force:true}); }
}
/** Restores into a new directory only. No existing environment can be overwritten. */
export async function restoreEnvironment(bundle: string, destination: string, tenant: string, id: string, volume: string, master: Buffer) {
  if(fs.existsSync(destination))throw new Error('Restore destination already exists.');
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(volume))throw new Error('Invalid restore volume.');
  const key=keyFor(master,tenant,id),staging=`${destination}.restoring-${randomBytes(8).toString('hex')}`;
  try {
    const fd=openOwnedFile(bundle,'manifest.bin');
    let bytes:Buffer;try{if(fs.fstatSync(fd).size>32*1024*1024)throw new Error('Manifest limit exceeded.');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(JSON.stringify([tenant,id,'manifest',1])));decipher.setAuthTag(bytes.subarray(12,28));
    const manifest=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()) as Manifest;
    if(manifest.version!==1||manifest.tenant!==tenant||manifest.id!==id||!Array.isArray(manifest.entries)||manifest.entries.length>MAX_FILES)throw new Error('Invalid backup manifest.');
    let total=0;const paths=new Set<string>();
    for(const entry of manifest.entries){
      validateArchiveEntry(entry.path);
      if((entry.path!=='app/swarm.db'&&!/^(files|desktop|subscriptions)\//.test(entry.path))||paths.has(entry.path)||!/^\d+\.bin$/.test(entry.blob)||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.hash))throw new Error('Invalid backup entry.');
      paths.add(entry.path);total+=entry.size;
      if(total>MAX_TOTAL)throw new Error('Backup size limit exceeded.');
    }
    if(!paths.has('app/swarm.db'))throw new Error('Missing backup database.');
    fs.mkdirSync(staging,{recursive:false,mode:0o700});
    for(const entry of manifest.entries){
      const destinationFile=path.join(staging,entry.path);fs.mkdirSync(path.dirname(destinationFile),{recursive:true,mode:0o700});
      const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(entry.iv,'base64url'));decipher.setAAD(Buffer.from(JSON.stringify([tenant,id,entry.path,1])));decipher.setAuthTag(Buffer.from(entry.tag,'base64url'));
      const m=meter(entry.size),fd=openOwnedFile(bundle,entry.blob);
      await pipeline(fs.createReadStream('',{fd,autoClose:true}),decipher,m.stream,fs.createWriteStream(destinationFile,{flags:'wx',mode:0o600}));
      const result=m.result();if(result.size!==entry.size||result.hash!==entry.hash)throw new Error('Backup entry integrity failed.');
    }
    owner(path.join(staging,'app/swarm.db'),tenant);
    const restored=new Database(path.join(staging,'app/swarm.db'));
    try {
      const has=(table:string)=>!!restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      restored.transaction(()=>{
        for(const table of ['auth_sessions','companion_tokens','cli_pairings','mcp_oauth_attempts','openrouter_login_attempts','apple_login_attempts','google_oidc_attempts','native_login_attempts','phone_logins','login_tokens','messaging_codes'])if(has(table))restored.exec(`DELETE FROM ${table}`);
        // A backup can predate a successful external write. Even a job that was
        // queued at snapshot time may have completed before the source failed;
        // preserve it for reconciliation instead of replaying it automatically.
        if(has('agent_jobs'))restored.prepare("UPDATE agent_jobs SET state='uncertain',finished_at=? WHERE state IN ('queued','running')").run(Date.now());
        if(has('tool_dispatches'))restored.prepare("UPDATE tool_dispatches SET state='uncertain',finished_at=? WHERE state='dispatching'").run(Date.now());
        if(has('approvals'))restored.prepare("UPDATE approvals SET status='denied',resolved_at=? WHERE status='pending'").run(Date.now());
        if(has('messaging_inbox'))restored.exec("UPDATE messaging_inbox SET status='uncertain',error='recovery_requires_reconciliation' WHERE status='pending'");
        if(has('messaging_messages'))restored.exec("UPDATE messaging_messages SET status='uncertain' WHERE status IN ('sending','queued')");
        // A restored snapshot must not resurrect previously revoked consent.
        // Keep revision monotonic relative to all approvals in this snapshot.
        if(has('local_computer_access'))restored.exec('UPDATE local_computer_access SET enabled=0,revision=revision+1');
        if(has('mcp_servers')){
          if((restored.prepare('SELECT count(*) n FROM mcp_servers').get() as any).n>20)throw new Error('MCP recovery inventory requires reconciliation.');
          for(const row of restored.prepare('SELECT id,user_id,config FROM mcp_servers').all() as any[]){
            if(row.user_id!==tenant||typeof row.config!=='string'||row.config.length>4*1024*1024)throw new Error('Invalid recovered MCP owner or configuration.');
            const config=openSecret<Record<string,unknown>>(master,tenant,`mcp:${row.id}`,row.config);
            if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Invalid recovered MCP configuration.');
            restored.prepare("UPDATE mcp_servers SET config=?,revision=revision+1,tools='[]',checked_at=NULL,error=NULL WHERE id=?").run(sealSecret(master,tenant,`mcp:${row.id}`,{...config,enabled:false,botIds:[],folders:[],requireApproval:true}),row.id);
          }
        }
        if(has('mcp_oauth'))restored.exec('DELETE FROM mcp_oauth');
        if(has('policies'))restored.exec("DELETE FROM policies WHERE tool LIKE 'mcp_%' OR tool LIKE '%:mcp_%'");
      })();
    }finally{restored.close();}
    fs.writeFileSync(path.join(staging,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:volume}),{mode:0o400});
    fs.renameSync(staging,destination);
    return {scope:manifest.scope??'environment',createdAt:manifest.createdAt,files:manifest.entries.length};
  } finally { key.fill(0);fs.rmSync(staging,{recursive:true,force:true}); }
}
