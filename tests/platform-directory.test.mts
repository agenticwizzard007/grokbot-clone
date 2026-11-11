import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { Directory, hashToken } from '../server/src/platform/directory.js';
import { RuntimeIdentity } from '../server/src/platform/runtime-identity.js';
import { PgConnectionRegistry } from '../server/src/platform/composio-service.js';

const url=process.env.TEST_DATABASE_URL;
test('PostgreSQL platform ownership, identity rotation and dispatch persistence', {skip:!url}, async t=>{
  const admin=new Pool({connectionString:url});
  const schema=`test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(connection.href);
  try{
    await directory.migrate();await directory.migrate();
    const a=await directory.identity('google','subject-a',{name:'A',email:'shared@example.test'});
    const b=await directory.identity('google','subject-b',{name:'B',email:'shared@example.test'});
    await t.test('equal email claims remain separate and no implicit administrator exists',async()=>{
      assert.notEqual(a,b);assert.equal((await directory.pool.query('SELECT * FROM account_roles')).rowCount,0);
      assert.deepEqual(await Promise.all(Array.from({length:10},()=>directory.identity('google','subject-a',{name:'A'}))),Array(10).fill(a));
    });
    let raw=await directory.createSession(a,undefined,'A device');
    await t.test('session rotation invalidates fixation and expired or idle sessions fail',async()=>{
      const prior=raw;raw=await directory.createSession(a,raw,'A device');assert.equal(await directory.session(prior),null);
      assert.equal((await directory.session(raw)).tenant_id,a);
      await directory.pool.query("UPDATE sessions SET last_seen_at=now()-interval '25 hours' WHERE hash=$1",[hashToken(raw)]);
      assert.equal(await directory.session(raw),null);raw=await directory.createSession(a,raw,'A device');
    });
    await t.test('linking needs the current recent session and refuses another account identity',async()=>{
      await assert.rejects(directory.identity('google','subject-b',{name:'B'},hashToken(raw)),/already_linked/);
      assert.equal(await directory.identity('apple','apple-a',{name:'A'},hashToken(raw)),a);
      await directory.pool.query("UPDATE sessions SET authenticated_at=now()-interval '11 minutes' WHERE hash=$1",[hashToken(raw)]);
      await assert.rejects(directory.identity('openrouter','or-a',{name:'A'},hashToken(raw)),/reauth_required/);
    });
    const keys=await generateKeyPair('EdDSA',{extractable:true});
    const runtime=new RuntimeIdentity(directory,await exportPKCS8(keys.privateKey),await exportSPKI(keys.publicKey));
    await directory.pool.query("UPDATE tenants SET state='active',machine_id=id WHERE id=ANY($1::text[])",[[a,b]]);
    await directory.pool.query("INSERT INTO host_policies(tenant_id,generation,machine_id,desired) SELECT id,generation,machine_id,'run' FROM tenants WHERE id=ANY($1::text[])",[[a,b]]);
    const bootstrap=randomBytes(32).toString('base64url');
    await directory.pool.query("INSERT INTO runtime_credentials(hash,tenant_id,machine_id,generation,kind,expires_at) VALUES($1,$2,$2,1,'bootstrap',now()+interval '1 minute')",[hashToken(bootstrap),a]);
    let access='';
    await t.test('bootstrap is single use and bound to tenant and machine',async()=>{
      await assert.rejects(runtime.exchange(bootstrap,b,b));await assert.rejects(runtime.exchange(bootstrap,a,b));
      const registered=await runtime.exchange(bootstrap,a,a);access=registered.token;assert.equal((await runtime.verify(access)).tenant,a);
      await assert.rejects(runtime.exchange(bootstrap,a,a));const renewed=await runtime.exchange(registered.refresh,a,a);
      await assert.rejects(runtime.exchange(registered.refresh,a,a));assert.equal((await runtime.verify(renewed.token)).tenant,a);
      const successor=randomBytes(32).toString('base64url');
      const first=await runtime.exchange(renewed.refresh,a,a,successor);
      const recovered=await runtime.exchange(renewed.refresh,a,a,successor);assert.equal(first.refresh,recovered.refresh);
      await assert.rejects(runtime.exchange(renewed.refresh,a,a,randomBytes(32).toString('base64url')));
      await runtime.exchange(successor,a,a);await assert.rejects(runtime.exchange(renewed.refresh,a,a,successor));
    });
    const registry=new PgConnectionRegistry(directory);
    await directory.pool.query("INSERT INTO connected_accounts(id,tenant_id,toolkit,state) VALUES('account-a',$1,'gmail','active'),('account-b',$2,'gmail','active')",[a,b]);
    await t.test('foreign IDs, duplicate dispatches and revoked revisions fail before dispatch',async()=>{
      assert.equal(await registry.get(a,'account-b'),undefined);
      assert.equal(await registry.begin(a,'account-b',1,'d','GMAIL_SEND_EMAIL','hash'),false);
      assert.equal(await registry.begin(a,'account-a',1,'d','GMAIL_SEND_EMAIL','hash'),true);
      assert.equal(await registry.begin(a,'account-a',1,'d','GMAIL_SEND_EMAIL','hash'),false);
      await registry.finish(a,'d','uncertain');await registry.revoke(a,'account-a');
      assert.equal(await registry.begin(a,'account-a',1,'another','GMAIL_SEND_EMAIL','hash'),false);
      assert.equal((await directory.pool.query('SELECT state FROM dispatches WHERE tenant_id=$1',[a])).rows[0].state,'uncertain');
    });
    await t.test('deletion immediately revokes sessions, runtime and identity login',async()=>{
      const revoked=await directory.createSession(a,undefined,'Deleted device');
      await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[hashToken(revoked)]);
      await assert.rejects(directory.revokeTenant(a,{sessionHash:hashToken(revoked)}),/reauth_required/);
      const stale=await directory.createSession(a,undefined,'Stale device');
      await directory.pool.query("UPDATE sessions SET authenticated_at=now()-interval '11 minutes' WHERE hash=$1",[hashToken(stale)]);
      await assert.rejects(directory.revokeTenant(a,{sessionHash:hashToken(stale)}),/reauth_required/);
      await assert.rejects(directory.revokeTenant(a,{phone:{channel:'imessage',revision:'1',tokenHash:hashToken('foreign')}}),/reauth_required/);
      assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1',[a])).rows[0].state,'active');
      raw=await directory.createSession(a,raw,'A device');await directory.revokeTenant(a);
      assert.equal(await directory.session(raw),null);await assert.rejects(runtime.verify(access));
      await assert.rejects(directory.createSession(a,undefined,'retry'),/revoked/);
      await assert.rejects(directory.identity('google','subject-a',{name:'A'}),/revoked/);
      assert.equal((await registry.get(b,'account-b'))?.state,'active');
      assert.equal((await directory.pool.query("SELECT state FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='create'",[a])).rows[0].state,'cancelled');
    });
  }finally{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
