import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,createHash,createCipheriv,createDecipheriv,hkdfSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { prepareMigrationPackage,rewrapLegacyRollbackCredentials } from '../server/src/platform/migration-package.js';
import {sealSecret} from '../server/src/security/secret-envelope.js';
const owner='usr_aaaaaaaa',other='usr_bbbbbbbb',secret='old-server-session-secret-only-for-tests';
function encrypted(who:string,purpose:string,value:any){const key=Buffer.from(hkdfSync('sha256',secret,who,'swarm-private-secrets-v1',32)),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([who,purpose,1])));const content=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);key.fill(0);return `private1:${Buffer.concat([iv,c.getAuthTag(),content]).toString('base64url')}`;}
function decrypt(key:Buffer,who:string,purpose:string,value:string){const b=Buffer.from(value.slice(9),'base64url'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(JSON.stringify([who,purpose,1])));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}

test('migration package preserves only owned files and authenticated credentials',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-migration-package-')),source=path.join(root,'source.db'),files=path.join(root,'files'),profiles=path.join(root,'profiles'),key=randomBytes(32);
  const db=new Database(source);
  try{
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,phone TEXT);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
      CREATE TABLE provider_connections(user_id TEXT REFERENCES users(id),provider TEXT,encrypted_key TEXT,key_hint TEXT,key_hash TEXT,PRIMARY KEY(user_id,provider));
      CREATE TABLE private_api_keys(user_id TEXT REFERENCES users(id),provider TEXT,secret TEXT,PRIMARY KEY(user_id,provider));
      CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),config TEXT,revision INTEGER,tools TEXT,checked_at INTEGER,error TEXT);
      CREATE TABLE mcp_oauth(connection_id TEXT PRIMARY KEY REFERENCES mcp_servers(id),user_id TEXT REFERENCES users(id),revision INTEGER,secret TEXT);
      CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
      CREATE TABLE approvals(id TEXT PRIMARY KEY,bot_id TEXT REFERENCES bots(id),status TEXT,resolved_at INTEGER);
      INSERT INTO users VALUES('usr_aaaaaaaa','15551111111'),('usr_bbbbbbbb','15552222222');
      INSERT INTO bots VALUES('bot_a','usr_aaaaaaaa'),('hidden_a','usr_aaaaaaaa'),('bot_b','usr_bbbbbbbb');
      INSERT INTO auth_sessions VALUES('old-session','usr_aaaaaaaa');INSERT INTO approvals VALUES('approval','bot_a','pending',NULL);`);
    db.prepare('INSERT INTO provider_connections VALUES(?,?,?,?,?)').run(owner,'openrouter',encrypted(owner,'provider:openrouter','owner-only-key'),'hint','hash');
    // A ciphertext copied from B into A's record cannot be rewrapped as A's credential.
    db.prepare('INSERT INTO private_api_keys VALUES(?,?,?)').run(owner,'voice',encrypted(other,'api:voice','foreign-key'));
    db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?,?,?)').run('mcp_owned',owner,encrypted(owner,'mcp:mcp_owned',{name:'MCP',transport:'http',url:'https://example.test',botIds:['bot_a'],requireApproval:false,headers:{authorization:'private-token'}}),3,'[]',null,null);
    db.prepare('INSERT INTO mcp_oauth VALUES(?,?,?,?)').run('mcp_owned',owner,3,encrypted(owner,'mcp-oauth:mcp_owned:3',{tokens:{access_token:'oauth'},verifier:'obsolete'}));
    db.close();
    for(const bot of ['bot_a','hidden_a','bot_b']){fs.mkdirSync(path.join(files,bot),{recursive:true});fs.writeFileSync(path.join(files,bot,'note.txt'),bot);}
    const profile=createHash('sha256').update(owner).digest('hex');
    fs.mkdirSync(path.join(profiles,profile,'.codex'),{recursive:true});fs.writeFileSync(path.join(profiles,profile,'.codex/auth.json'),'private-codex-profile');
    const result=await prepareMigrationPackage({sourceSnapshot:source,tenant:owner,volume:'new_volume',destination:path.join(root,'result'),sourceSessionSecret:secret,targetKey:key,filesRoot:files,cliProfilesRoot:profiles});
    assert.equal(result.requiresFileInventory,false);assert.equal(result.routingChanged,false);assert.ok(result.reconnect.some(r=>r.kind==='api'&&r.id==='voice'));
    assert.equal(fs.existsSync(path.join(root,'result/files/bot_b')),false);assert.equal(fs.readFileSync(path.join(root,'result/files/hidden_a/note.txt'),'utf8'),'hidden_a');
    assert.equal(fs.readFileSync(path.join(root,'result/subscriptions/codex/.codex/auth.json'),'utf8'),'private-codex-profile');
    const target=new Database(path.join(root,'result/app/swarm.db'));
    try{
      assert.equal(decrypt(key,owner,'provider:openrouter',(target.prepare('SELECT encrypted_key FROM provider_connections').get() as any).encrypted_key),'owner-only-key');
      assert.equal((target.prepare('SELECT count(*) n FROM private_api_keys').get() as any).n,0);
      const mcp=target.prepare('SELECT * FROM mcp_servers').get() as any,config=decrypt(key,owner,'mcp:mcp_owned',mcp.config);
      assert.equal(config.enabled,false);assert.equal(config.requireApproval,true);assert.deepEqual(config.botIds,[]);assert.equal(config.headers.authorization,'private-token');assert.equal(mcp.revision,4);
      assert.deepEqual(decrypt(key,owner,'mcp-oauth:mcp_owned:4',(target.prepare('SELECT secret FROM mcp_oauth').get() as any).secret),{tokens:{access_token:'oauth'}});
      assert.equal((target.prepare('SELECT count(*) n FROM auth_sessions').get() as any).n,0);assert.equal((target.prepare('SELECT status FROM approvals').get() as any).status,'denied');
    }finally{target.close();}
    // An ancestor symlink aimed at another user's profile must fail even within the same root.
    fs.rmSync(path.join(profiles,profile),{recursive:true});fs.mkdirSync(path.join(profiles,'foreign/.codex'),{recursive:true});fs.writeFileSync(path.join(profiles,'foreign/.codex/auth.json'),'foreign');fs.symlinkSync(path.join(profiles,'foreign'),path.join(profiles,profile));
    await assert.rejects(prepareMigrationPackage({sourceSnapshot:source,tenant:owner,volume:'new_volume',destination:path.join(root,'unsafe'),sourceSessionSecret:secret,targetKey:key,filesRoot:files,cliProfilesRoot:profiles}),/Source directory|symlink/);
    assert.equal(fs.existsSync(path.join(root,'unsafe')),false);
  }finally{if(db.open)db.close();key.fill(0);fs.rmSync(root,{recursive:true,force:true});}
});

for(const failure of ['none','foreign-ciphertext','wrong-key','foreign-row','malformed-secret','shared-database'] as const)test(`rollback credential preparation ${failure} preserves authenticated ownership and requires reconciled import`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-rollback-keys-')),file=path.join(root,'rollback.db'),key=randomBytes(32);
  t.after(()=>{key.fill(0);fs.rmSync(root,{recursive:true,force:true});});
  const db=new Database(file);
  db.exec(`CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);INSERT INTO tenant_identity VALUES(1,'${owner}');
    CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('${owner}');
    CREATE TABLE provider_connections(user_id TEXT,provider TEXT,encrypted_key TEXT,key_hint TEXT,key_hash TEXT);
    CREATE TABLE private_api_keys(user_id TEXT,provider TEXT,secret TEXT);
    CREATE TABLE apple_refresh_tokens(user_id TEXT,client_id TEXT,token TEXT);
    CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,user_id TEXT,config TEXT,revision INTEGER,tools TEXT,checked_at INTEGER,error TEXT);
    CREATE TABLE mcp_oauth(connection_id TEXT PRIMARY KEY,user_id TEXT,revision INTEGER,secret TEXT);
    CREATE TABLE approvals(id TEXT,status TEXT,resolved_at INTEGER);INSERT INTO approvals VALUES('pending','pending',NULL);
    CREATE TABLE policies(tool TEXT);INSERT INTO policies VALUES('mcp_saved'),('bot:mcp_saved'),('other_tool');`);
  db.prepare('INSERT INTO provider_connections VALUES(?,?,?,?,?)').run(owner,'openrouter',sealSecret(key,owner,'provider:openrouter','owner-router'),'hint','hash');
  db.prepare('INSERT INTO private_api_keys VALUES(?,?,?)').run(owner,'voice',sealSecret(key,owner,'api:voice','owner-voice'));
  db.prepare('INSERT INTO apple_refresh_tokens VALUES(?,?,?)').run(owner,'native',sealSecret(key,owner,'apple:native','owner-apple'));
  const config={enabled:true,botIds:['bot_a'],folders:['bot_a/docs'],name:'Private MCP',requireApproval:false,headers:{authorization:'owner-mcp'}};
  db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,7,?,1,NULL)').run('mcp_a',owner,sealSecret(key,owner,'mcp:mcp_a',config),'[{}]');
  db.prepare('INSERT INTO mcp_oauth VALUES(?,?,7,?)').run('mcp_a',owner,sealSecret(key,owner,'mcp-oauth:mcp_a:7',{tokens:{access_token:'owner-oauth'},verifier:'pending-verifier'}));
  if(failure==='foreign-ciphertext')db.prepare('UPDATE private_api_keys SET secret=?').run(sealSecret(key,other,'api:voice','foreign-private-key'));
  if(failure==='foreign-row')db.prepare('UPDATE private_api_keys SET user_id=?').run(other);
  if(failure==='malformed-secret')db.prepare('UPDATE private_api_keys SET secret=?').run(sealSecret(key,owner,'api:voice',{not:'a key'}));
  if(failure==='shared-database')db.prepare('INSERT INTO users VALUES(?)').run(other);
  const tables=['provider_connections','private_api_keys','apple_refresh_tokens','mcp_servers','mcp_oauth','approvals','policies'];
  const rows=()=>Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
  const before=rows();db.close();
  const usedKey=failure==='wrong-key'?randomBytes(32):Buffer.from(key);
  if(failure!=='none'){
    assert.throws(()=>rewrapLegacyRollbackCredentials(file,owner,usedKey,secret),/owner|Foreign|integrity/);
    const verify=new Database(file);try{assert.deepEqual(Object.fromEntries(tables.map(table=>[table,verify.prepare(`SELECT * FROM ${table}`).all()])),before);}finally{verify.close();usedKey.fill(0);}
    return;
  }
  assert.deepEqual(rewrapLegacyRollbackCredentials(file,owner,usedKey,secret),{tenant:owner,requiresReconciledImport:true,routingChanged:false});usedKey.fill(0);
  const legacyKey=Buffer.from(hkdfSync('sha256',secret,owner,'swarm-private-secrets-v1',32)),legacy=new Database(file);
  try{
    const value=(table:string,column:string,purpose:string)=>decrypt(legacyKey,owner,purpose,(legacy.prepare(`SELECT ${column} value FROM ${table}`).get() as any).value);
    assert.equal(value('provider_connections','encrypted_key','provider:openrouter'),'owner-router');
    assert.equal(value('private_api_keys','secret','api:voice'),'owner-voice');
    assert.equal(value('apple_refresh_tokens','token','apple:native'),'owner-apple');
    assert.deepEqual(value('mcp_servers','config','mcp:mcp_a'),{...config,enabled:false,botIds:[],folders:[],requireApproval:true});
    assert.deepEqual(value('mcp_oauth','secret','mcp-oauth:mcp_a:8'),{tokens:{access_token:'owner-oauth'}});
    assert.equal((legacy.prepare('SELECT revision FROM mcp_servers').get() as any).revision,8);
    assert.equal((legacy.prepare('SELECT status FROM approvals').get() as any).status,'denied');
    assert.deepEqual(legacy.prepare('SELECT tool FROM policies').all(),[{tool:'other_tool'}]);
    assert.throws(()=>decrypt(key,owner,'api:voice',(legacy.prepare('SELECT secret FROM private_api_keys').get() as any).secret));
    assert.throws(()=>decrypt(legacyKey,other,'api:voice',(legacy.prepare('SELECT secret FROM private_api_keys').get() as any).secret));
  }finally{legacyKey.fill(0);legacy.close();}
});
