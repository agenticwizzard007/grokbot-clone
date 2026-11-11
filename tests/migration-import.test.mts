import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {Pool} from 'pg';
import {Directory,hashToken} from '../server/src/platform/directory.js';
import {stageLegacyImport} from '../server/src/platform/migration-import.js';
const url=process.env.TEST_DATABASE_URL;
test('audited legacy imports preserve immutable identity and verified private connections',{skip:!url},async t=>{
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(connection.href);await directory.migrate();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-import-')),snapshot=path.join(root,'source.db');
  t.after(async()=>{fs.rmSync(root,{recursive:true,force:true});await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const source=new Database(snapshot);source.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT);CREATE TABLE google_identities(subject TEXT PRIMARY KEY,user_id TEXT);CREATE TABLE apple_identities(subject TEXT PRIMARY KEY,user_id TEXT);
    INSERT INTO users VALUES('usr_legacy123','Legacy','shared@example.test'),('usr_foreign123','Foreign','other@example.test');
    INSERT INTO google_identities VALUES('verified-subject','usr_legacy123'),('foreign-subject','usr_foreign123');INSERT INTO apple_identities VALUES('apple-subject','usr_legacy123')`);source.close();
  const input={snapshot,snapshotHash:createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex'),tenant:'usr_legacy123',identities:[{provider:'google' as const,subject:'verified-subject'},{provider:'apple' as const,subject:'apple-subject'}],connectionIds:['private-gmail','foreign-gmail']};
  const checked:string[]=[];
  const provider={owned:async(identity:string,id:string)=>{checked.push(identity);return identity===input.tenant&&id==='private-gmail'?{toolkit:'gmail',active:true}:undefined;}};
  await t.test('foreign source bindings and changing snapshots are rejected before registration',async()=>{
    await assert.rejects(stageLegacyImport(directory,provider,{...input,identities:[{provider:'google',subject:'foreign-subject'}]}),/Foreign or unverified/);
    await assert.rejects(stageLegacyImport(directory,provider,{...input,snapshotHash:'0'.repeat(64)}),/snapshot differs/);
    await assert.rejects(stageLegacyImport(directory,provider,{...input,identities:[]}),/audited migration/);
    assert.equal((await directory.pool.query('SELECT 1 FROM tenants')).rowCount,0);
  });
  await t.test('staging imports only remotely attested accounts and leaves routing/provisioning inactive',async()=>{
    const result=await stageLegacyImport(directory,provider,input);
    assert.deepEqual(result.connections,['private-gmail']);assert.deepEqual(result.reconnect,['foreign-gmail']);assert.equal(result.routingChanged,false);
    assert.ok(checked.every(v=>v===input.tenant));assert.equal((await directory.pool.query('SELECT 1 FROM identities')).rowCount,0);
    assert.equal((await directory.pool.query('SELECT 1 FROM lifecycle_jobs')).rowCount,0);
    assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1',[input.tenant])).rows[0].state,'pending');
    await assert.rejects(stageLegacyImport(directory,provider,input),/already exists/);
  });
  await t.test('equal email does not claim the legacy account; authenticated subject retains its ID',async()=>{
    const other=await directory.identity('google','unrelated-subject',{name:'Other',email:'shared@example.test'});
    assert.notEqual(other,input.tenant);const session=await directory.createSession(other,undefined,'Other');
    await assert.rejects(directory.identity('google','verified-subject',{name:'Legacy'},hashToken(session)),/already_linked/);
    assert.equal(await directory.identity('google','verified-subject',{name:'Legacy',email:'changed@example.test'}),input.tenant);
    assert.equal((await directory.pool.query('SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1',[input.tenant])).rowCount,0);
    await directory.pool.query("UPDATE tenants SET state='active' WHERE id=$1",[input.tenant]);
    assert.equal(await directory.identity('apple','apple-subject',{name:'Legacy'}),input.tenant);
    assert.equal((await directory.pool.query('SELECT 1 FROM legacy_identity_claims WHERE tenant_id=$1',[input.tenant])).rowCount,0);
  });
});
