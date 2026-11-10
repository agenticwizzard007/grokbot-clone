import { WebSocket } from 'ws';
import { vncAuthResponse } from '../lib/des.js';
import { orgo } from '../orgo.js';
import { screenFor } from './orgo-box.js';
import { viewerClosed, viewerOpened } from '../idle.js';
import { ByteQueue, WatchFilter, browserHandshake } from './rfb.js';

/**
 * Orgo viewer relay: browser <-> our server <-> Orgo websockify.
 * The server performs the RFB handshake upstream with the computer's VNC password
 * (which is root-equivalent and never reaches the browser), then offers the browser
 * an unauthenticated RFB session. In "watch" mode, client input messages
 * (KeyEvent, PointerEvent, ClientCutText) are dropped server-side.
 */

async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void, password: string): Promise<Buffer> {
  await q.read(12); // server ProtocolVersion
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) {
    const len = (await q.read(4)).readUInt32BE();
    throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
  }
  const types = [...(await q.read(n))];
  const choice = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
  if (choice < 0) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([choice]));
  if (choice === 2) {
    const challenge = await q.read(16);
    send(vncAuthResponse(password, challenge));
  }
  const result = (await q.read(4)).readUInt32BE();
  if (result !== 0) {
    let reason = '';
    try { const len = (await q.read(4)).readUInt32BE(); reason = (await q.read(len)).toString(); } catch { /* none */ }
    throw new Error(`VNC auth failed ${reason}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const nameLen = head.readUInt32BE(20);
  const name = await q.read(nameLen);
  return Buffer.concat([head, name]);
}

export async function orgoViewer(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: WebSocket | null = null;
  let piping = false;
  const filter = new WatchFilter();
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    try { upstream?.close(); } catch { /* */ }
  };

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const fwd = mode === 'watch' ? filter.feed(Buffer.from(data)) : Buffer.from(data);
    if (fwd.length && upstream?.readyState === WebSocket.OPEN) upstream.send(fwd);
  });
  client.on('close', () => { viewerClosed(userId); fromClient.close(new Error('client closed')); try { upstream?.close(); } catch { /* */ } });
  viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)

  try {
    const { computerId, screenId } = await screenFor(userId, botId);
    const { password } = await orgo.vncPassword(computerId);
    const upUrl = `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : ''}`;
    upstream = new WebSocket(upUrl, ['binary']);
    upstream.on('message', (data: Buffer) => {
      if (!piping) return fromUp.push(Buffer.from(data));
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    upstream.on('close', (code, reason) => { fromUp.close(new Error(`upstream closed ${code}`)); closeAll(1000, `upstream ${code} ${reason}`); });
    upstream.on('error', (e) => { fromUp.close(e as Error); closeAll(1011, String(e)); });
    await new Promise<void>((res, rej) => { upstream!.once('open', () => res()); upstream!.once('error', rej); });

    const serverInit = await upstreamHandshake(fromUp, (b) => upstream!.send(b), password);
    await browserHandshake(fromClient, (b) => client.send(b), serverInit);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) {
      const fwd = mode === 'watch' ? filter.feed(leftoverClient) : leftoverClient;
      if (fwd.length) upstream.send(fwd);
    }
  } catch (e: any) {
    console.warn('[vnc] relay failed', e?.message ?? e);
    closeAll(1011, String(e?.message ?? e));
  }
}
