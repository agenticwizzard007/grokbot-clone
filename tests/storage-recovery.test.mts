import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {sealSecret,openSecret} from '../server/src/security/secret-envelope.js';
import Database from 'better-sqlite3';
import { backupEnvironment, restoreEnvironment } from '../server/src/platform/backup.js';
import { exportTenantDatabase } from '../server/src/platform/migration.js';
import { openOwnedFile, validateArchiveEntry } from '../server/src/security/files.js';

test('filesystem boundary refuses traversal, symlink escapes and special files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-files-'));try{
    const inside=path.join(root,'inside');fs.mkdirSync(inside);fs.writeFileSync(path.join(root,'secret'),'private');fs.symlinkSync(root,path.join(inside,'escape'));
    fs.writeFileSync(path.join(inside,'allowed'),'safe');const fd=openOwnedFile(inside,'allowed');try{assert.equal(fs.readFileSync(fd,'utf8'),'safe');}finally{fs.closeSync(fd);}
    for(const name of ['../secret','escape/secret','/etc/passwd'])assert.throws(()=>openOwnedFile(inside,name));
    for(const name of ['../a','/a','x/../../a','C:/x','x\\y'])assert.throws(()=>validateArchiveEntry(name));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('migration exports only proven ownership and refuses foreign relationships',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-migrate-')),file=path.join(root,'source.db');
  const db=new Database(file);try{
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
      CREATE TABLE rows(id TEXT PRIMARY KEY,bot_id TEXT REFERENCES bots(id),body TEXT);
      CREATE TABLE rooms(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
      CREATE TABLE memberships(room_id TEXT REFERENCES rooms(id),bot_id TEXT REFERENCES bots(id));
      CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
      INSERT INTO users VALUES('usr_aaaaaaaa'),('usr_bbbbbbbb');
      INSERT INTO bots VALUES('a','usr_aaaaaaaa'),('hidden-a','usr_aaaaaaaa'),('b','usr_bbbbbbbb');
      INSERT INTO rows VALUES('one','hidden-a','private-a'),('two','b','private-b');
      INSERT INTO rooms VALUES('room-a','usr_aaaaaaaa'),('room-b','usr_bbbbbbbb');
      INSERT INTO memberships VALUES('room-a','hidden-a'),('room-b','b');
      INSERT INTO auth_sessions VALUES('session','usr_aaaaaaaa');`);
    const exported=path.join(root,'export.db');await exportTenantDatabase(file,exported,'usr_aaaaaaaa','vol_a');
    const result=new Database(exported);try{
      assert.deepEqual(result.prepare('SELECT id FROM users').all(),[{id:'usr_aaaaaaaa'}]);assert.equal(result.prepare('SELECT body FROM rows').get().body,'private-a');
      assert.equal(result.prepare('SELECT count(*) n FROM bots').get().n,2);assert.equal(result.prepare('SELECT count(*) n FROM auth_sessions').get().n,0);
    }finally{result.close();}
    db.exec("INSERT INTO memberships VALUES('room-a','b')");
    await assert.rejects(exportTenantDatabase(file,path.join(root,'unsafe.db'),'usr_aaaaaaaa','vol_a'),/Foreign|ownership/);
    assert.equal(fs.existsSync(path.join(root,'unsafe.db')),false);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy export validates implicit room, helper, preference and usage ownership in both directions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-migration-implicit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  async function scenario(name:string,mutate:string,valid=false){
    const file=path.join(root,name+'.db'),db=new Database(file);
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,phone TEXT);CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,parent_bot_id TEXT,members TEXT);
      CREATE TABLE messaging_prefs(user_id TEXT,active_bot_id TEXT);CREATE TABLE usage_events(user_id TEXT,bot_id TEXT);
      INSERT INTO users VALUES('usr_aaaaaaaa','15551111111'),('usr_bbbbbbbb','15552222222');
      INSERT INTO bots VALUES('a','usr_aaaaaaaa',NULL,NULL),('hidden-a','usr_aaaaaaaa','a',NULL),('room-a','usr_aaaaaaaa',NULL,'["a","hidden-a"]'),('b','usr_bbbbbbbb',NULL,NULL);
      INSERT INTO messaging_prefs VALUES('usr_aaaaaaaa','hidden-a'),('usr_bbbbbbbb','b');
      INSERT INTO usage_events VALUES('usr_aaaaaaaa','a');`);
    db.exec(mutate);db.close();const output=path.join(root,name+'-export.db');
    if(valid){await exportTenantDatabase(file,output,'usr_aaaaaaaa','vol_a');const target=new Database(output);try{assert.equal(target.prepare("SELECT members FROM bots WHERE id='room-a'").get().members,'["a","hidden-a"]');assert.equal(target.prepare('SELECT count(*) n FROM bots').get().n,3);}finally{target.close();}}
    else {await assert.rejects(exportTenantDatabase(file,output,'usr_aaaaaaaa','vol_a'),/implicit relationship|room membership|phone ownership/);assert.equal(fs.existsSync(output),false);}
  }
  await scenario('owned','',true);
  await scenario('foreign-helper',"UPDATE bots SET parent_bot_id='b' WHERE id='hidden-a'");
  await scenario('foreign-room',`UPDATE bots SET members='["b"]' WHERE id='room-a'`);
  await scenario('incoming-room',`UPDATE bots SET members='["a"]' WHERE id='b'`);
  await scenario('malformed-room',`UPDATE bots SET members='{"id":"a"}' WHERE id='room-a'`);
  await scenario('foreign-preference',"UPDATE messaging_prefs SET active_bot_id='b' WHERE user_id='usr_aaaaaaaa'");
  await scenario('incoming-preference',"UPDATE messaging_prefs SET active_bot_id='a' WHERE user_id='usr_bbbbbbbb'");
  await scenario('foreign-usage',"UPDATE usage_events SET bot_id='b'");
  await scenario('ambiguous-phone',"UPDATE users SET phone='15551111111'");
});
test('encrypted recovery is tenant-bound, rejects tampering and never overwrites another environment',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-backup-')),data=path.join(root,'data'),bundle=path.join(root,'bundle'),tenant='usr_aaaaaaaa',master=randomBytes(32);
  try{
    fs.mkdirSync(path.join(data,'app'),{recursive:true});fs.mkdirSync(path.join(data,'files/bot'),{recursive:true});
    fs.writeFileSync(path.join(data,'tenant-manifest.json'),JSON.stringify({tenantId:tenant,volumeId:'vol_a'}));
    fs.writeFileSync(path.join(data,'files/bot/private.txt'),'tenant private content');
    fs.writeFileSync(path.join(data,'runtime-refresh'),'never include a host identity');
    const db=new Database(path.join(data,'app/swarm.db'));db.exec(`CREATE TABLE tenant_identity(singleton INTEGER PRIMARY KEY,tenant_id TEXT);INSERT INTO tenant_identity VALUES(1,'${tenant}');CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('${tenant}');CREATE TABLE auth_sessions(token TEXT PRIMARY KEY);INSERT INTO auth_sessions VALUES('old-cookie');`);db.close();
    const pending=new Database(path.join(data,'app/swarm.db'));pending.exec(`CREATE TABLE agent_jobs(id TEXT,state TEXT,finished_at INTEGER);INSERT INTO agent_jobs VALUES('queued-at-snapshot','queued',NULL),('running-at-snapshot','running',NULL),('already-done','completed',1);
      CREATE TABLE tool_dispatches(id TEXT,state TEXT,finished_at INTEGER);INSERT INTO tool_dispatches VALUES('external-write','dispatching',NULL);
      CREATE TABLE approvals(id TEXT,status TEXT,resolved_at INTEGER);INSERT INTO approvals VALUES('old-approval','pending',NULL);
      CREATE TABLE messaging_inbox(id TEXT,status TEXT,error TEXT);INSERT INTO messaging_inbox VALUES('received','pending',NULL);
      CREATE TABLE messaging_messages(id TEXT,status TEXT);INSERT INTO messaging_messages VALUES('outgoing','queued');
      CREATE TABLE local_computer_access(user_id TEXT,enabled INTEGER,revision INTEGER);INSERT INTO local_computer_access VALUES('${tenant}',1,5);
      CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,user_id TEXT,config TEXT,revision INTEGER,tools TEXT,checked_at INTEGER,error TEXT);
      CREATE TABLE mcp_oauth(connection_id TEXT,secret TEXT);INSERT INTO mcp_oauth VALUES('restored-mcp','old-oauth');
      CREATE TABLE policies(tool TEXT);INSERT INTO policies VALUES('mcp_saved'),('bot:mcp_saved'),('some-other-tool');`);
    pending.prepare('INSERT INTO mcp_servers VALUES(?,?,?,3,?,1,NULL)').run('restored-mcp',tenant,sealSecret(master,tenant,'mcp:restored-mcp',{enabled:true,botIds:['bot'],folders:['bot/documents'],requireApproval:false,bearerToken:'owner-private-mcp-token'}),'[{}]');pending.close();
    const backup=await backupEnvironment(data,bundle,tenant,master);
    for(const file of fs.readdirSync(bundle))assert.equal(fs.readFileSync(path.join(bundle,file)).includes(Buffer.from('tenant private content')),false);
    await assert.rejects(restoreEnvironment(bundle,path.join(root,'foreign'),'usr_bbbbbbbb',backup.id,'vol_b',master));
    assert.equal(fs.existsSync(path.join(root,'foreign')),false);
    const target=path.join(root,'restored');await restoreEnvironment(bundle,target,tenant,backup.id,'new_volume',master);
    assert.equal(fs.readFileSync(path.join(target,'files/bot/private.txt'),'utf8'),'tenant private content');assert.equal(fs.existsSync(path.join(target,'runtime-refresh')),false);
    const restored=new Database(path.join(target,'app/swarm.db'));assert.equal(restored.prepare('SELECT count(*) n FROM auth_sessions').get().n,0);
    assert.equal(restored.prepare("SELECT count(*) n FROM agent_jobs WHERE state='uncertain'").get().n,2);
    assert.equal(restored.prepare("SELECT state FROM agent_jobs WHERE id='already-done'").get().state,'completed');
    assert.equal(restored.prepare('SELECT state FROM tool_dispatches').get().state,'uncertain');
    assert.equal(restored.prepare('SELECT status FROM approvals').get().status,'denied');
    assert.equal(restored.prepare('SELECT status FROM messaging_inbox').get().status,'uncertain');
    assert.equal(restored.prepare('SELECT status FROM messaging_messages').get().status,'uncertain');
    assert.deepEqual(restored.prepare('SELECT enabled,revision FROM local_computer_access').get(),{enabled:0,revision:6});
    const mcp=restored.prepare('SELECT * FROM mcp_servers').get(),config=openSecret<any>(master,tenant,'mcp:restored-mcp',mcp.config);
    assert.equal(config.enabled,false);assert.deepEqual(config.botIds,[]);assert.deepEqual(config.folders,[]);assert.equal(config.requireApproval,true);assert.equal(config.bearerToken,'owner-private-mcp-token');assert.equal(mcp.revision,4);assert.equal(mcp.tools,'[]');
    assert.equal(restored.prepare('SELECT count(*) n FROM mcp_oauth').get().n,0);assert.deepEqual(restored.prepare('SELECT tool FROM policies').all(),[{tool:'some-other-tool'}]);
    assert.throws(()=>openSecret(master,'usr_bbbbbbbb','mcp:restored-mcp',mcp.config),/ownership/);restored.close();
    await assert.rejects(restoreEnvironment(bundle,target,tenant,backup.id,'new_volume',master),/already exists/);
    const blob=fs.readFileSync(path.join(bundle,'1.bin'));blob[0]^=1;fs.writeFileSync(path.join(bundle,'1.bin'),blob);
    await assert.rejects(restoreEnvironment(bundle,path.join(root,'tampered'),tenant,backup.id,'new_volume',master));assert.equal(fs.existsSync(path.join(root,'tampered')),false);
    assert.equal(fs.readdirSync(root).some(n=>n.includes('.restoring-')),false);
  }finally{master.fill(0);fs.rmSync(root,{recursive:true,force:true});}
});
