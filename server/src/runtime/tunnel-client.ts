import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { importSPKI, jwtVerify } from 'jose';
import { db, now } from '../db.js';
import { tenantId, isTenant } from '../deployment.js';
import { sessionHash, sessionFromCookie, revokeSession, revokeUserSessions } from '../lib/auth.js';
import { BUFFER_BYTES, CHUNK_BYTES, FRAME_BYTES, REQUEST_BYTES, SOCKET_BYTES, decodeFrame } from './tunnel-protocol.js';

interface RequestState {
  id: string; frame: any; verified: Promise<void>; chunks: Buffer[]; size: number; abort: AbortController;
  credit: number; wake?: () => void; socket?: WebSocket; socketQueue: { data: Buffer; binary: boolean }[];
  executing?: boolean;
}
export async function startTenantTunnel(port: number) {
  if (!isTenant) return;
  const endpoint = new URL('/internal/runtime/tunnel', process.env.PLATFORM_URL!);
  if (endpoint.protocol !== 'https:') throw new Error('Runtime gateway requires HTTPS.'); endpoint.protocol = 'wss:';
  const key = await importSPKI(await fs.readFile(process.env.PLATFORM_PUBLIC_KEY_FILE!, 'utf8'),'EdDSA');
  const seen = new Map<string,number>();
  let stopped = false, current: WebSocket | undefined;
  const token = async () => (await fs.readFile(process.env.RUNTIME_TOKEN_FILE!, 'utf8')).trim();
  const verify = async (frame: any, alive: () => boolean) => {
    const { payload } = await jwtVerify(String(frame.authorization),key,{issuer:'swarm-platform',audience:`tenant:${tenantId}`,algorithms:['EdDSA'],maxTokenAge:'60s',requiredClaims:['sub','exp','iat','jti']});
    if (!alive()) throw new Error('Request was revoked during verification.');
    for (const [id,expiry] of seen) if(expiry<now()) seen.delete(id);
    if(payload.sub!==tenantId || String(payload.generation)!==process.env.SWARM_RUNTIME_GENERATION || !payload.jti || seen.has(payload.jti) || seen.size>=10000) throw new Error('Invalid request identity.');
    if(typeof frame.path!=='string'||!frame.path.startsWith('/api/')||frame.path.startsWith('//')||frame.path.includes('\\')) throw new Error('Invalid route.');
    if (payload.pairing) {
      if (frame.type!=='socket' || payload.path!==frame.path || !['/api/companion','/api/companion/local','/api/cli-bridge'].includes(frame.path) || frame.hello?.type!=='hello' || typeof frame.hello.token!=='string' || payload.pairing!==sessionHash(frame.hello.token)) throw new Error('Invalid computer identity.');
      seen.set(payload.jti,(payload.exp??0)*1000);
      return;
    }
    const cookie = frame.cookie ?? frame.headers?.cookie;
    if (payload.session!==sessionHash(sessionFromCookie(cookie)??'') || typeof payload.expiresAt!=='number' || payload.expiresAt<=now() || typeof payload.authenticatedAt!=='number') throw new Error('Invalid session identity.');
    seen.set(payload.jti,(payload.exp??0)*1000);
    db.prepare(`INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET expires_at=excluded.expires_at,last_seen_at=excluded.last_seen_at,authenticated_at=excluded.authenticated_at`)
      .run(payload.session,tenantId,now(),payload.expiresAt,now(),payload.authenticatedAt);
  };
  async function connect() {
    if(stopped)return;
    const ws = current = new WebSocket(endpoint,{headers:{authorization:`Bearer ${await token()}`},maxPayload:FRAME_BYTES});
    const requests = new Map<string,RequestState>();
    const send = (m: unknown) => { if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>BUFFER_BYTES)throw new Error('Tunnel backpressure exceeded.');ws.send(JSON.stringify(m)); };
    const cancel = (id: string) => { const r=requests.get(id); if(r){r.abort.abort();r.wake?.();r.socket?.terminate();requests.delete(id);} };
    const renew = setInterval(()=>{void token().then(value=>send({type:'authenticate',token:value})).catch(()=>ws.terminate());},60_000).unref();
    async function execute(r: RequestState) {
      try {
        await r.verified;
        if (r.abort.signal.aborted) return;
        const response=await fetch(`http://127.0.0.1:${port}${r.frame.path}`,{method:r.frame.method,headers:r.frame.headers,
          body:['GET','HEAD'].includes(r.frame.method)?undefined:Buffer.concat(r.chunks),signal:r.abort.signal,redirect:'manual'});
        r.chunks=[];
        send({type:'head',id:r.id,status:response.status,headers:Object.fromEntries(response.headers)});
        const reader=response.body?.getReader();
        if(reader)try{
          while(!r.abort.signal.aborted){
            const {value,done}=await reader.read();if(done)break;
            for(let offset=0;offset<value.length;offset+=65536){
              if(r.credit<=0)await new Promise<void>(resolve=>{r.wake=resolve;});
              if(r.abort.signal.aborted)throw new Error('Cancelled');
              r.credit--;send({type:'chunk',id:r.id,data:Buffer.from(value.subarray(offset,offset+65536)).toString('base64')});
            }
          }
        }finally{await reader.cancel();}
        send({type:'end',id:r.id});
      }catch{try{send({type:'error',id:r.id});}catch{}}
      finally{cancel(r.id);}
    }
    ws.on('message',raw=>{
      try{
        const m=JSON.parse(raw.toString());
        if(m.type==='revoke') {
          if(typeof m.session==='string')revokeSession(m.session);else revokeUserSessions(tenantId);
          for (const r of requests.values()) {
            const cookie = r.frame.cookie ?? r.frame.headers?.cookie;
            if (!m.session || sessionHash(sessionFromCookie(cookie) ?? '') === m.session) cancel(r.id);
          }
          return;
        }
        if(typeof m.id!=='string'||m.id.length>100)throw new Error('Invalid id');
        if(m.type==='request'||m.type==='socket'){
          if(requests.has(m.id)||requests.size>=32)throw new Error('Request limit');
          const verified=verify(m,()=>requests.has(m.id)&&!stopped&&ws.readyState===WebSocket.OPEN);void verified.catch(()=>{});
          const r: RequestState={id:m.id,frame:m,verified,chunks:[],size:0,abort:new AbortController(),credit:0,socketQueue:[]};requests.set(m.id,r);
          if(m.type==='socket')void(async()=>{
            await verified;
            if(r.abort.signal.aborted)return;
            const socket=r.socket=new WebSocket(`ws://127.0.0.1:${port}${m.path}`,m.protocol==='binary'?['binary']:[],{headers:{...(m.cookie?{cookie:m.cookie}:{}),...(m.origin?{origin:m.origin}:{})},maxPayload:SOCKET_BYTES});
            socket.on('open',()=>{if(m.hello)socket.send(JSON.stringify(m.hello));for(const item of r.socketQueue)socket.send(item.data,{binary:item.binary});r.socketQueue=[];});
            socket.on('message',(data,binary)=>{try{send({type:'socket-data',id:r.id,data:Buffer.from(data as Buffer).toString('base64'),binary});}catch{cancel(r.id);}});
            socket.on('close',()=>{try{send({type:'end',id:r.id});}catch{}cancel(r.id);});socket.on('error',()=>cancel(r.id));
          })().catch(()=>{try{send({type:'end',id:r.id});}catch{}cancel(r.id);});
          return;
        }
        const r=requests.get(m.id);if(!r)return;
        if(m.type==='cancel'){cancel(m.id);return;}
        if(m.type==='credit'){if(r.frame.type!=='request'||++r.credit>1)throw new Error('Invalid credit');r.wake?.();r.wake=undefined;return;}
        if(m.type==='request-chunk'){
          if(r.frame.type!=='request'||r.executing)throw new Error('Invalid request state');
          const bytes=decodeFrame(m.data,CHUNK_BYTES);r.size+=bytes.length;if(r.size>REQUEST_BYTES)throw new Error('Request limit');r.chunks.push(bytes);
        }else if(m.type==='request-end'){
          if(r.frame.type!=='request'||r.executing)throw new Error('Duplicate request execution');
          r.executing=true;void execute(r);
        }
        else if(m.type==='socket-data'){
          if(r.frame.type!=='socket')throw new Error('Invalid socket state');
          const data=decodeFrame(m.data,SOCKET_BYTES);
          if(r.socket?.readyState===WebSocket.OPEN){if(r.socket.bufferedAmount>BUFFER_BYTES)throw new Error('Socket backpressure');r.socket.send(data,{binary:m.binary===true});}
          else{r.size+=data.length;if(r.size>SOCKET_BYTES)throw new Error('Socket startup limit');r.socketQueue.push({data,binary:m.binary===true});}
        }else throw new Error('Invalid frame');
      }catch{ws.terminate();}
    });
    ws.on('error',()=>ws.terminate());
    ws.on('close',()=>{clearInterval(renew);for(const id of requests.keys())cancel(id);revokeUserSessions(tenantId);if(!stopped)setTimeout(()=>void connect().catch(retry),2000+Math.random()*2000).unref();});
  }
  const retry=()=>{if(!stopped)setTimeout(()=>void connect().catch(retry),5000).unref();};
  await connect();
  return ()=>{stopped=true;current?.terminate();};
}
