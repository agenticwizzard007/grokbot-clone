import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { isTenant, tenantId } from '../deployment.js';
import { hub } from '../lib/hub.js';
import { getLive } from '../store.js';

// Loaded lazily: idle.ts imports the agent loop, which imports the provider index (keeps the static import graph acyclic).
const idle = () => import('../idle.js');
import { sha256, token as randomToken } from '../lib/ids.js';
import type { ComputerState, LibraryFile } from '../types.js';
import { ByteQueue, browserHandshake, jpegSize, jpegUpdate, msgLength, RFB_DESKTOP_SIZE, RFB_TIGHT, serverInit } from './rfb.js';
import { ComputerError, type BotScreen, type BrowserResult, type ComputerProvider, type Shot } from './types.js';
import { decodeCompanionFrame } from './frames.js';
import { localAccess } from './local-access.js';
import { currentUserId, withUsage } from '../usage-context.js';
import { assertLegacyWorkOpen, legacyWorkHeld } from '../security/legacy-work.js';

/**
 * Local computers: a Chrome browser on the user's own PC, driven through the companion
 * program (companion/swarm-companion.mjs). The companion connects *out* to this server
 * over a WebSocket and authenticates with a pairing token, so the PC needs no open ports.
 * Each Bot gets its own Chrome profile on the PC. There is no desktop and no shell.
 *
 * Full-desktop mode (COMPUTER_PROVIDER=desktop, companion started with --desktop): Bots instead use
 * the PC's real screen, mouse and keyboard, its default browser, and a shell. There is one desktop,
 * so one Bot at a time acts on it (see takeDesktop); the others wait their turn.
 *
 * Wire protocol (JSON text frames):
 *   companion -> server  {type:'hello', token, name, platform, version, headless, width, height}
 *   server -> companion  {type:'welcome'}                               (or close 4401 bad token)
 *   server -> companion  {id, method, params}                           request (params.botId)
 *   companion -> server  {id, result} | {id, error}                     response
 *   server -> companion  {method:'input', params}                       viewer input, no reply
 *   companion -> server  {event:'frame', botId, data}                   screencast JPEG (base64)
 *   companion -> server  {event:'browsers', bots:[botId...]}            which Bots have a browser open
 */

// Existing VM/browser tokens remain in the default scope. Native Macs use a separate channel.
for (const sql of [
  'ALTER TABLE companion_tokens ADD COLUMN vm_id TEXT',
  "ALTER TABLE companion_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'",
  'ALTER TABLE companion_tokens ADD COLUMN expires_at INTEGER',
]) { try { db.exec(sql); } catch { /* migrated */ } }

function createLocalBackend(DEVICE: boolean) {
const SCOPE = DEVICE ? 'native-local' : 'default';
/** Bots use the PC's full desktop and a shell (COMPUTER_PROVIDER=desktop). */
const DESKTOP = DEVICE || env.localDesktop;
/** Isolated tenants and legacy cloud VMs each run one virtual screen per Bot. */
const MULTI = !DEVICE && (env.computerProvider === 'cloudvm' || isTenant && env.computerProvider === 'local');
const OFFLINE = DEVICE
  ? "Your Mac is offline. Open the Swarm desktop app and start Mac Control. Actions will wait for your Mac; they will not move to a cloud computer."
  : MULTI
  ? "Your Bots' computer isn't running yet. It starts on its own; try again in a moment."
  : "Your PC isn't connected. Open Settings → Computer, then run the connect command on your PC.";

const PROTOCOL_VERSION = 1;

interface Frame { data: Buffer; width: number; height: number }

interface Companion {
  ws: WebSocket;
  userId: string;
  tokenHash: string;
  welcomeSent: boolean;
  welcomeAcknowledged: boolean;
  device: { name: string; platform: string; version: string; headless: boolean; desktop: boolean; browser: boolean };
  width: number;
  height: number;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** botId -> last used (ms) for Bots with an open browser. */
  browsers: Map<string, number>;
  /** botId -> frame listeners (live viewers). */
  viewers: Map<string, Map<(f: Frame) => void, 'watch' | 'control'>>;
  onClose: Set<() => void>;
}

const companions = new Map<string, Companion>();
const companionWaiters = new Map<string, Set<() => void>>();

const safeBotId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

function state(userId: string): ComputerState {
  const c = companions.get(userId);
  return {
    status: c ? 'running' : 'absent',
    orgoId: null,
    error: null,
    screens: c ? [...c.browsers.keys()].map((botId) => ({ botId, screenId: 'browser' })) : [],
    provider: 'local',
    device: c ? { name: c.device.name, platform: c.device.platform } : null,
    desktop: DESKTOP,
  };
}

/** The computer state the UI sees; cloudvm.ts replaces it with the VM's own state. */
let stateOf: (userId: string) => ComputerState = state;
function setComputerStateSource(fn: (userId: string) => ComputerState) { stateOf = fn; }
const emitState = (userId: string) => {
  if (legacyWorkHeld(userId)) return;
  // Status emissions are background observations, not commands in a possibly revoked turn.
  withUsage({ userId, botId: null }, () => hub.emit(userId, { type: 'computer', state: stateOf(userId) }));
};

/** Is this user's companion (PC or cloud VM) connected right now? */
const companionConnected = (userId: string) => companions.has(userId);

/** Live host readiness, bound to this boot's default-scope token and the actual welcome exchange. */
function tenantCompanionReady(expectedTokenHash: string): boolean {
  if (!isTenant || DEVICE || !MULTI) return false;
  const c = companions.get(tenantId);
  if (!c || c.ws.readyState !== WebSocket.OPEN || !c.welcomeAcknowledged || c.tokenHash !== expectedTokenHash || legacyWorkHeld(tenantId)) return false;
  return !!db.prepare('SELECT 1 FROM companion_tokens WHERE token_hash=? AND user_id=? AND scope=? AND (expires_at IS NULL OR expires_at>?)')
    .get(expectedTokenHash, tenantId, SCOPE, now());
}

/** Wait until the user's companion connects (a cloud VM finishing boot or resume). */
async function waitForCompanion(userId: string, timeoutMs: number): Promise<boolean> {
  if (companions.has(userId)) return true;
  return new Promise((resolve) => {
    let waiters = companionWaiters.get(userId);
    if (!waiters) companionWaiters.set(userId, (waiters = new Set()));
    const finish = () => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) companionWaiters.delete(userId);
      resolve(companions.has(userId));
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
}

/** Disconnect a user's companion now (its VM was frozen or deleted, so it can't answer a close handshake). */
function dropCompanion(userId: string, reason = 'computer stopped') {
  const c = companions.get(userId);
  if (c) {
    console.log(`[local] dropping companion user=${userId}: ${reason}`);
    forget(c);
    c.ws.terminate();
  }
  for (const finish of [...companionWaiters.get(userId) ?? []]) finish();
  emitState(userId);
}

// Invalidate immediately, before the asynchronous WebSocket close handshake completes.
function forget(c: Companion) {
  if (companions.get(c.userId) === c) companions.delete(c.userId);
  for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new ComputerError('Your computer disconnected or access was revoked.', 503)); }
  c.pending.clear();
  for (const fn of [...c.onClose]) fn();
  c.onClose.clear();
}

function need(userId: string): Companion {
  assertLegacyWorkOpen(userId);
  const c = companions.get(userId);
  if ((DEVICE && !localAccess(userId).enabled) || !c || c.ws.readyState !== WebSocket.OPEN) throw new ComputerError(OFFLINE, 409);
  return c;
}

function call<T = any>(userId: string, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  let c: Companion;
  try { c = need(userId); } catch (e) { return Promise.reject(e); }
  const id = ++c.nextId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(new ComputerError(`Your PC didn't respond in time (${method}).`, 504));
    }, timeoutMs);
    c.pending.set(id, { resolve, reject, timer });
    c.ws.send(JSON.stringify({ id, method, params }));
  });
}

function notify(userId: string, method: string, params: Record<string, unknown>) {
  try { need(userId).ws.send(JSON.stringify({ method, params })); } catch { /* revoked or offline */ }
}

function touch(userId: string, botId: string) {
  const c = companions.get(userId);
  if (!c) return;
  const had = c.browsers.has(botId);
  c.browsers.set(botId, now());
  if (!had) emitState(userId);
}

// ---------- pairing ----------

/** Create a pairing token for the user's PC. Only its hash is stored. */
function createPairing(userId: string, vmId: string | null = null): string {
  const t = `swc_${randomToken()}`;
  db.prepare('INSERT INTO companion_tokens(token_hash,user_id,created_at,vm_id,scope,expires_at) VALUES (?,?,?,?,?,?)')
    .run(sha256(t), userId, now(), vmId, SCOPE, DEVICE ? now() + 10 * 60_000 : null);
  return t;
}

/** Revoke a cloud VM's tokens (the VM is being destroyed or replaced). */
function revokeVmTokens(vmId: string) {
  db.prepare('DELETE FROM companion_tokens WHERE vm_id=? AND scope=?').run(vmId, SCOPE);
}

/** Revoke every pairing token for the user and disconnect their PC. */
function revokePairings(userId: string): number {
  const n = db.prepare('DELETE FROM companion_tokens WHERE user_id=? AND scope=?').run(userId, SCOPE).changes;
  const c = companions.get(userId);
  if (c) { forget(c); c.ws.close(4401, 'pairing revoked'); }
  holders.delete(userId);
  emitState(userId);
  return n;
}

function pairingInfo(userId: string) {
  const r = db.prepare('SELECT COUNT(*) n, MAX(last_seen_at) seen FROM companion_tokens WHERE user_id=? AND scope=? AND (expires_at IS NULL OR expires_at>?)').get(userId, SCOPE, now()) as any;
  return { paired: r.n > 0, lastSeenAt: r.seen ?? null };
}

// ---------- companion connections ----------

function attachCompanionSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== (DEVICE ? '/api/companion/local' : '/api/companion')) return;
    wss.handleUpgrade(req, socket, head, (ws) => onCompanion(ws));
  });
}

function onCompanion(ws: WebSocket) {
  let comp: Companion | null = null;
  let alive = true;
  const helloTimer = setTimeout(() => ws.close(4400, 'expected hello'), 10_000);
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, 25_000);
  ws.on('pong', () => { alive = true; });

  const frame = (botId: string, data: Buffer) => {
    const subs = comp?.viewers.get(botId);
    if (!comp || !subs?.size) return;
    const size = jpegSize(data) ?? { width: comp.width, height: comp.height };
    for (const fn of subs.keys()) fn({ data, ...size });
  };
  ws.on('message', (raw, isBinary) => {
    alive = true;
    if (isBinary) {
      if (!comp) return ws.close(4400, 'expected hello');
      const decoded = decodeCompanionFrame(Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw));
      if (decoded) frame(decoded.botId, decoded.jpeg);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!comp) {
      if (msg?.type !== 'hello' || typeof msg.token !== 'string') return ws.close(4400, 'expected hello');
      const hash = sha256(msg.token);
      const row = db.prepare('SELECT user_id FROM companion_tokens WHERE token_hash=? AND scope=? AND (expires_at IS NULL OR expires_at>?)').get(hash, SCOPE, now()) as any;
      if (isTenant && row?.user_id !== tenantId) return ws.close(4401, 'invalid token');
      if (!row || legacyWorkHeld(row.user_id) || (DEVICE && !localAccess(row.user_id).enabled)) return ws.close(4401, 'invalid token');
      if (DEVICE && (msg.mode !== 'desktop' || msg.desktop !== true || !String(msg.platform).startsWith('darwin'))) return ws.close(4403, 'This pairing requires the Swarm Mac desktop companion.');
      clearTimeout(helloTimer);
      if (MULTI && msg.mode !== 'multi') return ws.close(4403, 'This Swarm runs Bots on cloud VMs; only the VM companion (--multi) can connect.');
      if (!MULTI && msg.mode === 'multi') return ws.close(4403, 'This Swarm does not use cloud VMs; start the companion without --multi.');
      if (DESKTOP && msg.desktop !== true) return ws.close(4403, 'This Swarm gives Bots your full desktop. Update the companion and start it with --desktop.');
      db.prepare('UPDATE companion_tokens SET last_seen_at=?, expires_at=NULL WHERE token_hash=?').run(now(), hash);
      // One PC per user: a new connection replaces the old one.
      const old = companions.get(row.user_id);
      if (old) { forget(old); old.ws.close(4409, 'replaced by a newer connection'); }
      comp = {
        ws,
        userId: row.user_id,
        tokenHash: hash,
        welcomeSent: false,
        welcomeAcknowledged: false,
        device: {
          name: String(msg.name ?? 'My PC').slice(0, 80),
          platform: String(msg.platform ?? '').slice(0, 40),
          version: String(msg.version ?? '').slice(0, 20),
          headless: msg.headless !== false,
          desktop: msg.desktop === true,
          browser: msg.capabilities?.browser === true,
        },
        width: Number(msg.width) || 1280,
        height: Number(msg.height) || 800,
        nextId: 0,
        pending: new Map(),
        browsers: new Map(),
        viewers: new Map(),
        onClose: new Set(),
      };
      companions.set(row.user_id, comp);
      for (const finish of companionWaiters.get(row.user_id) ?? []) finish();
      const registered = comp;
      ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, binaryFrames: true, mode: MULTI ? 'multi' : DESKTOP ? 'desktop' : 'browser' }), error => {
        if (error) { forget(registered); ws.terminate(); return; }
        registered.welcomeSent = true;
      });
      console.log(`[local] PC connected user=${row.user_id} name="${comp.device.name}" platform=${comp.device.platform} headless=${comp.device.headless}`);
      emitState(row.user_id);
      return;
    }
    if (companions.get(comp.userId) !== comp) return;
    if (typeof msg.id === 'number') {
      const p = comp.pending.get(msg.id);
      if (!p) return;
      comp.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ComputerError(String(msg.error).slice(0, 500), 502));
      else p.resolve(msg.result ?? {});
    } else if (msg.event === 'frame' && typeof msg.botId === 'string' && typeof msg.data === 'string') {
      frame(msg.botId, Buffer.from(msg.data, 'base64'));
    } else if (msg.event === 'browsers' && Array.isArray(msg.bots)) {
      // The real companion sends its browser inventory only after accepting welcome.
      // No persistent readiness file can survive disconnect, replacement or token revocation.
      if (comp.welcomeSent && msg.bots.every((id: unknown) => typeof id === 'string' && safeBotId(id))) comp.welcomeAcknowledged = true;
      const open = new Set(msg.bots.filter((b: unknown) => typeof b === 'string'));
      for (const b of [...comp.browsers.keys()]) if (!open.has(b)) comp.browsers.delete(b);
      for (const b of open as Set<string>) if (!comp.browsers.has(b)) comp.browsers.set(b, now());
      emitState(comp.userId);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(ping);
    if (!comp) return;
    const wasCurrent = companions.get(comp.userId) === comp;
    forget(comp);
    if (wasCurrent) emitState(comp.userId);
  });
  ws.on('error', () => { /* close follows */ });
}

// ---------- live viewer: an RFB server fed by the browser's screencast ----------

async function viewer(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  let comp: Companion;
  try { comp = need(userId); } catch { client.close(1011, 'Your computer is offline'); return; }
  const revision = localAccess(userId).revision;
  const fromClient = new ByteQueue();
  let ready = false;
  let pending = Buffer.alloc(0);
  let fbW = comp.width;
  let fbH = comp.height;
  let tight = false;
  let resizable = false;
  let wantUpdate = false;
  let fresh = false;
  let latest: Frame | null = null;
  let closed = false;
  let prevMask = 0;
  let lastPress = { t: 0, x: -99, y: -99, count: 0 };
  let lastMove = 0;

  const send = (b: Buffer) => { if (client.readyState === WebSocket.OPEN) client.send(b); };
  const input = (params: Record<string, unknown>) => {
    if (closed || client.readyState !== WebSocket.OPEN || companions.get(userId) !== comp || localAccess(userId).revision !== revision) return;
    touch(userId, botId);
    notify(userId, 'input', { botId, ...params, width: fbW, height: fbH });
  };

  let sendingFrame = false;
  const flush = () => {
    if (!wantUpdate || !fresh || !latest || !tight || sendingFrame || client.readyState !== WebSocket.OPEN) return;
    const f = latest;
    const resize = (f.width !== fbW || f.height !== fbH) && resizable;
    if (resize) { fbW = f.width; fbH = f.height; }
    wantUpdate = false;
    fresh = false;
    sendingFrame = true;
    client.send(jpegUpdate(f.data, f.width, f.height, resize), () => { sendingFrame = false; flush(); });
  };
  const onFrame = (f: Frame) => { latest = f; fresh = true; flush(); };

  let counted = false;
  const viewerMode = (subs: Map<(f: Frame) => void, 'watch' | 'control'>) => [...subs.values()].includes('control') ? 'control' : 'watch';
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (counted) void idle().then((m) => m.viewerClosed(userId));
    fromClient.close(new Error('closed'));
    const subs = comp.viewers.get(botId);
    const previousMode = subs && viewerMode(subs);
    subs?.delete(onFrame);
    if (subs && !subs.size) {
      comp.viewers.delete(botId);
      if (companions.get(userId) === comp) call(userId, 'screencast.stop', { botId }, 10_000).catch(() => {});
    } else if (subs && viewerMode(subs) !== previousMode && companions.get(userId) === comp) {
      call(userId, 'screencast.start', { botId, mode: viewerMode(subs) }, 10_000).catch(() => {});
    }
    comp.onClose.delete(onCompanionGone);
  };
  const onCompanionGone = () => { try { client.close(1011, 'Your PC disconnected'); } catch { /* */ } cleanup(); };
  comp.onClose.add(onCompanionGone);

  const pointer = (mask: number, x: number, y: number) => {
    const buttons = (mask & 1 ? 1 : 0) | (mask & 4 ? 2 : 0) | (mask & 2 ? 4 : 0);
    if (mask & 8 && !(prevMask & 8)) input({ kind: 'wheel', x, y, deltaY: -120 });
    if (mask & 16 && !(prevMask & 16)) input({ kind: 'wheel', x, y, deltaY: 120 });
    const changed = (mask ^ prevMask) & 7;
    for (const [bit, button] of [[1, 'left'], [2, 'middle'], [4, 'right']] as const) {
      if (!(changed & bit)) continue;
      const down = !!(mask & bit);
      if (down) {
        const t = Date.now();
        const again = t - lastPress.t < 400 && Math.abs(x - lastPress.x) < 6 && Math.abs(y - lastPress.y) < 6;
        lastPress = { t, x, y, count: again ? Math.min(lastPress.count + 1, 3) : 1 };
      }
      input({ kind: 'mouse', type: down ? 'mousePressed' : 'mouseReleased', x, y, button, buttons, clickCount: lastPress.count });
    }
    if (!changed && !(mask & 24)) {
      const t = Date.now();
      if (buttons || t - lastMove > 30) { lastMove = t; input({ kind: 'mouse', type: 'mouseMoved', x, y, button: 'none', buttons }); }
    }
    prevMask = mask;
  };

  const handle = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (!pending.length) return;
      const len = msgLength(pending);
      if (len === -1) { client.close(1003, 'unsupported message'); return; }
      if (len === 0 || pending.length < len) return;
      const m = pending.subarray(0, len);
      pending = pending.subarray(len);
      switch (m[0]) {
        case 2: { // SetEncodings
          const encs: number[] = [];
          for (let i = 0; i < m.readUInt16BE(2); i++) encs.push(m.readInt32BE(4 + 4 * i));
          tight = encs.includes(RFB_TIGHT);
          resizable = encs.includes(RFB_DESKTOP_SIZE);
          if (!tight) client.close(1003, 'viewer must support Tight encoding');
          break;
        }
        case 3: // FramebufferUpdateRequest
          wantUpdate = true;
          if (m[1] === 0) fresh = true; // non-incremental: resend the current frame
          flush();
          break;
        case 4: // KeyEvent
          if (mode === 'control') input({ kind: 'key', down: m[1] === 1, keysym: m.readUInt32BE(4) });
          break;
        case 5: // PointerEvent
          if (mode === 'control') pointer(m[1], m.readUInt16BE(2), m.readUInt16BE(4));
          break;
        default: // SetPixelFormat, ClientCutText, fences...: not needed for JPEG frames
          break;
      }
    }
  };

  client.on('message', (data: Buffer) => { if (!ready) fromClient.push(Buffer.from(data)); else handle(Buffer.from(data)); });
  client.on('close', cleanup);

  try {
    // A connected VM can still have a cold desktop. Attach Playwright to its visible Chrome
    // before exposing the screen; listing tabs preserves the user's current page and form state.
    if (MULTI) {
      const browser = await call<BrowserResult>(userId, 'browser', { botId, tool: 'browser_tabs', args: { action: 'list' } }, 90_000);
      if (browser.isError) throw new ComputerError('Chrome could not get ready. Reconnect to try again.');
    }
    if (closed) return;
    // Open (or reuse) the Bot's browser and grab a first frame before the client asks for one.
    const first = await call<{ data: string }>(userId, 'screenshot', { botId }, 45_000);
    if (closed) return;
    touch(userId, botId);
    const data = Buffer.from(first.data, 'base64');
    const size = jpegSize(data) ?? { width: comp.width, height: comp.height };
    latest = { data, ...size };
    fresh = true;
    fbW = size.width;
    fbH = size.height;
    await browserHandshake(fromClient, send, serverInit(fbW, fbH, MULTI ? 'Bot screen' : `${comp.device.name} ${DESKTOP ? 'desktop' : 'browser'}`));
    ready = true;
    void idle().then((m) => m.viewerOpened(userId));
    counted = true;
    handle(fromClient.takeAll());
    let subs = comp.viewers.get(botId);
    if (!subs) { subs = new Map(); comp.viewers.set(botId, subs); }
    const firstViewer = subs.size === 0;
    const previousMode = viewerMode(subs);
    subs.set(onFrame, mode);
    if (firstViewer || viewerMode(subs) !== previousMode) await call(userId, 'screencast.start', { botId, mode: viewerMode(subs) }, 20_000);
  } catch (e: any) {
    if (!closed) {
      console.warn('[local] viewer failed', e?.message ?? e);
      try { client.close(1011, String(e?.message ?? e).slice(0, 120)); } catch { /* */ }
    }
    cleanup();
  }
}

// ---------- the provider ----------

const filesRoot = (botId: string) => {
  if (!safeBotId(botId)) throw new ComputerError('bad bot id', 400);
  return path.join(env.filesDir, botId);
};

function inside(root: string, rel: string) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new ComputerError('bad path', 400);
  return p;
}

const toShot = (r: { data: string; width?: number; height?: number }): Shot => {
  const data = Buffer.from(r.data, 'base64');
  const size = jpegSize(data);
  return { image: r.data, mime: 'image/jpeg', width: size?.width ?? r.width ?? 1280, height: size?.height ?? r.height ?? 800 };
};

// ---------- full desktop: one screen for every Bot, so one Bot at a time ----------

/** How long a Bot keeps the desktop after its last action while its turn is still running. */
const HOLD_MS = 60_000;
const WAIT_MS = 120_000;
const holders = new Map<string, { botId: string; until: number }>();

const botName = (botId: string) => (db.prepare('SELECT name FROM bots WHERE id=?').get(botId) as { name: string } | undefined)?.name ?? 'Another Bot';

/** Wait until no other Bot is using the desktop, then hold it. */
async function takeDesktop(userId: string, botId: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    need(userId);
    const h = holders.get(userId);
    if (!h || h.botId === botId || h.until < Date.now() || !getLive(h.botId).isRunning) {
      holders.set(userId, { botId, until: Date.now() + HOLD_MS });
      return;
    }
    if (Date.now() > deadline) throw new ComputerError(`${botName(h.botId)} is using the desktop right now. Try again in a minute; the shell still works meanwhile.`, 409);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const osName = (platform: string) => (platform.startsWith('darwin') ? 'macOS' : platform.startsWith('linux') ? 'Linux' : platform.startsWith('win') ? 'Windows' : 'unknown');

const DESKTOP_PROMPT =
  "You can use the user's own computer: its full desktop (every app, with the user's own logins), mouse, keyboard, and a shell running as the user. Other Bots share this desktop, so you may briefly wait for your turn. For structured web work, use browser_* tools in Swarm's managed Chrome with its own persistent profile (or an explicitly attached browser). To use the user's existing browser session, open_browser opens their default browser and computer_* controls it on the real desktop. These can be different browsers; do not assume their tabs or logins are shared. Use the shell for files, scripts and command-line work, and the computer_* tools for apps. Save finished deliverables with save_file so they appear in the user's Library. Always take a screenshot before clicking, and check the screenshot after each action. This is the user's real computer: don't close their windows or unsaved work, don't delete or overwrite their files, and don't send messages, buy things or change settings unless they asked you to.";

const DESKTOP_TOOLS: Partial<Record<string, string>> = {
  computer_screenshot: "Take a screenshot of the user's desktop. Use this before acting on the screen.",
  computer_click: 'Click at pixel coordinates in the latest screenshot of the desktop. Returns a fresh screenshot.',
  computer_type: 'Type text into whatever has keyboard focus on the desktop. A newline presses Enter. Returns a fresh screenshot.',
  computer_key:
    'Press a key or key combination on the desktop, using X11 keysym names joined by "+", e.g. "Return", "Tab", "Escape", "BackSpace", "Page_Down", "ctrl+c". Use "cmd" for the Command key on macOS (e.g. "cmd+space" opens Spotlight, "cmd+tab" switches apps, "cmd+l" focuses the browser address bar).',
  computer_scroll: 'Scroll the mouse wheel at a position on the desktop.',
  computer_drag: 'Drag with the left mouse button from one point to another on the desktop.',
  open_browser: "Open a web page (http/https) in the user's default browser, which comes to the front. Use computer_* for this browser; browser_* may use a separate managed Chrome. Returns a screenshot.",
  shell: "Run a shell command on the user's computer as the user (their login shell, starting in their home folder). Use for files, scripts, CLIs and quick data work. Output is truncated to 20k characters.",
  save_file: 'Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it.',
};

const localProvider: ComputerProvider = {
  kind: 'local',
  get capabilities() {
    const id = currentUserId();
    return { shell: DESKTOP || MULTI, browser: MULTI ? true : DESKTOP ? (id && companions.has(id) ? companions.get(id)!.device.browser : DEVICE) : undefined };
  },
  promptFor: (userId) => {
    if (!DESKTOP) return localProvider.promptLine;
    const c = companions.get(userId);
    return c ? `${DESKTOP_PROMPT} The computer runs ${osName(c.device.platform)}.` : DESKTOP_PROMPT;
  },
  promptLine: DESKTOP
    ? DESKTOP_PROMPT
    : "You have your own web browser: a Chrome browser on the user's own PC that only you use, with its own profile, so logins persist. You have no desktop apps and no shell. Use open_browser to go to a URL (there is no address bar), and the computer_* tools to see and use the page. Save finished deliverables (reports, notes, data) with save_file so they appear in the user's Library. Always take a screenshot before clicking, and check the screenshot after each action. Don't sign in to accounts or enter personal details unless the user asked you to.",
  toolDescriptions: DESKTOP ? DESKTOP_TOOLS : {
    computer_screenshot: 'Take a screenshot of your browser (the current tab). Use this before acting on the page.',
    computer_click: 'Click at pixel coordinates in your browser tab. Returns a fresh screenshot.',
    computer_type: 'Type text into the focused element in your browser tab. A newline presses Enter. Returns a fresh screenshot.',
    computer_key:
      'Press a key or key combination in your browser tab, using X11 keysym names joined by "+", e.g. "Return", "Tab", "ctrl+a", "BackSpace", "Escape", "Page_Down". Browser shortcuts: "alt+Left" goes back, "alt+Right" forward, "F5" reloads, "ctrl+t" opens a new tab, "ctrl+w" closes the tab.',
    computer_scroll: 'Scroll the mouse wheel at a position in your browser tab.',
    computer_drag: 'Drag with the left mouse button from one point to another in your browser tab.',
    open_browser: 'Go to a URL in your browser (the current tab). This is the only way to navigate; there is no address bar. Only http(s) URLs. Returns a screenshot.',
    save_file: "Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it.",
  },

  state,
  refresh: async (userId) => state(userId),
  ensure: async (userId) => { need(userId); },
  suspend: async () => { /* a PC isn't suspended by us */ },

  async screen(userId, botId) {
    const connection = need(userId);
    const guard = () => { if (need(userId) !== connection) throw new ComputerError('Computer connection changed. Start a new action.', 409); };
    const rpc = async (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
      guard();
      if (DESKTOP && method !== 'shell') await takeDesktop(userId, botId);
      guard();
      const r = await call(userId, method, { botId, ...params }, timeoutMs);
      touch(userId, botId);
      return r;
    };
    const screen: BotScreen = {
      screenshot: async () => toShot(await rpc('screenshot', {}, 45_000)),
      click: async (a) => { await rpc('click', a); },
      drag: async (a) => { await rpc('drag', a); },
      type: async (text) => { await rpc('type', { text }); },
      key: async (keys) => (await rpc('key', { keys }))?.note,
      scroll: async (a) => { await rpc('scroll', a); },
      openUrl: async (url) => { await rpc('open', { url }, 60_000); },
    };
    if (MULTI || (DESKTOP && connection.device.browser)) screen.browser = async (tool, args) => rpc('browser', { tool, args }, 160_000);
    if (MULTI || (DESKTOP && connection.device.browser)) screen.captcha = async () => ((await rpc('captcha', {}, 30_000)) as any)?.captcha ?? null;
    if (DESKTOP || MULTI) screen.shell = async (command, timeoutSec) => rpc('shell', { command, timeout: timeoutSec }, (timeoutSec + 15) * 1000);
    return screen;
  },

  async peek(userId, botId) {
    const c = companions.get(userId);
    if (!c?.browsers.has(botId)) return null;
    return toShot(await call(userId, 'screenshot', { botId, peek: true }, 15_000));
  },

  async resetScreen(userId, botId) {
    const c = need(userId);
    if (DESKTOP) {
      // The desktop is the user's own: never close their windows. Just forget this Bot's turn.
      if (holders.get(userId)?.botId === botId) holders.delete(userId);
      if (c.browsers.has(botId)) { await call(userId, 'close', { botId }, 20_000).catch(() => {}); c.browsers.delete(botId); emitState(userId); }
      return { ok: true, note: 'This is your own desktop, so nothing was closed.' };
    }
    if (!c.browsers.has(botId)) return { ok: true, note: 'no browser open' };
    await call(userId, 'close', { botId }, 20_000);
    c.browsers.delete(botId);
    emitState(userId);
    return { ok: true, screenId: 'browser' };
  },

  screens: (userId) => {
    const c = companions.get(userId);
    return c ? [...c.browsers].map(([botId, t]) => ({ botId, screenId: 'browser', lastUsedAt: t })).sort((a, b) => b.lastUsedAt - a.lastUsedAt) : [];
  },

  files: {
    async save(_userId, botId, name, content) {
      const root = filesRoot(botId);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(inside(root, name), content, 'utf8');
      return `Library/${name}`;
    },
    async list(_userId, botId, rel) {
      const root = filesRoot(botId);
      const dir = inside(root, rel);
      if (!fs.existsSync(dir)) return { status: 'ok', path: rel, files: [] };
      const files: LibraryFile[] = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
        const st = fs.statSync(path.join(dir, d.name));
        return { name: d.name, size: st.size, modifiedAt: Math.round(st.mtimeMs), isDir: st.isDirectory() };
      });
      files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
      return { status: 'ok', path: rel, files };
    },
    async download(_userId, botId, rel) {
      const p = inside(filesRoot(botId), rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new ComputerError('file not found', 404);
      return `/api/bots/${botId}/files/raw?path=${encodeURIComponent(rel)}`;
    },
  },

  viewer,
};

/** Absolute path of a local Library file (for the raw download route). */
function localFilePath(botId: string, rel: string): string {
  return inside(filesRoot(botId), rel);
}

return { localProvider, setComputerStateSource, companionConnected, tenantCompanionReady, waitForCompanion, dropCompanion,
  createPairing, revokeVmTokens, revokePairings, pairingInfo, attachCompanionSocket, localFilePath,
  browserAvailable: (userId: string) => companions.get(userId)?.device.browser ?? false };
}

const defaultBackend = createLocalBackend(false);
const deviceBackend = createLocalBackend(true);
export const { localProvider, setComputerStateSource, companionConnected, tenantCompanionReady, waitForCompanion, dropCompanion,
  createPairing, revokeVmTokens, revokePairings, pairingInfo, attachCompanionSocket, localFilePath } = defaultBackend;
export const nativeLocal = deviceBackend;
