import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { Directory, hashToken } from '../server/src/platform/directory.js';
import { TunnelBroker } from '../server/src/platform/tunnel.js';
import { SessionNotifications, type Revocation } from '../server/src/platform/session-notifications.js';

const url=process.env.TEST_DATABASE_URL;
async function until(check:()=>boolean|Promise<boolean>) {
  for(let i=0;i<500;i++){if(await check())return;await new Promise(done=>setTimeout(done,10));}
  throw new Error('Expected notification state did not arrive.');
}
test('PostgreSQL revocations close relays across platform replicas and fail closed on notification loss',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url}),schema=`test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directories=[new Directory(target.href),new Directory(target.href)],directory=directories[0];await directory.migrate();await directory.migrate();
  const a=await directory.identity('google','notify-a',{name:'A'}),b=await directory.identity('google','notify-b',{name:'B'});
  await directory.pool.query("UPDATE tenants SET state='active',machine_id=id");
  await directory.pool.query("INSERT INTO host_policies(tenant_id,generation,machine_id,desired,observed,acknowledged_revision,reported_at) SELECT id,generation,machine_id,'run','running',1,now() FROM tenants");
  const clients:WebSocket[]=[],servers:ReturnType<typeof createServer>[]=[],notifications:SessionNotifications[]=[],brokers:TunnelBroker[]=[],events:Revocation[][]=[[],[]];
  t.after(async()=>{
    for(const n of notifications)n.stop();for(const ws of clients)ws.terminate();
    await Promise.all(servers.map(s=>new Promise<void>(done=>s.close(()=>done()))));
    await Promise.all(directories.map(d=>d.pool.end()));await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  });
  for(let i=0;i<2;i++){
    const identity={verify:async(token:string)=>{if(token!==a&&token!==b)throw new Error('Invalid identity');return {tenant:token,machine:token,generation:'1'};},sign:async(payload:unknown)=>JSON.stringify(payload)};
    const broker=new TunnelBroker(directories[i],identity as any,['https://swarm.test'],'notification-fixture-shared-key-0123456789');brokers.push(broker);
    const notification=new SessionNotifications(directories[i],event=>{events[i].push(event);if(event.scope)broker.revokeCompanions(event.tenant,event.scope);else broker.revoke(event.tenant,event.session);},ready=>broker.setDirectoryReady(ready));
    notifications.push(notification);await notification.start();
    const server=createServer();servers.push(server);broker.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  }
  async function connect(index:number,tenant=a){
    const port=(servers[index].address() as any).port,ws=new WebSocket(`ws://127.0.0.1:${port}/internal/runtime/tunnel`,{headers:{authorization:`Bearer ${tenant}`}});
    clients.push(ws);await once(ws,'open');return ws;
  }
  async function pending(index:number,raw:string){
    const ws=await connect(index),incoming=once(ws,'message');
    const result=brokers[index].forward(new Request('https://swarm.test/api/me',{headers:{cookie:`swarm_session=${raw}`}}),await directory.session(raw));
    await incoming;return {ws,result};
  }
  await t.test('revocation commits close both replicas, while rollback and other owners leave them untouched',async()=>{
    const raw=await directory.createSession(a,undefined,'shared-browser'),[first,second]=await Promise.all([pending(0,raw),pending(1,raw)]);
    const other=await directory.createSession(b,undefined,'other-browser');await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[hashToken(other)]);
    await until(()=>events.every(items=>items.some(e=>e.tenant===b)));
    assert.equal(first.ws.readyState,WebSocket.OPEN);assert.equal(second.ws.readyState,WebSocket.OPEN);
    const tx=await directory.pool.connect();try{
      await tx.query('BEGIN');await tx.query('DELETE FROM sessions WHERE hash=$1',[hashToken(raw)]);await tx.query('ROLLBACK');
      await new Promise(done=>setTimeout(done,40));assert.equal(events.some(items=>items.some(e=>e.session===hashToken(raw))),false);
    }finally{tx.release();}
    await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[hashToken(raw)]);
    assert.equal((await first.result).status,502);assert.equal((await second.result).status,502);
    assert.ok(events.every(items=>items.some(e=>e.tenant===a&&e.session===hashToken(raw))));
  });
  await t.test('native scope revocation reaches both replicas without revealing a pairing secret',async()=>{
    const token='native-notification-fixture',hash=hashToken(token);
    await directory.pool.query("INSERT INTO companion_routes(hash,tenant_id,scope,generation) VALUES($1,$2,'native-local',1)",[hash,a]);
    const viewers:WebSocket[]=[];
    for(let i=0;i<2;i++){
      const runtime=await connect(i),incoming=once(runtime,'message'),port=(servers[i].address() as any).port;
      const viewer=new WebSocket(`ws://127.0.0.1:${port}/api/companion/local`);clients.push(viewer);viewers.push(viewer);await once(viewer,'open');
      viewer.send(JSON.stringify({type:'hello',version:1,token}));const [message]=await incoming;assert.equal(JSON.parse(message.toString()).type,'socket');
    }
    const closed=viewers.map(ws=>once(ws,'close'));await directory.pool.query('DELETE FROM companion_routes WHERE hash=$1',[hash]);
    for(const result of await Promise.all(closed))assert.equal(result[0],4401);
    assert.ok(events.every(items=>items.some(e=>e.tenant===a&&e.scope==='native-local')));assert.ok(!JSON.stringify(events).includes(token));
  });
  await t.test('host hold broadcasts tenant revocation and closes existing runtime sockets',async()=>{
    const sockets=await Promise.all([connect(0),connect(1)]),closed=sockets.map(ws=>once(ws,'close'));
    await directory.pool.query("UPDATE host_policies SET desired='hold',revision=revision+1 WHERE tenant_id=$1",[a]);
    for(const result of await Promise.all(closed))assert.equal(result[0],4401);
    await directory.pool.query("UPDATE host_policies SET desired='run',revision=revision+1,acknowledged_revision=revision+1 WHERE tenant_id=$1",[a]);
    await until(()=>events.every(items=>items.filter(e=>e.tenant===a&&!e.session&&!e.scope).length===2));
  });
  await t.test('notification disconnect closes pending work and new requests fail until resubscription',async()=>{
    const raw=await directory.createSession(a,undefined,'disconnect-browser'),first=await pending(0,raw),socketClosed=once(first.ws,'close');
    // Match the dedicated listener to this schema rather than touching any
    // other test/service connections in the disposable database.
    const owned=(notifications[0] as any).client;
    const pid=(await owned.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1)',[pid]);
    assert.equal((await first.result).status,502);await socketClosed;assert.equal(brokers[0].ready,false);
    assert.equal((await brokers[0].forward(new Request('https://swarm.test/api/me'),await directory.session(raw))).status,503);
    await until(()=>brokers[0].ready);assert.equal(brokers[1].ready,true);
    const next=await pending(0,raw);await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[hashToken(raw)]);assert.equal((await next.result).status,502);
  });
  await t.test('missing or disabled revocation guards prevent readiness',async()=>{
    const ready:boolean[]=[],watcher=new SessionNotifications(directory,()=>{},value=>ready.push(value));notifications.push(watcher);
    await directory.pool.query('ALTER TABLE sessions DISABLE TRIGGER swarm_session_revocation');
    try {await assert.rejects(watcher.start(),/migrations are required/);assert.ok(ready.length>0&&ready.every(value=>!value));}
    finally {watcher.stop();await directory.pool.query('ALTER TABLE sessions ENABLE TRIGGER swarm_session_revocation');}
  });
});
