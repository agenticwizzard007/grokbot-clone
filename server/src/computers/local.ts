import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { getLive } from '../store.js';

// Loaded lazily: idle.ts imports the agent loop, which imports the provider index (keeps the static import graph acyclic).
const idle = () => import('../idle.js');
import { sha256, token as randomToken } from '../lib/ids.js';
import type { ComputerState, LibraryFile } from '../types.js';
import { ByteQueue, browserHandshake, jpegSize, jpegUpdate, msgLength, RFB_DESKTOP_SIZE, RFB_TIGHT, serverInit } from './rfb.js';
import { ComputerError, type BotScreen, type ComputerProvider, type Shot } from './types.js';
import { decodeCompanionFrame } from './frames.js';

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

/** Bots use the PC's full desktop and a shell (COMPUTER_PROVIDER=desktop). */
const DESKTOP = env.localDesktop;
/** Cloud VMs (COMPUTER_PROVIDER=cloudvm): the companion runs inside each user's VM with one screen per Bot (see cloudvm.ts). */
const MULTI = env.computerProvider === 'cloudvm';
const OFFLINE = MULTI
  ? "Your Bots' computer isn't running yet. It starts on its own; try again in a moment."
  : "Your PC isn't connected. Open Settings → Computer, then run the connect command on your PC.";

// Tokens can be bound to one cloud VM, so a VM's token is revoked with the VM.
try { db.exec('ALTER TABLE companion_tokens ADD COLUMN vm_id TEXT'); } catch { /* exists */ }
const PROTOCOL_VERSION = 1;

interface Frame { data: Buffer; width: number; height: number }

interface Companion {
  ws: WebSocket;
  userId: string;
  tokenHash: string;
  device: { name: string; platform: string; version: string; headless: boolean; desktop: boolean };
  width: number;
  height: number;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** botId -> last used (ms) for Bots with an open browser. */
  browsers: Map<string, number>;
  /** botId -> frame listeners (live viewers). */
  viewers: Map<string, Set<(f: Frame) => void>>;
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
export function setComputerStateSource(fn: (userId: string) => ComputerState) { stateOf = fn; }
const emitState = (userId: string) => hub.emit(userId, { type: 'computer', state: stateOf(userId) });

/** Is this user's companion (PC or cloud VM) connected right now? */
export const companionConnected = (userId: string) => companions.has(userId);

/** Wait until the user's companion connects (a cloud VM finishing boot or resume). */
export async function waitForCompanion(userId: string, timeoutMs: number): Promise<boolean> {
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
export function dropCompanion(userId: string, reason = 'computer stopped') {
  const c = companions.get(userId);
  if (!c) return;
  console.log(`[local] dropping companion user=${userId}: ${reason}`);
  c.ws.terminate();
}

function need(userId: string): Companion {
  const c = companions.get(userId);
  if (!c) throw new ComputerError(OFFLINE, 409);
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
  const c = companions.get(userId);
  if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ method, params }));
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
export function createPairing(userId: string, vmId: string | null = null): string {
  const t = `swc_${randomToken()}`;
  db.prepare('INSERT INTO companion_tokens(token_hash,user_id,created_at,vm_id) VALUES (?,?,?,?)').run(sha256(t), userId, now(), vmId);
  return t;
}

/** Revoke a cloud VM's tokens (the VM is being destroyed or replaced). */
export function revokeVmTokens(vmId: string) {
  db.prepare('DELETE FROM companion_tokens WHERE vm_id=?').run(vmId);
}

/** Revoke every pairing token for the user and disconnect their PC. */
export function revokePairings(userId: string): number {
  const n = db.prepare('DELETE FROM companion_tokens WHERE user_id=?').run(userId).changes;
  companions.get(userId)?.ws.close(4401, 'pairing revoked');
  return n;
}

export function pairingInfo(userId: string) {
  const r = db.prepare('SELECT COUNT(*) n, MAX(last_seen_at) seen FROM companion_tokens WHERE user_id=?').get(userId) as any;
  return { paired: r.n > 0, lastSeenAt: r.seen ?? null };
}

// ---------- companion connections ----------

export function attachCompanionSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/companion') return;
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
    for (const fn of subs) fn({ data, ...size });
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
      const row = db.prepare('SELECT user_id FROM companion_tokens WHERE token_hash=?').get(hash) as any;
      if (!row) return ws.close(4401, 'invalid token');
      clearTimeout(helloTimer);
      if (MULTI && msg.mode !== 'multi') return ws.close(4403, 'This Swarm runs Bots on cloud VMs; only the VM companion (--multi) can connect.');
      if (!MULTI && msg.mode === 'multi') return ws.close(4403, 'This Swarm does not use cloud VMs; start the companion without --multi.');
      if (DESKTOP && msg.desktop !== true) return ws.close(4403, 'This Swarm gives Bots your full desktop. Update the companion and start it with --desktop.');
      db.prepare('UPDATE companion_tokens SET last_seen_at=? WHERE token_hash=?').run(now(), hash);
      // One PC per user: a new connection replaces the old one.
      const old = companions.get(row.user_id);
      if (old) old.ws.close(4409, 'replaced by a newer connection');
      comp = {
        ws,
        userId: row.user_id,
        tokenHash: hash,
        device: {
          name: String(msg.name ?? 'My PC').slice(0, 80),
          platform: String(msg.platform ?? '').slice(0, 40),
          version: String(msg.version ?? '').slice(0, 20),
          headless: msg.headless !== false,
          desktop: msg.desktop === true,
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
      ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, binaryFrames: true, mode: MULTI ? 'multi' : DESKTOP ? 'desktop' : 'browser' }));
      console.log(`[local] PC connected user=${row.user_id} name="${comp.device.name}" platform=${comp.device.platform} headless=${comp.device.headless}`);
      emitState(row.user_id);
      return;
    }
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
    for (const p of comp.pending.values()) { clearTimeout(p.timer); p.reject(new ComputerError('Your PC disconnected.', 503)); }
    comp.pending.clear();
    for (const fn of comp.onClose) fn();
    if (companions.get(comp.userId) === comp) {
      companions.delete(comp.userId);
      console.log(`[local] PC disconnected user=${comp.userId}`);
      emitState(comp.userId);
    }
  });
  ws.on('error', () => { /* close follows */ });
}

// ---------- live viewer: an RFB server fed by the browser's screencast ----------

async function viewer(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const comp = companions.get(userId);
  if (!comp) { client.close(1011, "Your PC isn't connected"); return; }
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
  const input = (params: Record<string, unknown>) => { touch(userId, botId); notify(userId, 'input', { botId, ...params, width: fbW, height: fbH }); };

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
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (counted) void idle().then((m) => m.viewerClosed(userId));
    fromClient.close(new Error('closed'));
    const subs = comp.viewers.get(botId);
    subs?.delete(onFrame);
    if (subs && !subs.size) {
      comp.viewers.delete(botId);
      if (companions.get(userId) === comp) call(userId, 'screencast.stop', { botId }, 10_000).catch(() => {});
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
    // Open (or reuse) the Bot's browser and grab a first frame before the client asks for one.
    const first = await call<{ data: string }>(userId, 'screenshot', { botId }, 45_000);
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
    if (!subs) { subs = new Set(); comp.viewers.set(botId, subs); }
    const firstViewer = subs.size === 0;
    subs.add(onFrame);
    if (firstViewer) await call(userId, 'screencast.start', { botId }, 20_000);
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
  "You can use the user's own computer: its full desktop (every app, with the user's own logins), mouse, keyboard, and a shell running as the user. Other Bots share this desktop, so you may briefly wait for your turn. If a task needs the web, use open_browser: it opens the page in the user's default browser and brings it to the front. Use the shell for files, scripts and command-line work, and the computer_* tools for apps. Save finished deliverables with save_file so they appear in the user's Library. Always take a screenshot before clicking, and check the screenshot after each action. This is the user's real computer: don't close their windows or unsaved work, don't delete or overwrite their files, and don't send messages, buy things or change settings unless they asked you to.";

const DESKTOP_TOOLS: Partial<Record<string, string>> = {
  computer_screenshot: "Take a screenshot of the user's desktop. Use this before acting on the screen.",
  computer_click: 'Click at pixel coordinates in the latest screenshot of the desktop. Returns a fresh screenshot.',
  computer_type: 'Type text into whatever has keyboard focus on the desktop. A newline presses Enter. Returns a fresh screenshot.',
  computer_key:
    'Press a key or key combination on the desktop, using X11 keysym names joined by "+", e.g. "Return", "Tab", "Escape", "BackSpace", "Page_Down", "ctrl+c". Use "cmd" for the Command key on macOS (e.g. "cmd+space" opens Spotlight, "cmd+tab" switches apps, "cmd+l" focuses the browser address bar).',
  computer_scroll: 'Scroll the mouse wheel at a position on the desktop.',
  computer_drag: 'Drag with the left mouse button from one point to another on the desktop.',
  open_browser: "Open a web page (http/https) in the user's default browser, which comes to the front. Use this whenever a task needs a website. Returns a screenshot.",
  shell: "Run a shell command on the user's computer as the user (their login shell, starting in their home folder). Use for files, scripts, CLIs and quick data work. Output is truncated to 20k characters.",
  save_file: 'Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it.',
};

export const localProvider: ComputerProvider = {
  kind: 'local',
  capabilities: { shell: DESKTOP || MULTI },
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
    need(userId);
    const rpc = async (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
      if (DESKTOP && method !== 'shell') await takeDesktop(userId, botId);
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
    if (MULTI) screen.browser = async (tool, args) => rpc('browser', { tool, args }, 160_000);
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
export function localFilePath(botId: string, rel: string): string {
  return inside(filesRoot(botId), rel);
}
