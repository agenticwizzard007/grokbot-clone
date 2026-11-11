import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import type { Directory } from './directory.js';
import type { RuntimeIdentity } from './runtime-identity.js';
import { TenantSessions, type RelayOwner } from './tenant-sessions.js';
import { BUFFER_BYTES, CHUNK_BYTES, FRAME_BYTES, SOCKET_BYTES, decodeFrame, readRequest } from '../runtime/tunnel-protocol.js';

const MAX_BUFFER = BUFFER_BYTES;
const send = (ws: WebSocket, value: unknown) => {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFER) throw new Error('Runtime backpressure limit exceeded.');
  ws.send(JSON.stringify(value));
};
interface Pending { session: string; companion?: { hash: string; scope: string }; receive: (m: any) => void; close: () => void }
interface Tunnel { ws: WebSocket; generation: string; machine: string; requests: Map<string, Pending> }
export class TunnelBroker {
  private tunnels = new Map<string, Tunnel>();
  private directoryReady = false;
  get ready() { return this.directoryReady; }
  setDirectoryReady(ready: boolean) {
    this.directoryReady = ready;
    if (!ready) for (const tunnel of this.tunnels.values()) {
      for (const pending of tunnel.requests.values()) pending.close();
      tunnel.ws.terminate();
    }
  }
  private sessions: TenantSessions;
  constructor(private directory: Directory, private identity: RuntimeIdentity, private origins: string[], sessionKey: string) {
    this.sessions = new TenantSessions(directory, sessionKey);
  }
  private async delegation(owner: RelayOwner, tunnel: Tunnel, alive: () => boolean) {
    const current = () => this.directoryReady && alive() && this.tunnels.get(owner.tenant) === tunnel && tunnel.ws.readyState === WebSocket.OPEN;
    const session = await this.sessions.bind(owner);
    if (!current()) throw new Error('Relay was revoked.');
    const authorization = await this.identity.sign({ sub: owner.tenant, generation: owner.generation, session: session.hash,
      authenticatedAt: session.authenticatedAt, expiresAt: session.expiresAt }, `tenant:${owner.tenant}`);
    const final = await this.sessions.bind(owner);
    if (!current() || final.expiresAt < session.expiresAt || final.authenticatedAt !== session.authenticatedAt || session.expiresAt <= Date.now()) throw new Error('Relay authorization changed.');
    return { authorization, cookie: `swarm_session=${session.cookie}` };
  }
  private async available(tenant:string,tunnel:Tunnel){
    return !!(await this.directory.pool.query(`SELECT 1 FROM tenants t JOIN host_policies p ON p.tenant_id=t.id
      WHERE t.id=$1 AND t.generation=$2 AND t.machine_id=$3 AND t.state='active' AND p.generation=t.generation AND p.machine_id=t.machine_id
      AND p.desired='run' AND p.observed='running' AND p.acknowledged_revision=p.revision AND p.error_code IS NULL
      AND p.reported_at>now()-interval '4 minutes'`,[tenant,tunnel.generation,tunnel.machine])).rowCount;
  }
  attach(server: Server) {
    const runtime = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES });
    const viewers = new WebSocketServer({ noServer: true, maxPayload: SOCKET_BYTES, handleProtocols: p => p.has('binary') ? 'binary' : false });
    server.on('upgrade', async (req, socket, head) => {
      try {
        if (!this.directoryReady) throw new Error('Revocation subscription unavailable.');
        const url = new URL(req.url ?? '/', 'https://platform.invalid');
        if (url.pathname === '/internal/runtime/tunnel') {
          if (req.headers.origin) throw new Error('Browser runtime connections are forbidden.');
          let token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
          const claims = await this.identity.verify(token);
          if (!this.directoryReady) throw new Error('Revocation subscription unavailable.');
          runtime.handleUpgrade(req, socket, head, ws => {
            const previous = this.tunnels.get(claims.tenant); previous?.ws.close(4401, 'Runtime replaced');
            const tunnel: Tunnel = { ws, generation: claims.generation, machine: claims.machine, requests: new Map() };
            this.tunnels.set(claims.tenant, tunnel);
            let checking = false;
            const interval = setInterval(async () => {
              if (checking) return; checking = true;
              try {
                await this.identity.verify(token);
                if(tunnel.requests.size&&!await this.available(claims.tenant,tunnel))throw new Error('Runtime is not ready.');
                for (const [id, p] of tunnel.requests) {
                  const valid = p.companion
                    ? await this.directory.pool.query('SELECT 1 FROM companion_routes WHERE hash=$1 AND tenant_id=$2 AND generation=$3 AND expires_at>now()', [p.companion.hash,claims.tenant,claims.generation])
                    : await this.directory.pool.query("SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>clock_timestamp() AND created_at>clock_timestamp()-interval '7 days' AND last_seen_at>clock_timestamp()-interval '24 hours'", [p.session,claims.tenant]);
                  if (!valid.rowCount) {
                    p.close(); tunnel.requests.delete(id); send(ws,{type:'cancel',id});
                    if (!p.companion) send(ws,{type:'revoke',session:this.sessions.hash(claims.tenant,tunnel.generation,p.session)});
                  }
                }
                ws.ping();
              } catch { ws.terminate(); } finally { checking = false; }
            }, 15_000).unref();
            ws.on('message', async raw => {
              try {
                const m = JSON.parse(raw.toString());
                if (m.type === 'authenticate') {
                  const next = await this.identity.verify(String(m.token));
                  if (next.tenant !== claims.tenant || next.generation !== claims.generation || next.machine !== claims.machine) throw new Error('Runtime substitution.');
                  token = m.token; return;
                }
                if (typeof m.id !== 'string') throw new Error('Invalid request id.');
                tunnel.requests.get(m.id)?.receive(m);
              } catch { ws.terminate(); }
            });
            ws.on('error', () => ws.terminate());
            ws.on('close', () => {
              clearInterval(interval);
              if (this.tunnels.get(claims.tenant) === tunnel) this.tunnels.delete(claims.tenant);
              for (const p of tunnel.requests.values()) p.close();
              tunnel.requests.clear();
            });
          }); return;
        }
        const companionScope = ({'/api/companion':'desktop','/api/companion/local':'native-local','/api/cli-bridge':'cli'} as Record<string,string>)[url.pathname];
        if (companionScope) {
          if (req.headers.origin) throw new Error('Computer pairing requires a native client.');
          viewers.handleUpgrade(req,socket,head,client=>this.acceptCompanion(client,url.pathname,companionScope));
          return;
        }
        if (!/^\/api\/bots\/[^/]+\/screen$/.test(url.pathname)) throw new Error('Unknown websocket.');
        if (req.headers.origin && !this.origins.includes(req.headers.origin)) throw new Error('Invalid origin.');
        const rawSession = req.headers.cookie?.split(/;\s*/).find(s => s.startsWith('swarm_session='))?.slice(14);
        const session = await this.directory.session(rawSession);
        if (!session) throw new Error('Unauthenticated.');
        const t = this.tunnels.get(session.tenant_id);
        if (!t || t.generation !== String(session.generation) || t.requests.size >= 32) throw new Error('Runtime unavailable.');
        const id = randomUUID();
        let client: WebSocket | undefined, ended = false;
        const close = () => {
          if (ended) return; ended = true;
          t.requests.delete(id);
          if (client) client.close(4401,'Session or runtime closed'); else socket.destroy();
          try { send(t.ws,{type:'cancel',id}); } catch {}
        };
        // Register before authorization/signing waits so revocation cannot miss
        // a handshake that has not yet become an upgraded viewer.
        t.requests.set(id, { session: session.hash, close, receive: m => {
            if (!client || ended) return;
            if (m.type === 'socket-data' && typeof m.data === 'string') {
              if (client.bufferedAmount > MAX_BUFFER) return close();
              client.send(decodeFrame(m.data, SOCKET_BYTES), { binary: m.binary === true });
            } else if (m.type === 'end') close();
        } });
        socket.on('close', close);
        try {
          const delegated = await this.delegation({tenant:session.tenant_id,generation:t.generation,machine:t.machine,session:session.hash},t,()=>!ended);
          if (!this.directoryReady || ended || this.tunnels.get(session.tenant_id) !== t || socket.destroyed) return close();
          viewers.handleUpgrade(req, socket, head, ws => {
            client = ws;
            if (ended) return ws.close(4401,'Session closed');
            ws.on('message', (data,binary) => { try { send(t.ws,{type:'socket-data',id,data:Buffer.from(data as Buffer).toString('base64'),binary}); } catch { close(); } });
            ws.on('close', close); ws.on('error', close);
            try { send(t.ws, { type: 'socket', id, path: url.pathname + url.search, ...delegated, origin: req.headers.origin, protocol: 'binary' }); } catch { close(); }
          });
        } catch { close(); }
      } catch { socket.destroy(); }
    });
  }
  private acceptCompanion(client: WebSocket, path: string, scope: string) {
    let receiving = false, ended = false, admitted = false, bound: { t: Tunnel; id: string } | undefined;
    const close = () => {
      if (ended) return; ended = true;
      clearTimeout(timer);
      if (bound) { bound.t.requests.delete(bound.id); try { send(bound.t.ws,{type:'cancel',id:bound.id}); } catch {} }
      client.close(4401,'Computer authorization closed');
    };
    const timer = setTimeout(close,5000).unref();
    client.on('close',close);client.on('error',close);
    client.on('message',async(raw,binary)=>{
      try {
        if (ended) return;
        if (bound && admitted) { send(bound.t.ws,{type:'socket-data',id:bound.id,data:Buffer.from(raw as Buffer).toString('base64'),binary}); return; }
        if (receiving || binary || Buffer.byteLength(raw as Buffer)>16384) throw new Error('Invalid computer handshake.');
        receiving=true;
        const hello=JSON.parse(raw.toString());
        if (hello.type!=='hello'||typeof hello.token!=='string'||hello.token.length>256) throw new Error('Invalid pairing proof.');
        const hash=createHash('sha256').update(hello.token).digest('hex');
        const lookup = async () => (await this.directory.pool.query(`SELECT c.* FROM companion_routes c JOIN tenants t ON t.id=c.tenant_id
          JOIN host_policies p ON p.tenant_id=t.id
          WHERE c.hash=$1 AND c.scope=$2 AND c.generation=t.generation AND c.expires_at>clock_timestamp() AND t.state='active'
          AND p.generation=t.generation AND p.machine_id=t.machine_id AND p.desired='run' AND p.observed='running'
          AND p.acknowledged_revision=p.revision AND p.error_code IS NULL AND p.reported_at>clock_timestamp()-interval '4 minutes'`,[hash,scope])).rows[0];
        const owner=await lookup();
        const t: Tunnel | undefined=owner ? this.tunnels.get(owner.tenant_id) : undefined;
        if (!t || t.generation!==String(owner.generation) || t.requests.size>=32 || ended || client.readyState!==WebSocket.OPEN) throw new Error('Computer unavailable.');
        const id=randomUUID();
        bound={t,id};
        t.requests.set(id,{session:'',companion:{hash,scope},close,receive:m=>{
          if(m.type==='socket-data'){
            if(client.bufferedAmount>MAX_BUFFER)return close();
            client.send(decodeFrame(m.data,SOCKET_BYTES),{binary:m.binary===true});
          }else close();
        }});
        const authorization=await this.identity.sign({sub:owner.tenant_id,generation:String(owner.generation),pairing:hash,path},`tenant:${owner.tenant_id}`);
        const final=await lookup();
        if(!this.directoryReady || ended || client.readyState!==WebSocket.OPEN || this.tunnels.get(owner.tenant_id)!==t || !final || final.tenant_id!==owner.tenant_id || String(final.generation)!==t.generation) return close();
        admitted=true;clearTimeout(timer);
        send(t.ws,{type:'socket',id,path,authorization,hello});
      } catch { close(); }
    });
  }
  revokeCompanions(tenant: string, scope: string) {
    const t=this.tunnels.get(tenant);if(!t)return;
    for(const p of t.requests.values())if(p.companion?.scope===scope)p.close();
  }
  revoke(tenant: string, session?: string) {
    const t = this.tunnels.get(tenant); if (!t) return;
    for (const [id,p] of t.requests) if (!session || session === p.session) { p.close(); t.requests.delete(id); }
    try { send(t.ws,{type:'revoke',session:session ? this.sessions.hash(tenant,t.generation,session) : undefined}); } catch { t.ws.terminate(); }
    if (!session) t.ws.close(4401,'Tenant revoked');
  }
  async forward(request: Request, session: any) {
    const t = this.tunnels.get(session.tenant_id);
    if (!this.directoryReady || !t || t.generation !== String(session.generation)) return Response.json({ error: 'Your private environment is starting.' }, {status:503,headers:{'retry-after':'3'}});
    if (t.requests.size >= 32) return Response.json({error:'Your environment is busy.'},{status:429});
    const id = randomUUID(), cancellation = new AbortController();
    const url = new URL(request.url), headers: Record<string,string> = {};
    // Never forward incoming internal identities, Host, forwarding headers, or provider bearer credentials.
    for (const key of ['content-type','accept','origin','user-agent','sec-fetch-site']) { const v = request.headers.get(key); if (v) headers[key] = v; }
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let headReceived = false, ended = false, credit = false;
    const grantCredit = () => {
      if (headReceived && !ended && !credit && (controller?.desiredSize ?? 0) > 0) {
        credit = true;
        send(t.ws, { type: 'credit', id });
      }
    };
    let close: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      pull() { try { grantCredit(); } catch { close(); } },
      cancel() { close(); },
    });
    return new Promise<Response>(resolve => {
      const timeout = setTimeout(() => close(), 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        t.requests.delete(id);
        request.signal.removeEventListener('abort', close);
      };
      close = () => {
        if (ended) return;
        ended = true;
        cancellation.abort();
        cleanup();
        controller?.error(new Error('Runtime disconnected.'));
        if (!headReceived) resolve(Response.json({ error: 'Your environment could not complete this request.' }, { status: 502, headers: { 'cache-control': 'no-store' } }));
        try { send(t.ws, { type: 'cancel', id }); } catch {}
      };
      t.requests.set(id, { session: session.hash, close, receive: m => {
        if (ended) return;
        try {
          if (m.type === 'head') {
            if (headReceived || !Number.isInteger(m.status) || m.status < 200 || m.status > 599) return close();
            const responseHeaders = new Headers({ 'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
              'content-security-policy':"sandbox; default-src 'none'; frame-ancestors 'none'" });
            for (const key of ['content-type','content-disposition']) if (typeof m.headers?.[key] === 'string') responseHeaders.set(key,m.headers[key]);
            const response = new Response(request.method === 'HEAD' || [204,205,304].includes(m.status) ? null : body, { status:m.status,headers:responseHeaders });
            headReceived = true;
            clearTimeout(timeout);
            resolve(response);
            grantCredit();
          } else if (m.type === 'chunk') {
            if (!headReceived || !credit) return close();
            credit = false;
            controller?.enqueue(decodeFrame(m.data, CHUNK_BYTES));
            grantCredit();
          } else if (m.type === 'end') {
            if (!headReceived) return close();
            ended = true;
            cleanup();
            controller?.close();
          } else close();
        } catch { close(); }
      }});
      request.signal.addEventListener('abort', close, { once: true });
      if (request.signal.aborted) return close();
      void (async () => {
        let bytes: Buffer;
        try { bytes = await readRequest(request,cancellation.signal); }
        catch { if (!ended) { resolve(new Response(null,{status:413})); close(); } return; }
        if (ended) return;
        const delegated = await this.delegation({tenant:session.tenant_id,generation:t.generation,machine:t.machine,session:session.hash},t,()=>!ended);
        if (!this.directoryReady || ended || this.tunnels.get(session.tenant_id) !== t) return close();
        headers.cookie = delegated.cookie;
        send(t.ws,{type:'request',id,path:url.pathname+url.search,method:request.method,headers,authorization:delegated.authorization});
        for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES) send(t.ws,{type:'request-chunk',id,data:bytes.subarray(offset,offset+CHUNK_BYTES).toString('base64')});
        send(t.ws,{type:'request-end',id});
      })().catch(close);
    });
  }
}
