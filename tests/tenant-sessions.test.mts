import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Directory, hashToken } from '../server/src/platform/directory.js';
import { TenantSessions, resolveTenantSession, pruneSessionMetadata } from '../server/src/platform/tenant-sessions.js';

const url=process.env.TEST_DATABASE_URL;
test('delegated browser sessions preserve PostgreSQL ownership and platform separation',{skip:!url},async t=>{
  process.env.SESSION_SECRET='delegated-session-fixture-key-0123456789';
  const {signupAdminRoutes}=await import('../server/src/platform/signup-routes.js');
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(target.href);await directory.migrate();await directory.migrate();
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const a=await directory.identity('google','relay-a',{name:'A'}),b=await directory.identity('google','relay-b',{name:'B'});
  await directory.pool.query("UPDATE tenants SET state='active',machine_id=id");
  await directory.pool.query("INSERT INTO host_policies(tenant_id,generation,machine_id,desired,observed,acknowledged_revision,reported_at) SELECT id,generation,machine_id,'run','running',1,now() FROM tenants");
  await directory.pool.query("INSERT INTO account_roles VALUES($1,'admin')",[a]);
  let raw=await directory.createSession(a,undefined,'relay device');
  const owner=()=>({tenant:a,machine:a,generation:'1',session:hashToken(raw)}),relay=new TenantSessions(directory,process.env.SESSION_SECRET),app=signupAdminRoutes(directory);
  await t.test('tenant token cannot sign into platform or exercise administrator authority',async()=>{
    const bound=await relay.bind(owner());assert.notEqual(bound.cookie,raw);assert.equal(bound.hash,hashToken(bound.cookie));
    assert.equal(await directory.session(bound.cookie),null);
    const route=(cookie:string)=>app.request('/api/platform/signup',{headers:{cookie:`swarm_session=${cookie}`}});
    assert.equal((await route(raw)).status,200);assert.equal((await route(bound.cookie)).status,401);
    assert.equal((await resolveTenantSession(directory,owner(),bound.hash))?.hash,hashToken(raw));
    assert.equal(await resolveTenantSession(directory,{tenant:b,generation:'1'},bound.hash),null);
    assert.equal(await resolveTenantSession(directory,{tenant:a,generation:'2'},bound.hash),null);
    assert.equal(await resolveTenantSession(directory,owner(),hashToken(raw)),null);
    assert.equal((await directory.pool.query('SELECT * FROM tenant_sessions')).rowCount,1);
  });
  await t.test('revoked sessions remove their delegation and stale snapshots cannot rebind',async()=>{
    const before=owner(),bound=await relay.bind(before);
    await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[before.session]);
    assert.equal((await directory.pool.query('SELECT * FROM tenant_sessions')).rowCount,0);
    assert.equal(await resolveTenantSession(directory,before,bound.hash),null);await assert.rejects(relay.bind(before),/expired/);
    raw=await directory.createSession(a,undefined,'new device');
    assert.notEqual((await relay.bind(owner())).cookie,bound.cookie);
  });
  for(const change of ['hold','generation','expiry','idle','absolute'])await t.test(`${change} during lock wait blocks delegation`,async()=>{
    const lock=await directory.pool.connect();
    try {
      await lock.query('BEGIN');await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[a]);
      const pending=assert.rejects(relay.bind(owner()),/expired/);
      let waiting=false;
      for(let i=0;i<500;i++){
        if((await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM tenants WHERE id=$1 FOR UPDATE'")).rowCount){waiting=true;break;}
        await new Promise(done=>setTimeout(done,5));
      }
      assert.equal(waiting,true);
      if(change==='hold')await lock.query("UPDATE host_policies SET desired='hold' WHERE tenant_id=$1",[a]);
      if(change==='generation')await lock.query('UPDATE tenants SET generation=2 WHERE id=$1',[a]);
      if(change==='expiry')await lock.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE hash=$1",[owner().session]);
      if(change==='idle')await lock.query("UPDATE sessions SET last_seen_at=clock_timestamp()-interval '25 hours' WHERE hash=$1",[owner().session]);
      if(change==='absolute')await lock.query("UPDATE sessions SET created_at=clock_timestamp()-interval '8 days' WHERE hash=$1",[owner().session]);
      await lock.query('COMMIT');await pending;
    }finally{
      await lock.query('ROLLBACK');lock.release();
      await directory.pool.query("UPDATE tenants SET generation=1 WHERE id=$1",[a]);
      await directory.pool.query("UPDATE host_policies SET desired='run' WHERE tenant_id=$1",[a]);
      raw=await directory.createSession(a,raw,'reset device');
    }
  });
  await t.test('retention removes expired sessions and old generations, preserving active and locked sessions',async()=>{
    const expired=await directory.createSession(a,undefined,'expired'),locked=await directory.createSession(a,undefined,'locked');
    const live=await relay.bind(owner());await relay.bind({...owner(),session:hashToken(expired)});
    await directory.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE hash=ANY($1::text[])",[[hashToken(expired),hashToken(locked)]]);
    const lock=await directory.pool.connect();
    try{
      await lock.query('BEGIN');await lock.query('SELECT hash FROM sessions WHERE hash=$1 FOR UPDATE',[hashToken(locked)]);
      assert.equal((await pruneSessionMetadata(directory)).sessions,1);
      assert.equal((await directory.pool.query('SELECT 1 FROM tenant_sessions WHERE session_hash=$1',[hashToken(expired)])).rowCount,0);
      assert.equal((await directory.pool.query('SELECT 1 FROM sessions WHERE hash=$1',[hashToken(locked)])).rowCount,1);
      assert.equal((await resolveTenantSession(directory,owner(),live.hash))?.hash,owner().session);
    }finally{await lock.query('ROLLBACK');lock.release();}
    assert.equal((await pruneSessionMetadata(directory)).sessions,1);
    await directory.pool.query('UPDATE tenants SET generation=2 WHERE id=$1',[a]);
    await directory.pool.query('UPDATE host_policies SET generation=2 WHERE tenant_id=$1',[a]);
    const next=await relay.bind({...owner(),generation:'2'});
    assert.equal((await pruneSessionMetadata(directory)).delegated,1);
    assert.equal(await resolveTenantSession(directory,owner(),live.hash),null);
    assert.equal((await resolveTenantSession(directory,{...owner(),generation:'2'},next.hash))?.hash,owner().session);
  });
});
