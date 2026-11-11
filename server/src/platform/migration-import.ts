/** Offline operator import. This is not mounted as an HTTP or agent API. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Directory } from './directory.js';
import type { ConnectionProvider } from './composio-policy.js';

type LegacyProvider='google'|'apple'|'openrouter';
interface ImportInput {
  snapshot:string; snapshotHash:string; tenant:string;
  /** Individually audited bindings; never generate these from users.email or users.phone. */
  identities:{provider:LegacyProvider;subject:string}[];
  /** IDs from the legacy Composio private-account inventory, never toolkit defaults. */
  connectionIds:string[];
}
async function hash(file:string){const h=createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');}
/** Reserve the legacy immutable ID without enabling provisioning or login. Each
 * identity must still authenticate through its provider to redeem its claim.
 * No email-only account can be imported until authenticated linking was done in
 * the legacy app. Ambiguous historical bindings must be omitted by the audit. */
export async function stageLegacyImport(directory:Directory,provider:Pick<ConnectionProvider,'owned'>,input:ImportInput){
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)||!/^[a-f0-9]{64}$/.test(input.snapshotHash)||!input.identities.length||input.identities.length>3||new Set(input.identities.map(i=>i.provider)).size!==input.identities.length||input.connectionIds.length>1000||new Set(input.connectionIds).size!==input.connectionIds.length)throw new Error('Invalid audited migration inventory.');
  if(fs.existsSync(`${input.snapshot}-wal`)||await hash(input.snapshot)!==input.snapshotHash)throw new Error('Migration snapshot differs from the audited inventory.');
  const source=new Database(input.snapshot,{readonly:true,fileMustExist:true});
  let profile:{name:string};
  try{
    const owner=source.prepare('SELECT id,name FROM users WHERE id=?').get(input.tenant) as any;
    if(!owner)throw new Error('Source owner missing.');profile={name:typeof owner.name==='string'?owner.name.slice(0,200):'Swarm member'};
    for(const identity of input.identities){
      if(!['google','apple','openrouter'].includes(identity.provider)||!identity.subject||identity.subject.length>500)throw new Error('Invalid immutable identity.');
      // Standalone Composio Gmail sign-in binds a mailbox, not Google's immutable OIDC subject; tenants re-link Google.
      if(identity.provider==='google'&&identity.subject.startsWith('gmail-mailbox:'))throw new Error('Invalid immutable identity.');
      const table=`${identity.provider}_identities`;
      if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Authenticated provider linking is required in the source account.');
      const row=source.prepare(`SELECT user_id FROM ${table} WHERE subject=?`).get(identity.subject) as any;
      if(row?.user_id!==input.tenant)throw new Error('Foreign or unverified source identity.');
    }
  }finally{source.close();}
  const connections:{id:string;toolkit:string}[]=[],reconnect:string[]=[];
  // Existing standalone calls use the immutable Swarm ID as Composio userId.
  // A different project mapping cannot be guessed or substituted at import time.
  for(const id of input.connectionIds){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new Error('Invalid connection inventory.');
    const remote=await provider.owned(input.tenant,id);
    if(!remote?.active){reconnect.push(id);continue;}
    if(!/^[a-z0-9_]{1,100}$/.test(remote.toolkit))throw new Error('Invalid provider ownership response.');
    connections.push({id,toolkit:remote.toolkit});
  }
  if(fs.existsSync(`${input.snapshot}-wal`)||await hash(input.snapshot)!==input.snapshotHash)throw new Error('Source snapshot changed during import.');
  await directory.transaction(async client=>{
    // Serializes against normal callback identity creation, including a signup
    // that raced the audited migration. Never overwrite an existing identity.
    for(const identity of [...input.identities].sort((a,b)=>a.provider.localeCompare(b.provider)))await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${identity.provider}:${identity.subject}`]);
    if((await client.query('SELECT 1 FROM tenants WHERE id=$1',[input.tenant])).rowCount)throw new Error('Destination already exists; reconcile the prior import.');
    for(const identity of input.identities)if((await client.query('SELECT 1 FROM identities WHERE provider=$1 AND subject=$2',[identity.provider,identity.subject])).rowCount)throw new Error('Identity was already registered; authenticated reconciliation is required.');
    await client.query('INSERT INTO tenants(id,display_name,composio_user_id) VALUES($1,$2,$1)',[input.tenant,profile.name]);
    for(const identity of input.identities)await client.query('INSERT INTO legacy_identity_claims(provider,subject,tenant_id,snapshot_hash) VALUES($1,$2,$3,$4)',[identity.provider,identity.subject,input.tenant,input.snapshotHash]);
    for(const connection of connections)await client.query("INSERT INTO connected_accounts(id,tenant_id,toolkit,state) VALUES($1,$2,$3,'active')",[connection.id,input.tenant,connection.toolkit]);
    // No create job: only a qualified migration adapter can activate this account.
  });
  return {tenant:input.tenant,snapshotHash:input.snapshotHash,identityClaims:input.identities.length,connections:connections.map(c=>c.id),reconnect,requiresProviderSignIn:true,routingChanged:false};
}
