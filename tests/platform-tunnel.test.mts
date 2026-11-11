import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { TunnelBroker } from '../server/src/platform/tunnel.js';
import { FRAME_BYTES, SOCKET_BYTES, decodeFrame } from '../server/src/runtime/tunnel-protocol.js';
import { TenantSessions } from '../server/src/platform/tenant-sessions.js';

const sessionKey = 'fixture-shared-platform-session-key-0123456789';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const sessions = new Map(['a','b'].map(id => [id, { tenant_id:id,hash:hash(id),generation:'1',created_at:new Date(),authenticated_at:new Date(),expires_at:new Date(Date.now()+60000) }]));
  const pairings = new Map<string, {tenant_id:string;scope:string;generation:string}>();
  const query = async(sql:string,args:any[]) => {
    if (sql.includes('companion_routes')) return {rows:pairings.get(args[0])?.scope===args[1]?[pairings.get(args[0])]:[],rowCount:pairings.has(args[0])?1:0};
    if (sql.includes('SELECT s.*')) {
      const row = [...sessions.values()].find(s=>s.hash===args[0]&&s.tenant_id===args[1]&&s.generation===args[2]&&s.expires_at.getTime()>Date.now());
      return {rows:row?[row]:[],rowCount:row?1:0};
    }
    return {rows:[],rowCount:1};
  };
  const directory = { session: async (raw:string) => sessions.get(raw),pool:{query},transaction:async(fn:any)=>fn({query}) };
  const identity = { verify:async(token:string)=>{if(!sessions.has(token))throw new Error('bad identity');return {tenant:token,generation:'1',machine:token};},sign:async(c:unknown)=>JSON.stringify(c) };
  const broker = new TunnelBroker(directory as any, identity as any, ['https://swarm.test'], sessionKey);
  broker.setDirectoryReady(true);
  const server = createServer(); broker.attach(server); server.listen(0, '127.0.0.1'); await once(server,'listening');
  const port = (server.address() as any).port;
  const clients:WebSocket[]=[];
  async function connect(tenant:string) {
    const ws=new WebSocket(`ws://127.0.0.1:${port}/internal/runtime/tunnel`,{headers:{authorization:`Bearer ${tenant}`},maxPayload:FRAME_BYTES});
    clients.push(ws);await once(ws,'open');return ws;
  }
  function forward(tenant='a',signal?:AbortSignal){return broker.forward(new Request('https://swarm.test/api/me',{headers:{cookie:`swarm_session=${tenant}`,'x-swarm-tenant':'b',authorization:'Bearer injected'},signal}),sessions.get(tenant));}
  return {broker,port,connect,forward,clients,pairings,sessions,directory,identity,close:async()=>{for(const w of clients)w.terminate();await new Promise<void>(r=>server.close(()=>r()));}};
}

test('tenant response failure before headers settles the HTTP request',async()=>{
  const f=await fixture();try{const ws=await f.connect('a');ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.type==='request-end')ws.send(JSON.stringify({type:'end',id:m.id}));});
  const r=await f.forward();assert.equal(r.status,502);
  }finally{await f.close();}
});
test('tunnel strips supplied identity headers and respects response credits',async()=>{
  const f=await fixture();try{const ws=await f.connect('a');let credits=0;
    ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.type==='request'){
      assert.equal(m.headers.authorization,undefined);assert.equal(m.headers['x-swarm-tenant'],undefined);
      const cookie=m.headers.cookie.slice('swarm_session='.length);
      assert.notEqual(cookie,'a');assert.equal(JSON.parse(m.authorization).session,hash(cookie));
      assert.equal(f.sessions.has(cookie),false);
      assert.equal(JSON.parse(m.authorization).sub,'a');ws.send(JSON.stringify({type:'head',id:m.id,status:200}));
    }else if(m.type==='credit'){
      credits++;ws.send(JSON.stringify({type:'chunk',id:m.id,data:Buffer.from(`chunk${credits}`).toString('base64')}));
      if(credits===3)ws.send(JSON.stringify({type:'end',id:m.id}));
    }});
    const r=await f.forward();assert.equal(await r.text(),'chunk1chunk2chunk3');assert.equal(credits,3);
    assert.equal(r.headers.get('content-security-policy'),"sandbox; default-src 'none'; frame-ancestors 'none'");
  }finally{await f.close();}
});
test('foreign runtime cannot answer another tenant request and revocation closes it',async()=>{
  const f=await fixture();try{const a=await f.connect('a'),b=await f.connect('b');
    const got=once(a,'message');const result=f.forward();const [raw]=await got;const m=JSON.parse(raw.toString());
    b.send(JSON.stringify({type:'head',id:m.id,status:200}));b.send(JSON.stringify({type:'end',id:m.id}));
    f.broker.revoke('a',hash('a'));assert.equal((await result).status,502);
  }finally{await f.close();}
});
test('viewer relays maximum-size frames within the encoded tunnel frame limit',async()=>{
  const f=await fixture();try{const a=await f.connect('a');
    const incoming=once(a,'message');const viewer=new WebSocket(`ws://127.0.0.1:${f.port}/api/bots/bot_a/screen`,['binary'],{headers:{cookie:'swarm_session=a',origin:'https://swarm.test'}});f.clients.push(viewer);
    await once(viewer,'open');const [raw]=await incoming;const m=JSON.parse(raw.toString());
    const output=once(viewer,'message');const data=Buffer.alloc(SOCKET_BYTES,7);a.send(JSON.stringify({type:'socket-data',id:m.id,data:data.toString('base64'),binary:true}));
    const [received]=await output;assert.deepEqual(received,data);
  }finally{await f.close();}
});
test('frame decoder bounds allocation and rejects non-base64 input',()=>{
  assert.throws(()=>decodeFrame('A'.repeat(1024),1));assert.throws(()=>decodeFrame('!!!!',1024));
  assert.equal(decodeFrame(Buffer.alloc(SOCKET_BYTES).toString('base64'),SOCKET_BYTES).length,SOCKET_BYTES);
});

test('native pairing routes only by a registered owner and exact computer scope',async()=>{
  const f=await fixture();try{
    const a=await f.connect('a');const token='fixture-native-pairing',hash=createHash('sha256').update(token).digest('hex');
    f.pairings.set(hash,{tenant_id:'a',scope:'native-local',generation:'1'});
    const incoming=once(a,'message');const native=new WebSocket(`ws://127.0.0.1:${f.port}/api/companion/local`);f.clients.push(native);await once(native,'open');
    native.send(JSON.stringify({type:'hello',version:1,token}));const [raw]=await incoming;const m=JSON.parse(raw.toString());
    assert.equal(m.path,'/api/companion/local');assert.equal(JSON.parse(m.authorization).sub,'a');assert.equal(JSON.parse(m.authorization).pairing,hash);assert.equal(m.cookie,undefined);
    const wrong=new WebSocket(`ws://127.0.0.1:${f.port}/api/cli-bridge`);f.clients.push(wrong);await once(wrong,'open');const closed=once(wrong,'close');wrong.send(JSON.stringify({type:'hello',version:1,token}));assert.equal((await closed)[0],4401);
    const revoked=once(native,'close');f.broker.revokeCompanions('a','native-local');assert.equal((await revoked)[0],4401);
  }finally{await f.close();}
});

test('delegated sessions are stable across platform replicas and separated by owner, generation and browser session',()=>{
  const first=new TenantSessions({} as any,sessionKey),second=new TenantSessions({} as any,sessionKey);
  assert.equal(first.token('a','1',hash('a')),second.token('a','1',hash('a')));
  const baseline=first.token('a','1',hash('a'));
  for(const [tenant,generation,session] of [['b','1',hash('a')],['a','2',hash('a')],['a','1',hash('b')]])assert.notEqual(first.token(tenant,generation,session),baseline);
  assert.throws(()=>new TenantSessions({} as any,''));
});

test('HTTP body waits recheck revocation even if no local notification was received',async()=>{
  const f=await fixture();try {
    const runtime=await f.connect('a'),frames:any[]=[];runtime.on('message',raw=>frames.push(JSON.parse(raw.toString())));
    let release!:()=>void;
    const body=new ReadableStream<Uint8Array>({start(c){release=()=>{c.enqueue(Buffer.from('{}'));c.close();};}});
    const result=f.broker.forward(new Request('https://swarm.test/api/settings',{method:'POST',body,duplex:'half'} as any),f.sessions.get('a'));
    f.sessions.delete('a');release();
    assert.equal((await result).status,502);assert.equal(frames.some(m=>m.type==='request'),false);
  } finally {await f.close();}
});

test('HTTP revocation cancels a pending body reader without waiting for client completion',async()=>{
  const f=await fixture();try {
    await f.connect('a');const cancelled=defer();
    const body=new ReadableStream<Uint8Array>({cancel(){cancelled.resolve();}});
    const result=f.broker.forward(new Request('https://swarm.test/api/settings',{method:'POST',body,duplex:'half'} as any),f.sessions.get('a'));
    f.broker.revoke('a',hash('a'));assert.equal((await result).status,502);await cancelled.promise;
  } finally {await f.close();}
});

for(const kind of ['http','viewer'] as const)for(const notify of [false,true])test(`${kind} rejects revocation during signing (${notify?'local notification':'directory only'})`,async()=>{
  const f=await fixture(),entered=defer(),release=defer();try {
    const runtime=await f.connect('a'),frames:any[]=[];runtime.on('message',raw=>frames.push(JSON.parse(raw.toString())));
    f.identity.sign=async claims=>{entered.resolve();await release.promise;return JSON.stringify(claims);};
    let result:Promise<Response>|undefined,closed:Promise<any[]>|undefined;
    if(kind==='http')result=f.forward();
    else {
      const viewer=new WebSocket(`ws://127.0.0.1:${f.port}/api/bots/bot_a/screen`,['binary'],{headers:{cookie:'swarm_session=a',origin:'https://swarm.test'}});
      f.clients.push(viewer);viewer.on('error',()=>{});closed=new Promise(resolve=>viewer.once('close',(...args)=>resolve(args)));
    }
    await entered.promise;f.sessions.delete('a');if(notify)f.broker.revoke('a',hash('a'));release.resolve();
    if(result)assert.equal((await result).status,502);else await closed;
    assert.equal(frames.some(m=>m.type==='request'||m.type==='socket'),false);
  } finally {release.resolve();await f.close();}
});

test('viewer uses only a delegated cookie; one-session revocation maps its hash and leaves other sessions open',async()=>{
  const f=await fixture();try {
    const runtime=await f.connect('a'),frames:any[]=[];runtime.on('message',raw=>frames.push(JSON.parse(raw.toString())));
    f.sessions.set('second',{...f.sessions.get('a')!,hash:hash('second')});
    async function viewer(raw:string) {
      const incoming=once(runtime,'message');
      const ws=new WebSocket(`ws://127.0.0.1:${f.port}/api/bots/bot_a/screen`,['binary'],{headers:{cookie:`swarm_session=${raw}`,origin:'https://swarm.test'}});
      f.clients.push(ws);await once(ws,'open');const [frame]=await incoming;
      return {ws,frame:JSON.parse(frame.toString())};
    }
    const a=await viewer('a'),b=await viewer('second'),derived=a.frame.cookie.slice('swarm_session='.length);
    assert.notEqual(derived,'a');assert.equal(JSON.parse(a.frame.authorization).session,hash(derived));
    assert.notEqual(a.frame.cookie,b.frame.cookie);assert.equal(await f.directory.session(derived),undefined);
    const closed=once(a.ws,'close');f.broker.revoke('a',hash('a'));assert.equal((await closed)[0],4401);
    assert.equal(b.ws.readyState,WebSocket.OPEN);
    assert.ok(frames.some(m=>m.type==='revoke'&&m.session===hash(derived)));
  } finally {await f.close();}
});

for(const notify of [false,true])test(`native pairing revocation during signing prevents relay (${notify?'local notification':'directory only'})`,async()=>{
  const f=await fixture(),entered=defer(),release=defer();try{
    const runtime=await f.connect('a'),frames:any[]=[];runtime.on('message',raw=>frames.push(JSON.parse(raw.toString())));
    const token='native-signing-race';f.pairings.set(hash(token),{tenant_id:'a',scope:'native-local',generation:'1'});
    f.identity.sign=async claims=>{entered.resolve();await release.promise;return JSON.stringify(claims);};
    const native=new WebSocket(`ws://127.0.0.1:${f.port}/api/companion/local`);f.clients.push(native);await once(native,'open');const closed=once(native,'close');
    native.send(JSON.stringify({type:'hello',version:1,token}));await entered.promise;
    f.pairings.delete(hash(token));if(notify)f.broker.revokeCompanions('a','native-local');release.resolve();
    assert.equal((await closed)[0],4401);assert.equal(frames.some(m=>m.type==='socket'),false);
  }finally{release.resolve();await f.close();}
});
