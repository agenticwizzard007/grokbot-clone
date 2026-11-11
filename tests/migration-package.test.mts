import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,createHash,createCipheriv,createDecipheriv,hkdfSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { prepareMigrationPackage } from '../server/src/platform/migration-package.js';
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
