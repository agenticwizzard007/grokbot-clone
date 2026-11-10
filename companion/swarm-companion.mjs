#!/usr/bin/env node
// Swarm companion: lets your Bots use a Chrome browser on this PC, or (with --desktop) the
// whole computer: its screen, mouse, keyboard, apps and a shell.
//
//   node swarm-companion.mjs --server https://swarm.swarms.so --token swc_...
//
// Get the token (and the full command) from Swarm: Settings → Computer → Connect your PC.
// Requires Node.js 22+ and Google Chrome (or Chromium). No other dependencies.
//
// What it does:
// - Connects out to your Swarm server (no open ports on this PC) and waits for work.
// - Starts a separate Chrome per Bot, each with its own profile under --data-dir (default
//   ~/.swarm-companion). Your everyday Chrome profile is never touched.
// - Drives Chrome through the DevTools protocol over a private pipe (no debugging port).
//
// Full desktop (--desktop): Bots see this computer's real screen and use its mouse and keyboard,
// open websites in your default browser, and run commands in a shell as you. All Bots share the
// one desktop; the server lets one Bot at a time act on it. Supported on macOS and Linux (X11).
// - macOS: give the app that runs this (Terminal, iTerm, Conductor…) Accessibility and Screen
//   Recording permission in System Settings → Privacy & Security.
// - Linux: needs an X11 session with xdotool and ImageMagick (import) or ffmpeg installed.
//
// Guard rails in browser mode (the default; enforced here, on your PC):
// - Bots get a browser only: no shell, no files from this PC.
// - Only http(s) pages; local-network and localhost addresses are blocked unless you pass
//   --allow-private-network.
// - Downloads are blocked and file-upload dialogs never open.
//
// Options:
//   --server URL              Swarm server URL (or SWARM_SERVER)
//   --token TOKEN             pairing token (or SWARM_TOKEN)
//   --desktop                 give Bots this computer's full desktop and a shell (see above)
//   --max-width N             full desktop: screenshot width sent to Bots (default 1280)
//   --multi                   cloud VM mode (Linux): every Bot gets its own virtual screen, Chrome
//                             profile and shell folder on this machine (needs Xvfb, xdotool, ImageMagick)
//   --run-as USER             --multi: run Bots' shells and browsers as this unprivileged user
//   --agent-home DIR          --multi: home of the Bots' files and profiles (default /home/USER)
//   --token-file FILE         read the pairing token from a file instead of --token
//   --headed                  show the Chrome windows instead of running headless
//   --chrome PATH             Chrome/Chromium executable (or CHROME_PATH)
//   --data-dir DIR            where Bot profiles live (default ~/.swarm-companion)
//   --allow-private-network   let Bots open localhost / LAN addresses
//   --no-sandbox              pass --no-sandbox to Chrome (only for containers/root)
//   --idle-minutes N          close a Bot's browser after N idle minutes (default 30)
//   --viewer-fps N            Linux desktop watching rate, 1–60 (default 20)
//   --control-fps N           Linux desktop taking-control rate, 1–60 (default 20)
//   --viewer-width N          live view width, independent of agent screenshots (default 1920)
//   --screen-width N          cloud desktop width (default 1920)
//   --screen-height N         cloud desktop height (default 1080)

import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.5.2';
const W = 1280;
const H = 800;

// ---------- options ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const SERVER = (opt('server', process.env.SWARM_SERVER) ?? '').replace(/\/+$/, '');
const TOKEN_FILE = opt('token-file', process.env.SWARM_TOKEN_FILE);
const TOKEN = opt('token', process.env.SWARM_TOKEN) ?? (TOKEN_FILE && fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : undefined);
const DESKTOP = flag('desktop');
const MULTI = flag('multi');
const HEADED = flag('headed');
const DATA_DIR = path.resolve(opt('data-dir', path.join(os.homedir(), '.swarm-companion')));
const ALLOW_PRIVATE = flag('allow-private-network');
const NO_SANDBOX = flag('no-sandbox');
const IDLE_MS = Number(opt('idle-minutes', '30')) * 60_000;
/** Set when Swarm's server started this companion ("Use this computer"): exit when that server is gone. */
const PARENT_PID = Number(opt('parent-pid', '0')) || 0;

if (!SERVER || !TOKEN) {
  console.error('Usage: node swarm-companion.mjs --server <swarm url> --token <pairing token>\nGet both from Swarm: Settings → Computer → Connect your PC.');
  process.exit(2);
}
if (typeof WebSocket !== 'function') {
  console.error(`This needs Node.js 22 or newer (found ${process.version}).`);
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function findChrome() {
  const explicit = opt('chrome', process.env.CHROME_PATH);
  if (explicit) return explicit;
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    console.error('Could not find Chrome. Install Google Chrome, or pass --chrome /path/to/chrome.');
    process.exit(2);
  }
  return found;
}
const CHROME = DESKTOP && !MULTI ? null : findChrome();

// ---------- URL guard ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return false;
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { try { u = new URL(`https://${raw}`); } catch { throw new Error(`Not a valid URL: ${raw}`); } }
  if (u.href === 'about:blank') return u.href;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) pages can be opened (not ${u.protocol}).`);
  if (!ALLOW_PRIVATE) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const blockedName = host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
    let blocked = blockedName || isPrivateIp(host);
    if (!blocked && !net.isIP(host)) {
      const addrs = await dns.lookup(host, { all: true }).catch(() => []);
      blocked = addrs.some((a) => isPrivateIp(a.address));
    }
    if (blocked) throw new Error(`${u.hostname} is a local-network address, which this PC's companion blocks. (Start it with --allow-private-network to allow.)`);
  }
  return u.href;
}

// ---------- keys ----------

// [names..., keysym, key, code, windowsVirtualKeyCode, text]
const NAMED = [
  [['return', 'enter', 'kp_enter'], 0xff0d, 'Enter', 'Enter', 13, '\r'],
  [['tab'], 0xff09, 'Tab', 'Tab', 9],
  [['escape', 'esc'], 0xff1b, 'Escape', 'Escape', 27],
  [['backspace'], 0xff08, 'Backspace', 'Backspace', 8],
  [['delete', 'del'], 0xffff, 'Delete', 'Delete', 46],
  [['insert'], 0xff63, 'Insert', 'Insert', 45],
  [['home'], 0xff50, 'Home', 'Home', 36],
  [['end'], 0xff57, 'End', 'End', 35],
  [['page_up', 'pageup', 'prior'], 0xff55, 'PageUp', 'PageUp', 33],
  [['page_down', 'pagedown', 'next'], 0xff56, 'PageDown', 'PageDown', 34],
  [['left', 'arrowleft'], 0xff51, 'ArrowLeft', 'ArrowLeft', 37],
  [['up', 'arrowup'], 0xff52, 'ArrowUp', 'ArrowUp', 38],
  [['right', 'arrowright'], 0xff53, 'ArrowRight', 'ArrowRight', 39],
  [['down', 'arrowdown'], 0xff54, 'ArrowDown', 'ArrowDown', 40],
  [['space'], 0x20, ' ', 'Space', 32, ' '],
  ...Array.from({ length: 12 }, (_, i) => [[`f${i + 1}`], 0xffbe + i, `F${i + 1}`, `F${i + 1}`, 112 + i]),
];
const MODS = {
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16, keysyms: [0xffe1, 0xffe2] },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17, keysyms: [0xffe3, 0xffe4] },
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18, keysyms: [0xffe9, 0xffea] },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91, keysyms: [0xffe7, 0xffe8, 0xffeb, 0xffec] },
};
const MOD_ALIASES = { shift: 'shift', ctrl: 'ctrl', control: 'ctrl', control_l: 'ctrl', control_r: 'ctrl', alt: 'alt', alt_l: 'alt', alt_r: 'alt', option: 'alt', meta: 'meta', super: 'meta', super_l: 'meta', cmd: 'meta', command: 'meta', win: 'meta', shift_l: 'shift', shift_r: 'shift' };
const PUNCT = { '-': ['Minus', 189], '=': ['Equal', 187], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], '`': ['Backquote', 192] };
const PUNCT_NAMES = { minus: '-', equal: '=', comma: ',', period: '.', slash: '/', semicolon: ';', apostrophe: "'", bracketleft: '[', bracketright: ']', backslash: '\\', grave: '`', plus: '+', asterisk: '*', at: '@', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', parenleft: '(', parenright: ')', question: '?', exclam: '!', colon: ':', underscore: '_', quotedbl: '"', less: '<', greater: '>' };

function charDef(ch) {
  const up = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${up}`, keyCode: up.charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  const p = PUNCT[ch];
  return { key: ch, code: p?.[0] ?? '', keyCode: p?.[1] ?? 0, text: ch };
}

/** A key from an X11-style name ("Return", "a", "Page_Down", "minus"). */
function keyByName(name) {
  const n = name.toLowerCase();
  const named = NAMED.find((k) => k[0].includes(n));
  if (named) return { key: named[2], code: named[3], keyCode: named[4], text: named[5] };
  if (PUNCT_NAMES[n]) return charDef(PUNCT_NAMES[n]);
  if ([...name].length === 1) return charDef(name);
  throw new Error(`Unknown key "${name}". Use X11 names like Return, Tab, Escape, BackSpace, Page_Down, F5, or single characters.`);
}

/** A key from a keysym (live viewer). Returns { mod } for modifier keys, or null if unknown. */
function keyBySym(sym) {
  for (const [name, m] of Object.entries(MODS)) if (m.keysyms.includes(sym)) return { mod: name };
  const named = NAMED.find((k) => k[1] === sym);
  if (named) return { key: named[2], code: named[3], keyCode: named[4], text: named[5] };
  if (sym === 0xff8d) return keyByName('Return');
  let cp = null;
  if ((sym >= 0x20 && sym <= 0x7e) || (sym >= 0xa0 && sym <= 0xff)) cp = sym;
  else if (sym >= 0x01000100 && sym <= 0x0110ffff) cp = sym - 0x01000000;
  return cp === null ? null : charDef(String.fromCodePoint(cp));
}

const EDIT_COMMANDS = { 'ctrl+a': 'selectAll', 'meta+a': 'selectAll', 'ctrl+z': 'undo', 'meta+z': 'undo', 'ctrl+shift+z': 'redo', 'ctrl+y': 'redo', 'meta+shift+z': 'redo' };

// ---------- DevTools protocol over a pipe ----------

class Cdp {
  constructor(write, read) {
    this.write = write;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    let buf = '';
    read.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
          else p.resolve(msg.result ?? {});
        } else {
          for (const fn of this.listeners) fn(msg.method, msg.params ?? {}, msg.sessionId);
        }
      }
    });
    read.on('close', () => this.fail(new Error('browser closed')));
    write.on('error', () => {});
  }
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('browser closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- one Chrome per Bot ----------

/**
 * Chrome refuses a profile whose lock names another host or a dead process (after a crash, a
 * reboot, or a hostname change, which is common on Macs). Each profile belongs to this companion
 * alone, so clear a lock unless a live Chrome on this machine still holds it.
 */
function clearStaleProfileLock(profile) {
  let target;
  try { target = fs.readlinkSync(path.join(profile, 'SingletonLock')); } catch { return; }
  const m = target.match(/^(.*)-(\d+)$/);
  if (m && m[1] === os.hostname()) {
    let alive = false;
    try { process.kill(Number(m[2]), 0); alive = true; } catch { /* not running */ }
    if (alive) throw new Error(`This Bot's browser profile is in use by another Chrome (process ${m[2]}). Stop the other companion or close that browser.`);
  }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, f), { force: true });
}

class BotBrowser {
  constructor(botId, onFrame, onExit) {
    this.botId = botId;
    this.onFrame = onFrame;
    this.onExit = onExit;
    this.pages = []; // { targetId, sessionId } in open order
    this.active = null;
    this.attaching = new Map(); // targetId -> Promise
    this.screencasting = false;
    this.mods = 0;
    this.lastUsed = Date.now();
    this.dead = false;
  }

  async start() {
    const profile = path.join(DATA_DIR, 'profiles', this.botId);
    fs.mkdirSync(profile, { recursive: true });
    clearStaleProfileLock(profile);
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--hide-crash-restore-bubble',
      `--window-size=${W},${H}`,
      ...(HEADED ? [] : ['--headless=new']),
      ...(NO_SANDBOX ? ['--no-sandbox'] : []),
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
      'about:blank',
    ];
    this.proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    this.proc.on('exit', (code) => {
      this.dead = true;
      const why = stderr.split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).at(-1);
      this.cdp?.fail(new Error(`Chrome exited${code ? ` (code ${code})` : ''}${why && code ? `: ${why.slice(0, 300)}` : ''}`));
      if (!this.closing && code) log(`Browser for ${this.botId} exited (${code}). ${why ?? ''}`);
      this.onExit(this);
    });
    this.proc.on('error', (e) => { log(`Could not start Chrome: ${e.message}`); });
    this.cdp = new Cdp(this.proc.stdio[3], this.proc.stdio[4]);
    this.cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));

    await this.cdp.send('Browser.getVersion', {}, undefined, 20_000);
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const first = targetInfos.find((t) => t.type === 'page');
    const targetId = first ? first.targetId : (await this.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    await this.attach(targetId);
    this.ready = true;
  }

  attach(targetId) {
    if (!this.attaching.has(targetId)) this.attaching.set(targetId, this.doAttach(targetId));
    return this.attaching.get(targetId);
  }

  async doAttach(targetId) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await Promise.all([
      this.cdp.send('Page.enable', {}, sessionId),
      this.cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId),
      this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId).catch(() => {}),
    ]);
    const page = { targetId, sessionId };
    this.pages.push(page);
    await this.activate(page);
  }

  async activate(page) {
    const prev = this.active;
    this.active = page;
    await this.cdp.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
    await this.cdp.send('Page.bringToFront', {}, page.sessionId).catch(() => {});
    if (this.screencasting) {
      if (prev && prev !== page) await this.cdp.send('Page.stopScreencast', {}, prev.sessionId).catch(() => {});
      await this.startScreencast();
    }
  }

  onEvent(method, params, sessionId) {
    if (method === 'Target.targetCreated' && params.targetInfo?.type === 'page' && this.ready && !this.attaching.has(params.targetInfo.targetId)) {
      // A page opened a new tab or popup: follow it.
      this.attach(params.targetInfo.targetId).catch(() => {});
    } else if (method === 'Target.targetDestroyed' || (method === 'Target.detachedFromTarget' && params.targetId)) {
      const id = params.targetId;
      const i = this.pages.findIndex((p) => p.targetId === id);
      if (i < 0) return;
      const [gone] = this.pages.splice(i, 1);
      if (this.active === gone) {
        this.active = null;
        const next = this.pages.at(-1);
        if (next) this.activate(next).catch(() => {});
        else this.cdp.send('Target.createTarget', { url: 'about:blank' }).then((r) => this.attach(r.targetId)).catch(() => {});
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      // alert/confirm/prompt/beforeunload would block the page; accept them.
      this.cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }, sessionId).catch(() => {});
    } else if (method === 'Page.screencastFrame') {
      this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      if (this.screencasting && sessionId === this.active?.sessionId) this.onFrame(this.botId, params.data);
    }
  }

  get s() {
    if (!this.active) throw new Error('No open tab.');
    return this.active.sessionId;
  }

  async screenshot() {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 }, this.s, 30_000);
    return { data, width: W, height: H };
  }

  waitFor(methods, sessionId, ms) {
    return new Promise((resolve) => {
      const off = this.cdp.on((m, _p, s) => { if (methods.includes(m) && s === sessionId) { off(); clearTimeout(t); resolve(true); } });
      const t = setTimeout(() => { off(); resolve(false); }, ms);
    });
  }

  async open(rawUrl) {
    const url = await checkUrl(rawUrl);
    const s = this.s;
    const loaded = this.waitFor(['Page.loadEventFired', 'Page.navigatedWithinDocument'], s, 20_000);
    const r = await this.cdp.send('Page.navigate', { url }, s, 30_000);
    if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`);
    await loaded;
    return { url };
  }

  mouse(type, x, y, extra = {}) {
    return this.cdp.send('Input.dispatchMouseEvent', { type, x, y, modifiers: this.mods, button: 'none', buttons: 0, clickCount: 0, ...extra }, this.s);
  }

  async click({ x, y, button = 'left', double = false }) {
    const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1;
    await this.mouse('mouseMoved', x, y);
    for (let n = 1; n <= (double ? 2 : 1); n++) {
      await this.mouse('mousePressed', x, y, { button, buttons, clickCount: n });
      await this.mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: n });
    }
  }

  async drag({ start_x, start_y, end_x, end_y }) {
    await this.mouse('mouseMoved', start_x, start_y);
    await this.mouse('mousePressed', start_x, start_y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      await this.mouse('mouseMoved', start_x + ((end_x - start_x) * i) / 10, start_y + ((end_y - start_y) * i) / 10, { buttons: 1 });
      await sleep(15);
    }
    await this.mouse('mouseReleased', end_x, end_y, { button: 'left', buttons: 0, clickCount: 1 });
  }

  async scroll({ x, y, direction, amount = 3 }) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mouseWheel', x, y, { deltaX: 0, deltaY: (direction === 'up' ? -1 : 1) * 100 * Math.max(1, Math.min(Number(amount) || 3, 30)) });
  }

  keyEvent(type, def, modifiers, commands) {
    const text = type === 'keyDown' ? def.text : undefined;
    return this.cdp.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' && !text ? 'rawKeyDown' : type,
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(commands ? { commands } : {}),
    }, this.s);
  }

  async type(text) {
    const parts = String(text).split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) await this.cdp.send('Input.insertText', { text: parts[i] }, this.s);
      if (i < parts.length - 1) await this.press(keyByName('Return'), 0);
    }
  }

  async press(def, mods, commands) {
    await this.keyEvent('keyDown', def, mods, commands);
    await this.keyEvent('keyUp', def, mods);
  }

  async history(delta) {
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory', {}, this.s);
    const e = entries[currentIndex + delta];
    if (!e) return { note: delta < 0 ? 'There is no previous page.' : 'There is no next page.' };
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: e.id }, this.s);
    await sleep(800);
    return {};
  }

  async key(keys) {
    const parts = String(keys).split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) throw new Error('No key given.');
    const mods = parts.slice(0, -1).map((m) => {
      const k = MOD_ALIASES[m.toLowerCase()];
      if (!k) throw new Error(`Unknown modifier "${m}".`);
      return k;
    });
    const main = parts.at(-1);
    const combo = [...[...new Set(mods)].sort(), main.toLowerCase()].join('+');
    // Browser-level shortcuts: there is no browser UI to receive them, so do them directly.
    switch (combo) {
      case 'alt+left': return this.history(-1);
      case 'alt+right': return this.history(1);
      case 'f5': case 'ctrl+r': case 'meta+r': await this.cdp.send('Page.reload', {}, this.s); await sleep(800); return {};
      case 'ctrl+t': case 'meta+t': { const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }); await this.attach(targetId); return {}; }
      case 'ctrl+w': case 'meta+w': {
        if (this.pages.length > 1) await this.cdp.send('Target.closeTarget', { targetId: this.active.targetId });
        else await this.cdp.send('Page.navigate', { url: 'about:blank' }, this.s);
        await sleep(300);
        return {};
      }
      case 'ctrl+tab': case 'ctrl+shift+tab': {
        const i = this.pages.indexOf(this.active);
        const next = this.pages[(i + (combo === 'ctrl+tab' ? 1 : -1) + this.pages.length) % this.pages.length];
        await this.activate(next);
        return {};
      }
      case 'ctrl+l': case 'meta+l': case 'f6':
        return { note: 'This browser has no address bar; use open_browser to go to a URL.' };
      case 'ctrl+v': case 'meta+v': case 'ctrl+shift+v':
        return { note: "Pasting isn't available (the clipboard belongs to the user's PC); type the text with computer_type instead." };
    }
    const def = keyByName(main);
    let bits = 0;
    for (const m of mods) {
      bits |= MODS[m].bit;
      await this.keyEvent('keyDown', MODS[m], bits);
    }
    const textAllowed = !(bits & (MODS.ctrl.bit | MODS.alt.bit | MODS.meta.bit));
    await this.press(textAllowed ? (bits & MODS.shift.bit && def.text ? { ...def, text: def.text.toUpperCase(), key: def.key.length === 1 ? def.key.toUpperCase() : def.key } : def) : { ...def, text: undefined }, bits, EDIT_COMMANDS[combo] ? [EDIT_COMMANDS[combo]] : undefined);
    for (const m of [...mods].reverse()) {
      bits &= ~MODS[m].bit;
      await this.keyEvent('keyUp', MODS[m], bits);
    }
    return {};
  }

  // Live viewer input (someone took control in Swarm).
  async input(p) {
    if (p.kind === 'mouse') {
      await this.mouse(p.type, p.x, p.y, { button: p.button ?? 'none', buttons: p.buttons ?? 0, clickCount: p.clickCount ?? (p.type === 'mouseMoved' ? 0 : 1) });
    } else if (p.kind === 'wheel') {
      await this.mouse('mouseWheel', p.x, p.y, { deltaX: 0, deltaY: p.deltaY });
    } else if (p.kind === 'key') {
      const def = keyBySym(p.keysym >>> 0);
      if (!def) return;
      if (def.mod) {
        const m = MODS[def.mod];
        this.mods = p.down ? this.mods | m.bit : this.mods & ~m.bit;
        await this.keyEvent(p.down ? 'keyDown' : 'keyUp', m, this.mods);
        return;
      }
      const textAllowed = !(this.mods & (MODS.ctrl.bit | MODS.alt.bit | MODS.meta.bit));
      if (!textAllowed && def.key.length === 1 && p.down) {
        const combo = [...Object.entries(MODS).filter(([, m]) => this.mods & m.bit).map(([k]) => k).sort(), def.key.toLowerCase()].join('+');
        if (EDIT_COMMANDS[combo]) return this.keyEvent('keyDown', { ...def, text: undefined }, this.mods, [EDIT_COMMANDS[combo]]);
      }
      await this.keyEvent(p.down ? 'keyDown' : 'keyUp', textAllowed ? def : { ...def, text: undefined }, this.mods);
    }
  }

  async startScreencast() {
    this.screencasting = true;
    // Chrome emits changed frames; skipping every Nth can suppress the only update after a click.
    if (this.active) await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: W, maxHeight: H, everyNthFrame: 1 }, this.active.sessionId);
  }

  async stopScreencast() {
    this.screencasting = false;
    if (this.active) await this.cdp.send('Page.stopScreencast', {}, this.active.sessionId).catch(() => {});
  }

  close() {
    this.closing = true;
    this.cdp?.fail(new Error('closed'));
    try { this.proc?.kill(); } catch { /* gone */ }
  }
}

// ---------- full desktop (--desktop) ----------

const MAX_SHOT_W = Math.max(640, Number(opt('max-width', '1280')) || 1280);
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const VIEWER_FPS = bounded(opt('viewer-fps', process.env.SWARM_VIEWER_FPS ?? '20'), 20, 1, 60);
const CONTROL_FPS = bounded(opt('control-fps', process.env.SWARM_CONTROL_FPS ?? '20'), 20, 1, 60);
const VIEWER_BUDGET_FPS = bounded(process.env.SWARM_VIEWER_BUDGET_FPS ?? '20', 20, 1, 120);
const VIEWER_WIDTH = bounded(opt('viewer-width', process.env.SWARM_VIEWER_WIDTH ?? '1920'), 1920, 640, 3840);
const watchedDesktops = new Set();

// Share one VM-wide capture budget across watched displays; viewers of the same display share its encoder.
function balanceDesktopStreams() {
  const total = [...watchedDesktops].reduce((n, d) => n + d.requestedFps, 0);
  const weight = [...watchedDesktops].reduce((n, d) => n + d.streamWeight, 0);
  for (const d of watchedDesktops) d.setStreamFps(total <= VIEWER_BUDGET_FPS ? d.requestedFps : Math.min(d.requestedFps, VIEWER_BUDGET_FPS * d.streamWeight / weight));
}

/** One encoder per watched display. Its stdout is a bounded sequence of complete JPEGs. */
function streamDesktop(display, size, fps, onFrame) {
  const encoder = spawn(process.env.SWARM_FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-f', 'x11grab', '-draw_mouse', '1',
    '-framerate', String(fps), '-video_size', `${size.w}x${size.h}`, '-i', display,
    '-an', '-vf', `scale=${Math.min(VIEWER_WIDTH, size.w)}:-2`,
    '-c:v', 'mjpeg', '-q:v', '5', '-threads', '1', '-f', 'image2pipe', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Yield CPU to Chrome and agent tools under contention; spare CPU can still make the viewer smooth.
  if (encoder.pid) { try { os.setPriority(encoder.pid, 10); } catch { /* best effort on restricted hosts */ } }
  let buffer = Buffer.alloc(0), stderr = '', stopped = false, settled = false;
  let watchdog;
  let finish;
  const done = new Promise((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      encoder.kill('SIGKILL');
      if (error && !stopped) reject(error); else resolve();
    };
  });
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(new Error('Desktop encoder stopped producing frames')), Math.max(5000, 3000 / fps)); };
  arm();
  encoder.on('error', finish);
  encoder.on('close', () => finish(new Error(`Desktop encoder exited: ${stderr.trim().slice(-300)}`)));
  encoder.stderr.on('data', (data) => { stderr = (stderr + data).slice(-1000); });
  encoder.stdout.on('data', (data) => {
    if (settled) return;
    let from = Math.max(0, buffer.length - 1); // markers can cross chunk boundaries
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Desktop encoder frame exceeded limit'));
    for (;;) {
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), from);
      if (end < 0) break;
      const frame = buffer.subarray(0, end + 2);
      buffer = buffer.subarray(end + 2);
      from = 0;
      if (frame[0] !== 0xff || frame[1] !== 0xd8) return finish(new Error('Invalid desktop encoder frame'));
      arm();
      onFrame(frame);
    }
  });
  return { done, stop: () => { stopped = true; finish(); } };
}

/** Run a program; resolves with stdout (Buffer), rejects with its stderr. */
function exec(cmd, args, { input, timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    const out = [];
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error(`${cmd} isn't installed on this computer.`) : e); });
    p.on('close', (code) => {
      clearTimeout(t);
      const stdout = Buffer.concat(out);
      if (code === 0) resolve(stdout);
      else reject(new Error((err.trim() || stdout.toString().trim() || `${path.basename(cmd)} exited with code ${code}`).slice(0, 500)));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? undefined);
  });
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// Keys for the desktop, as canonical X11 keysym names (or single characters).
const KEY_CANON = {
  return: 'Return', enter: 'Return', kp_enter: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace',
  delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End', page_up: 'Page_Up', pageup: 'Page_Up', prior: 'Page_Up',
  page_down: 'Page_Down', pagedown: 'Page_Down', next: 'Page_Down', left: 'Left', arrowleft: 'Left', up: 'Up', arrowup: 'Up',
  right: 'Right', arrowright: 'Right', down: 'Down', arrowdown: 'Down', space: 'space',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};
const CHAR_NAMES = Object.fromEntries(Object.entries(PUNCT_NAMES).map(([name, ch]) => [ch, name]));

/** "ctrl+shift+t" -> { mods: ['ctrl','shift'], name: 't' }; a bare modifier ("cmd") -> { mods: ['meta'], name: null }. */
function parseCombo(keys) {
  const parts = String(keys).split('+').map((p) => p.trim()).filter(Boolean);
  if (String(keys).trim().endsWith('++') || String(keys).trim() === '+') parts.push('+');
  if (!parts.length) throw new Error('No key given.');
  const mods = parts.slice(0, -1).map((m) => {
    const k = MOD_ALIASES[m.toLowerCase()];
    if (!k) throw new Error(`Unknown modifier "${m}".`);
    return k;
  });
  const main = parts.at(-1);
  const lower = main.toLowerCase();
  const name = KEY_CANON[lower] ?? PUNCT_NAMES[lower] ?? ([...main].length === 1 ? main : null);
  if (name) return { mods: [...new Set(mods)], name };
  if (MOD_ALIASES[lower]) return { mods: [...new Set([...mods, MOD_ALIASES[lower]])], name: null };
  throw new Error(`Unknown key "${main}". Use X11 names like Return, Tab, Escape, BackSpace, Page_Down, F5, or single characters.`);
}

// --- macOS: screencapture + sips for pictures, CoreGraphics events (through JXA) for input ---

const MAC_KEYS = { Return: 36, Tab: 48, space: 49, BackSpace: 51, Escape: 53, Delete: 117, Insert: 114, Home: 115, End: 119, Page_Up: 116, Page_Down: 121, Left: 123, Right: 124, Down: 125, Up: 126, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
const MAC_CHARS = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50, ' ': 49 };
const MAC_SHIFTED = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
const MAC_MODS = { shift: { code: 56, flag: 0x20000 }, ctrl: { code: 59, flag: 0x40000 }, alt: { code: 58, flag: 0x80000 }, meta: { code: 55, flag: 0x100000 } };

/** A key name or character -> { code, shift } (US layout), or null. */
function macKey(name) {
  if (MAC_KEYS[name] !== undefined) return { code: MAC_KEYS[name], shift: false };
  if (MAC_CHARS[name] !== undefined) return { code: MAC_CHARS[name], shift: false };
  if (/^[A-Z]$/.test(name)) return { code: MAC_CHARS[name.toLowerCase()], shift: true };
  if (MAC_SHIFTED[name]) return { code: MAC_CHARS[MAC_SHIFTED[name]], shift: true };
  return null;
}

// One osascript run executes a batch of input events, so a click or a burst of viewer input is one process.
const JXA_INPUT = `ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices');
function run(argv) {
  if (!$.AXIsProcessTrusted()) return 'NO_ACCESSIBILITY';
  var acts = JSON.parse(argv[0]);
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i], e = null;
    if (a.t === 'm') { e = $.CGEventCreateMouseEvent(null, a.type, { x: a.x, y: a.y }, a.b || 0); if (a.c) $.CGEventSetIntegerValueField(e, 1, a.c); if (a.flags) $.CGEventSetFlags(e, a.flags); }
    else if (a.t === 'k') { e = $.CGEventCreateKeyboardEvent(null, a.code, a.down); $.CGEventSetFlags(e, a.flags || 0); }
    else if (a.t === 's') { try { e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, a.dy, 0, 0); } catch (err) { e = $.CGEventCreateScrollWheelEvent(null, 1, 1, a.dy); } }
    else if (a.t === 'text') Application('System Events').keystroke(a.text);
    else if (a.t === 'wait') delay(a.s);
    if (e) { $.CGEventPost(0, e); delay(0.008); }
  }
  return 'ok';
}`;

const MAC_NO_AX = "macOS hasn't given this app Accessibility permission, so Bots can't click or type. Open System Settings → Privacy & Security → Accessibility, turn on the app that runs Swarm (Terminal, iTerm, Conductor…), then try again.";
const MAC_NO_SCREEN = "macOS blocked the screenshot. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on the app that runs Swarm (Terminal, iTerm, Conductor…), then restart Swarm.";
let shotSeq = 0;

const macBackend = {
  name: 'macOS',
  async size() {
    const out = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); var f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({ w: f.size.width, h: f.size.height })"]);
    return JSON.parse(out.toString());
  },
  async capture(width, quality) {
    const tmp = path.join(os.tmpdir(), `swarm-shot-${process.pid}-${++shotSeq}`);
    try {
      await exec('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', `${tmp}.jpg`], { timeoutMs: 20_000 }).catch((e) => { throw new Error(`${MAC_NO_SCREEN} (${e.message})`); });
      if (!fs.existsSync(`${tmp}.jpg`)) throw new Error(MAC_NO_SCREEN);
      await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '--resampleWidth', String(width), `${tmp}.jpg`, '--out', `${tmp}-s.jpg`], { timeoutMs: 20_000 });
      return fs.readFileSync(`${tmp}-s.jpg`);
    } finally {
      fs.rmSync(`${tmp}.jpg`, { force: true });
      fs.rmSync(`${tmp}-s.jpg`, { force: true });
    }
  },
  /** Run a batch of portable input ops. `state.flags` holds modifiers held down from the live viewer. */
  async run(ops, state) {
    const acts = [];
    const BTN = { left: 0, right: 1, middle: 2 };
    const DOWN = [1, 3, 25], UP = [2, 4, 26], DRAG = [6, 7, 27];
    for (const o of ops) {
      if (o.op === 'move') acts.push({ t: 'm', type: o.drag ? DRAG[BTN[o.drag] ?? 0] : 5, x: o.x, y: o.y, b: BTN[o.drag] ?? 0, flags: state.flags });
      else if (o.op === 'down' || o.op === 'up') acts.push({ t: 'm', type: (o.op === 'down' ? DOWN : UP)[BTN[o.button] ?? 0], x: o.x, y: o.y, b: BTN[o.button] ?? 0, c: o.count ?? 1, flags: state.flags });
      else if (o.op === 'scroll') {
        acts.push({ t: 'm', type: 5, x: o.x, y: o.y, b: 0 });
        acts.push({ t: 's', dy: -o.notches * 4 });
      } else if (o.op === 'combo') {
        const k = o.name === null ? null : macKey(o.name);
        if (o.name !== null && !k) throw new Error(`The key "${o.name}" isn't available on macOS.`);
        let flags = state.flags;
        const mods = [...o.mods, ...(k?.shift && !o.mods.includes('shift') ? ['shift'] : [])];
        for (const m of mods) { flags |= MAC_MODS[m].flag; acts.push({ t: 'k', code: MAC_MODS[m].code, down: true, flags }); }
        if (k) { acts.push({ t: 'k', code: k.code, down: true, flags }); acts.push({ t: 'k', code: k.code, down: false, flags }); }
        for (const m of [...mods].reverse()) { flags &= ~MAC_MODS[m].flag; acts.push({ t: 'k', code: MAC_MODS[m].code, down: false, flags: flags | state.flags }); }
      } else if (o.op === 'keysym') {
        const def = keyBySym(o.keysym);
        if (!def) continue;
        if (def.mod) {
          state.flags = o.down ? state.flags | MAC_MODS[def.mod].flag : state.flags & ~MAC_MODS[def.mod].flag;
          acts.push({ t: 'k', code: MAC_MODS[def.mod].code, down: o.down, flags: state.flags });
          continue;
        }
        const name = def.key === 'Enter' ? 'Return' : def.key === 'Backspace' ? 'BackSpace' : def.key === 'Escape' ? 'Escape' : def.key.startsWith('Arrow') ? def.key.slice(5) : def.key === 'PageUp' ? 'Page_Up' : def.key === 'PageDown' ? 'Page_Down' : def.key === ' ' ? 'space' : def.key;
        const k = macKey(name);
        if (k) acts.push({ t: 'k', code: k.code, down: o.down, flags: state.flags | (k.shift ? MAC_MODS.shift.flag : 0) });
        else if (o.down && def.text) acts.push({ t: 'text', text: def.text });
      } else if (o.op === 'text') acts.push({ t: 'text', text: o.text });
      else if (o.op === 'wait') acts.push({ t: 'wait', s: o.ms / 1000 });
    }
    if (!acts.length) return;
    const out = (await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_INPUT, JSON.stringify(acts)], { timeoutMs: 60_000 })).toString().trim();
    if (out === 'NO_ACCESSIBILITY') throw new Error(MAC_NO_AX);
  },
  /** Type text: keystrokes for plain ASCII, the clipboard (restored afterwards) for anything else. */
  async type(text, state) {
    if (/^[\x20-\x7e\t]*$/.test(text)) return this.run([{ op: 'text', text }], state);
    const old = await exec('/usr/bin/pbpaste', []).catch(() => null);
    await exec('/usr/bin/pbcopy', [], { input: text });
    await this.run([{ op: 'combo', mods: ['meta'], name: 'v' }, { op: 'wait', ms: 300 }], state);
    if (old !== null) await exec('/usr/bin/pbcopy', [], { input: old }).catch(() => {});
  },
  async open(url) { await exec('/usr/bin/open', [url]); },
  async checkPermissions() {
    const out = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); var ok = $.AXIsProcessTrusted(); if (!ok) { try { $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true })); } catch (e) {} } String(ok)"]).catch(() => Buffer.from('unknown'));
    if (out.toString().trim() === 'false') log(`WARNING: ${MAC_NO_AX}`);
  },
};

// --- Linux (X11): xdotool for input, ImageMagick's import (or ffmpeg) for pictures ---

const XBUTTON = { left: 1, middle: 2, right: 3 };
const xName = (name) => (name.length === 1 && CHAR_NAMES[name] ? CHAR_NAMES[name] : name === ' ' ? 'space' : name);
const XMOD = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' };
// xdotool reads text in the current locale; without a UTF-8 one, accented letters and emoji fail.
const UTF8_ENV = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '') ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' };

/**
 * An X11 display driven with xdotool. `display` picks the screen (":10"); `open` overrides how a
 * URL is opened (the default browser via xdg-open, or a Bot's own Chrome in --multi mode).
 */
function makeLinuxBackend({ display = process.env.DISPLAY, open } = {}) {
  const xenv = { ...process.env, DISPLAY: display };
  const tenv = { ...UTF8_ENV, DISPLAY: display };
  const x = (args, o = {}) => exec('xdotool', args, { env: xenv, ...o });
  return {
    name: 'Linux',
    display,
    stream: (size, fps, onFrame) => streamDesktop(display, size, fps, onFrame),
    async size() {
      const [w, h] = (await x(['getdisplaygeometry'])).toString().trim().split(/\s+/).map(Number);
      return { w, h };
    },
    async capture(width, quality) {
      try {
        return await exec('import', ['-silent', '-window', 'root', '-resize', `${width}x`, '-quality', String(quality), 'jpg:-'], { timeoutMs: 20_000, env: xenv });
      } catch (e) {
        if (!/isn't installed/.test(e.message)) throw e;
        return exec('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-i', display, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', '-'], { timeoutMs: 20_000, env: xenv })
          .catch((e2) => { throw new Error(/isn't installed/.test(e2.message) ? 'Screenshots need ImageMagick (import) or ffmpeg on this computer.' : e2.message); });
      }
    },
    async run(ops) {
      const args = [];
      for (const o of ops) {
        if (o.op === 'move') args.push('mousemove', String(o.x), String(o.y));
        else if (o.op === 'down') args.push('mousemove', String(o.x), String(o.y), 'mousedown', String(XBUTTON[o.button] ?? 1));
        else if (o.op === 'up') args.push('mousemove', String(o.x), String(o.y), 'mouseup', String(XBUTTON[o.button] ?? 1));
        else if (o.op === 'scroll') args.push('mousemove', String(o.x), String(o.y), 'click', '--repeat', String(Math.abs(o.notches)), '--delay', '30', o.notches > 0 ? '5' : '4');
        else if (o.op === 'combo') args.push('key', '--clearmodifiers', [...o.mods.map((m) => XMOD[m]), ...(o.name === null ? [] : [xName(o.name)])].join('+'));
        else if (o.op === 'keysym') args.push(o.down ? 'keydown' : 'keyup', `0x${(o.keysym >>> 0).toString(16)}`);
        else if (o.op === 'wait') args.push('sleep', String(o.ms / 1000));
        else if (o.op === 'text') { if (args.length) { await x(args.splice(0)); } await exec('xdotool', ['type', '--delay', '12', '--', o.text], { timeoutMs: 120_000, env: tenv }); }
      }
      if (args.length) await x(args, { timeoutMs: 60_000 });
    },
    async type(text) { return this.run([{ op: 'text', text }]); },
    async open(url) {
      if (open) return open(url);
      const p = spawn('xdg-open', [url], { stdio: 'ignore', detached: true, env: xenv });
      p.on('error', () => {});
      p.unref();
    },
    async checkPermissions() {},
  };
}
const linuxBackend = makeLinuxBackend();

/** This computer's desktop, shared by every Bot. */
class Desktop {
  /** shell: { cwd, env, user } for shell commands (defaults: home folder, this process's user). */
  constructor(backend, shell = {}) {
    this.b = backend;
    this.shellOpts = shell;
    this.logical = { w: 1280, h: 800 };
    this.img = null; // size of the last picture sent (Bots' coordinates are in it)
    this.state = { flags: 0 }; // modifiers held from the live viewer (macOS)
    this.queue = Promise.resolve();
    this.viewers = new Map(); // botId -> aggregate viewer mode
    this.streamFps = 0;
    this.casting = false;
    this.castGeneration = 0;
    this.stopStream = null;
    this.pendingInput = [];
    this.draining = false;
    this.used = new Map(); // botId -> last used
  }

  async init() {
    this.logical = await this.b.size();
    await this.b.checkPermissions();
  }

  get shotWidth() { return Math.min(MAX_SHOT_W, Math.round(this.logical.w)); }

  /** A point in the picture the Bot saw -> screen coordinates. */
  pt(x, y, picture = this.img) {
    const iw = picture?.width || this.shotWidth;
    const ih = picture?.height || Math.round((this.logical.h * iw) / this.logical.w);
    const cx = Math.max(0, Math.min(Number(x) || 0, iw - 1));
    const cy = Math.max(0, Math.min(Number(y) || 0, ih - 1));
    return { x: Math.round((cx * this.logical.w) / iw), y: Math.round((cy * this.logical.h) / ih) };
  }

  /** Serialize actions so two never interleave (e.g. a Bot's drag and viewer input). */
  serial(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  run(ops) { return this.serial(() => this.b.run(ops, this.state)); }

  async picture(quality) {
    const data = await this.b.capture(this.shotWidth, quality);
    const size = jpegSize(data) ?? { width: this.shotWidth, height: Math.round((this.logical.h * this.shotWidth) / this.logical.w) };
    return { data, ...size };
  }

  async screenshot() {
    this.logical = await this.b.size().catch(() => this.logical);
    const p = await this.picture(70);
    this.img = { width: p.width, height: p.height };
    return { data: p.data.toString('base64'), width: p.width, height: p.height };
  }

  async open(raw) {
    let u;
    try { u = new URL(raw); } catch { try { u = new URL(`https://${raw}`); } catch { throw new Error(`Not a valid URL: ${raw}`); } }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) pages can be opened (not ${u.protocol}). Use the shell for other things.`);
    await this.serial(() => this.b.open(u.href));
    // Cloud screens use Playwright navigation, which already waits for the page.
    if (!MULTI || !PLAYWRIGHT_MCP) await sleep(2500);
    return { url: u.href };
  }

  click({ x, y, button = 'left', double = false }) {
    const p = this.pt(x, y);
    const ops = [{ op: 'move', ...p }];
    for (let n = 1; n <= (double ? 2 : 1); n++) ops.push({ op: 'down', ...p, button, count: n }, { op: 'up', ...p, button, count: n });
    return this.run(ops);
  }

  drag({ start_x, start_y, end_x, end_y }) {
    const a = this.pt(start_x, start_y);
    const b = this.pt(end_x, end_y);
    const ops = [{ op: 'move', ...a }, { op: 'down', ...a, button: 'left' }];
    for (let i = 1; i <= 10; i++) ops.push({ op: 'move', x: Math.round(a.x + ((b.x - a.x) * i) / 10), y: Math.round(a.y + ((b.y - a.y) * i) / 10), drag: 'left' }, { op: 'wait', ms: 15 });
    ops.push({ op: 'up', ...b, button: 'left' });
    return this.run(ops);
  }

  scroll({ x, y, direction, amount = 3 }) {
    const n = Math.max(1, Math.min(Number(amount) || 3, 30));
    return this.run([{ op: 'scroll', ...this.pt(x, y), notches: direction === 'up' ? -n : n }]);
  }

  async type(text) {
    const parts = String(text).split('\n');
    await this.serial(async () => {
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) await this.b.type(parts[i], this.state);
        if (i < parts.length - 1) await this.b.run([{ op: 'combo', mods: [], name: 'Return' }], this.state);
      }
    });
  }

  async key(keys) {
    const c = parseCombo(keys);
    await this.run([{ op: 'combo', mods: c.mods, name: c.name }]);
    return {};
  }

  /** Live viewer input: queued, and sent in batches (moves collapsed) so it keeps up. */
  input(p) {
    this.pendingInput.push(p);
    if (!this.draining) void this.drain();
  }

  async drain() {
    this.draining = true;
    try {
      while (this.pendingInput.length) {
        const batch = this.pendingInput.splice(0);
        const ops = [];
        for (const [i, e] of batch.entries()) {
          if (e.kind === 'mouse') {
            const pt = this.pt(e.x, e.y, e.width && e.height ? { width: e.width, height: e.height } : this.img);
            if (e.type === 'mouseMoved') {
              if (batch[i + 1]?.kind === 'mouse' && batch[i + 1].type === 'mouseMoved') continue; // only the latest move matters
              const held = e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : e.buttons & 4 ? 'middle' : null;
              ops.push({ op: 'move', ...pt, ...(held ? { drag: held } : {}) });
            } else ops.push({ op: e.type === 'mousePressed' ? 'down' : 'up', ...pt, button: e.button, count: e.clickCount ?? 1 });
          } else if (e.kind === 'wheel') ops.push({ op: 'scroll', ...this.pt(e.x, e.y, e.width && e.height ? { width: e.width, height: e.height } : this.img), notches: e.deltaY > 0 ? 1 : -1 });
          else if (e.kind === 'key') ops.push({ op: 'keysym', keysym: e.keysym >>> 0, down: !!e.down });
        }
        await this.run(ops).catch((err) => log(`Viewer input failed: ${err.message}`));
      }
    } finally {
      this.draining = false;
    }
  }

  async shell(command, timeoutSec = 120) {
    const { cwd = os.homedir(), env = process.env, user } = this.shellOpts;
    const sh = user ? '/bin/bash' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    // --run-as: the Bot's shell runs as a separate, unprivileged user (it can't read the companion's token).
    const [cmd, args] = user ? ['sudo', ['-n', '-u', user, '-H', '--', 'env', `DISPLAY=${env.DISPLAY ?? ''}`, sh, '-lc', `cd ${JSON.stringify(cwd)} 2>/dev/null; ${command}`]] : [sh, ['-lc', command]];
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd: user ? '/' : cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let out = '';
      const add = (d) => { out = (out + d).slice(-40_000); };
      p.stdout.on('data', add);
      p.stderr.on('data', add);
      let timedOut = false;
      const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }, Math.max(1, timeoutSec) * 1000);
      p.on('error', (e) => { clearTimeout(t); resolve({ exit_code: 127, output: e.message }); });
      p.on('close', (code) => { clearTimeout(t); resolve({ exit_code: timedOut ? 124 : code ?? 1, output: timedOut ? `${out}\n[stopped after ${timeoutSec}s]` : out }); });
    });
  }

  get requestedFps() { return [...this.viewers.values()].includes('control') ? CONTROL_FPS : VIEWER_FPS; }
  get streamWeight() { return [...this.viewers.values()].includes('control') ? 3 : 1; }

  startScreencast(botId, mode = 'watch') {
    this.viewers.set(botId, mode);
    watchedDesktops.add(this);
    balanceDesktopStreams();
  }

  stopScreencast(botId) {
    this.viewers.delete(botId);
    if (!this.viewers.size) {
      watchedDesktops.delete(this);
      this.setStreamFps(0);
    }
    balanceDesktopStreams();
  }

  stopScreencasts() { for (const id of this.viewers.keys()) this.stopScreencast(id); }

  setStreamFps(fps) {
    if (fps === this.streamFps && (this.casting || !fps)) return;
    this.streamFps = fps;
    this.castGeneration++;
    this.stopStream?.();
    this.stopStream = null;
    this.casting = false;
    if (fps) void this.cast(fps);
  }

  async cast(fps) {
    this.casting = true;
    const generation = ++this.castGeneration;
    const active = () => generation === this.castGeneration && this.viewers.size > 0;
    const publish = (data) => { if (active()) for (const botId of this.viewers.keys()) send({ event: 'frame', botId, data }); };
    let failing = false;
    try {
      if (this.b.stream) {
        try {
          const stream = this.b.stream(this.logical, fps, publish);
          this.stopStream = stream.stop;
          await stream.done;
        } catch (e) { if (active()) log(`Live view using screenshot fallback: ${e.message}`); }
        if (generation === this.castGeneration) this.stopStream = null;
      }
      while (active()) {
        const t0 = Date.now();
        try {
          const p = await this.picture(55);
          publish(p.data);
          failing = false;
        } catch (e) {
          if (!failing) log(`Live view: ${e.message}`);
          failing = true;
          await sleep(2000);
        }
        // Fallback starts a screenshot process each time, so cap it independently at 8 fps.
        await sleep(Math.max(16, 1000 / Math.min(fps, 8) - (Date.now() - t0)));
      }
    } finally {
      if (generation === this.castGeneration) this.casting = false;
    }
  }
}

let desktop = null;
if (DESKTOP) {
  if (process.platform === 'darwin') desktop = new Desktop(macBackend);
  else if (process.platform === 'linux') {
    if (!process.env.DISPLAY) {
      console.error(process.env.WAYLAND_DISPLAY ? 'Full-desktop mode needs an X11 session (Wayland isn\'t supported yet). Log in with "Xorg"/"X11" and try again.' : 'Full-desktop mode needs a graphical session: DISPLAY is not set.');
      process.exit(2);
    }
    desktop = new Desktop(linuxBackend);
  } else {
    console.error('Full-desktop mode (--desktop) supports macOS and Linux (X11). On this computer, run the companion without --desktop to give Bots a browser.');
    process.exit(2);
  }
  try { await desktop.init(); } catch (e) {
    console.error(`Could not use this computer's desktop: ${e.message}`);
    process.exit(2);
  }
}

// ---------- Playwright: browser tools on each Bot's own Chrome (--multi) ----------
//
// Every browser action on a cloud VM goes through Playwright MCP (@playwright/mcp), attached over the
// Chrome DevTools protocol to the Bot's visible, logged-in Chrome on its own screen. One MCP process
// per Bot; it runs as this companion's user and reaches Chrome on a port only this machine can use.

/** The tools Bots may call (server/src/computers/browser-tools.ts lists the same ones). */
const BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_file_upload', 'browser_handle_dialog',
  'browser_tabs', 'browser_wait_for', 'browser_take_screenshot', 'browser_find', 'browser_evaluate', 'browser_console_messages',
]);

function findPlaywrightMcp() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    opt('playwright-mcp', process.env.PLAYWRIGHT_MCP_CLI),
    path.join(here, 'node_modules/@playwright/mcp/cli.js'),
    path.join(here, '../node_modules/@playwright/mcp/cli.js'),
    '/usr/lib/node_modules/@playwright/mcp/cli.js',
    '/usr/local/lib/node_modules/@playwright/mcp/cli.js',
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** A minimal MCP client over stdio (newline-delimited JSON-RPC). */
class McpProcess {
  constructor(cli, args, cwd) {
    this.proc = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 0;
    this.dead = false;
    let buf = '';
    let err = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    this.proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    this.proc.on('exit', () => {
      this.dead = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Playwright stopped${err ? `: ${err.trim().split('\n').pop()}` : ''}`)); }
      this.pending.clear();
    });
    this.proc.stdin.on('error', () => {});
  }
  request(method, params, timeoutMs = 120_000) {
    if (this.dead) return Promise.reject(new Error('Playwright stopped'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Playwright timed out (${method})`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'swarm-companion', version: VERSION } }, 30_000);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }
  close() { try { this.proc.kill(); } catch { /* gone */ } }
}

const PLAYWRIGHT_MCP = MULTI ? findPlaywrightMcp() : null;

/** Tools after which the page usually changed: their results include the updated page snapshot. */
const PAGE_CHANGING = new Set(['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option',
  'browser_press_key', 'browser_drag', 'browser_file_upload', 'browser_handle_dialog', 'browser_tabs', 'browser_wait_for']);

// ---------- one screen per Bot (--multi: a user's cloud VM) ----------

const SCREEN_W = bounded(opt('screen-width', process.env.SWARM_SCREEN_WIDTH ?? '1920'), 1920, 800, 3840);
const SCREEN_H = bounded(opt('screen-height', process.env.SWARM_SCREEN_HEIGHT ?? '1080'), 1080, 600, 2160);
const RUN_AS = opt('run-as', '');
const AGENT_HOME = path.resolve(opt('agent-home', RUN_AS ? `/home/${RUN_AS}` : DATA_DIR));
/** A command as the Bots' user (--run-as), so their shells and browsers can't read this process's token. */
const asAgent = (cmd, args) => (RUN_AS ? ['sudo', ['-n', '-u', RUN_AS, '-H', '--', cmd, ...args]] : [cmd, args]);
const have = (cmd) => { try { return (spawnSync('sh', ['-c', `command -v ${cmd}`]).status ?? 1) === 0; } catch { return false; } };

/** Bot id -> its screen: an X display with its own desktop, Chrome profile and shell folder. */
const screens = new Map();
const usedDisplays = new Set();

function freeDisplay() {
  for (let n = 10; n < 300; n++) {
    if (!usedDisplays.has(n) && !fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('No free display number.');
}

async function createScreen(botId) {
  const n = freeDisplay();
  usedDisplays.add(n);
  const display = `:${n}`;
  const env = { ...process.env, DISPLAY: display };
  const procs = [];
  const start = (cmd, args, e = env) => { const p = spawn(cmd, args, { env: e, stdio: 'ignore' }); p.on('error', () => {}); procs.push(p); return p; };
  try {
    // -ac: the Bots' user (a different Unix user) may draw on this display; -nolisten tcp keeps it local.
    start('Xvfb', [display, '-screen', '0', `${SCREEN_W}x${SCREEN_H}x24`, '-nolisten', 'tcp', '-ac']);
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    if (!fs.existsSync(`/tmp/.X11-unix/X${n}`)) throw new Error('The virtual screen (Xvfb) did not start.');
    if (have('xfwm4')) start('xfwm4', ['--compositor=off']);
    if (have('xfdesktop')) start('dbus-run-session', ['--', 'xfdesktop', '--disable-wm-check']);
    const botDir = path.join(AGENT_HOME, 'bots', botId);
    const profile = path.join(AGENT_HOME, 'profiles', botId);
    const [mc, ma] = asAgent('mkdir', ['-p', botDir, profile]);
    await exec(mc, ma);
    // Chrome's DevTools port for Playwright: on loopback only, one per screen.
    const cdpPort = 9200 + n;
    const cdpUp = () => fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    let chromeStarting = null;
    const ensureChrome = () => chromeStarting ??= (async () => {
      if (await cdpUp()) return;
      const [c, a] = asAgent('env', [`DISPLAY=${display}`, CHROME, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--disable-features=Translate,MediaRouter', '--hide-crash-restore-bubble',
        '--window-position=0,0', `--window-size=${SCREEN_W},${SCREEN_H}`, '--start-maximized', ...(NO_SANDBOX ? ['--no-sandbox'] : []), 'about:blank']);
      const p = spawn(c, a, { env, stdio: 'ignore' });
      p.on('error', () => {});
      for (let i = 0; i < 80 && !(await cdpUp()); i++) await sleep(250);
      if (!(await cdpUp())) throw new Error('Chrome did not start.');
      // Give Chrome the keyboard too: a window manager on a virtual screen doesn't always focus new windows.
      const ids = (await exec('xdotool', ['search', '--onlyvisible', '--class', '[Cc]hrome'], { env }).catch(() => Buffer.from(''))).toString().trim().split('\n').filter(Boolean);
      if (ids.length) await exec('xdotool', ['windowactivate', ids.at(-1)], { env }).catch(() => {});
    })().finally(() => { chromeStarting = null; });
    let mcp = null;
    let mcpStarting = null;
    // One Playwright per Bot, even when the warm-up and the first task ask at the same moment.
    const getMcp = async () => {
      if (mcp && !mcp.dead) return mcp;
      return (mcpStarting ??= (async () => {
        const out = path.join(DATA_DIR, 'playwright', botId);
        fs.mkdirSync(out, { recursive: true });
        mcp = await new McpProcess(PLAYWRIGHT_MCP, ['--cdp-endpoint', `http://127.0.0.1:${cdpPort}`, '--output-dir', out, '--image-responses', 'allow',
          '--timeout-settle', String(bounded(process.env.SWARM_BROWSER_SETTLE_MS ?? '150', 150, 0, 2000))], out).init();
        return mcp;
      })().finally(() => { mcpStarting = null; }));
    };
    const browser = async (tool, args = {}) => {
      if (!BROWSER_TOOLS.has(tool)) throw new Error(`Unknown browser tool ${tool}.`);
      if (!PLAYWRIGHT_MCP) throw new Error('The browser tools are not installed on this computer yet (it updates on its next restart). For now, use open_browser and the computer_* tools.');
      await ensureChrome();
      const mcp = await getMcp();
      const r = await mcp.request('tools/call', { name: tool, arguments: args }, 150_000);
      let content = r?.content ?? [];
      // After an action that changes the page, return the updated page too, so the Bot doesn't need
      // another round trip to read it (Playwright saves that snapshot to a file the Bot can't open).
      const mentionsSnapshot = content.some((c) => c.type === 'text' && /- \[Snapshot\]\(/.test(c.text));
      if (!r?.isError && PAGE_CHANGING.has(tool) && mentionsSnapshot) {
        // The action already took a snapshot. Read that exact file rather than making
        // Playwright observe the page a second time. Only its own output directory is readable.
        const out = path.join(DATA_DIR, 'playwright', botId);
        let text = '';
        try {
          const link = content.filter(c => c.type === 'text').map(c => c.text).join('\n').match(/^- \[Snapshot\]\(([^)]+)\)/m)?.[1];
          if (link) {
            const file = fs.realpathSync(path.resolve(out, link));
            const root = fs.realpathSync(out) + path.sep;
            if (file.startsWith(root) && fs.statSync(file).size <= 2 * 1024 * 1024) text = `### Snapshot\n\`\`\`yaml\n${fs.readFileSync(file, 'utf8')}\n\`\`\``;
          }
        } catch { /* a different MCP version may not expose a readable file */ }
        if (!text) {
          const snap = await mcp.request('tools/call', { name: 'browser_snapshot', arguments: {} }, 60_000).catch(() => null);
          text = (snap?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        }
        if (text) {
          content = content.map((c) => (c.type === 'text' ? { ...c, text: c.text.replace(/- \[Snapshot\]\([^)]*\)\n?/g, '') } : c));
          content.push({ type: 'text', text });
        } else content.push({ type: 'text', text: 'The page snapshot could not be read. Call browser_snapshot before choosing element targets.' });
      } else {
        content = content.map((c) => (c.type === 'text' ? { ...c, text: c.text.replace(/- \[Snapshot\]\([^)]*\)/g, '- Call browser_snapshot to read the page.') } : c));
      }
      // The generated Playwright code is noise for the Bot (and costs tokens): keep the result and the page.
      content = content.map((c) => (c.type === 'text' ? { ...c, text: c.text.replace(/### Ran Playwright code\n```js\n[\s\S]*?\n```\n?/g, '').trim() } : c)).filter((c) => c.type !== 'text' || c.text);
      return { content, isError: !!r?.isError };
    };
    // Warm start: Chrome and Playwright come up in the background, so the first browser action is quick.
    const warm = () => { if (PLAYWRIGHT_MCP) browser('browser_tabs', { action: 'list' }).catch((e) => log(`Browser warm-up for ${botId}: ${e.message}`)); };
    const openUrl = async (url) => {
      if (PLAYWRIGHT_MCP) return void (await browser('browser_navigate', { url }));
      // An older VM image without Playwright: open the page in the Bot's Chrome directly.
      await ensureChrome();
      const [c, a] = asAgent('env', [`DISPLAY=${display}`, CHROME, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, ...(NO_SANDBOX ? ['--no-sandbox'] : []), url]);
      spawn(c, a, { env, stdio: 'ignore' }).on('error', () => {});
    };
    const d = new Desktop(makeLinuxBackend({ display, open: openUrl }), { cwd: botDir, env, user: RUN_AS || undefined });
    await d.init();
    log(`Screen ${display} ready for Bot ${botId}${PLAYWRIGHT_MCP ? '' : ' (Playwright not found: browser tools unavailable)'}`);
    return { botId, n, display, profile, procs, desktop: d, browser, warm, closeBrowser: () => mcp?.close() };
  } catch (e) {
    for (const p of procs.reverse()) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    usedDisplays.delete(n);
    throw e;
  }
}

function screenFor(botId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(botId))) throw new Error('bad bot id');
  let p = screens.get(botId);
  if (!p) {
    p = createScreen(botId);
    screens.set(botId, p);
    p.then((s) => { reportBrowsers(); s.warm?.(); }, () => { if (screens.get(botId) === p) screens.delete(botId); });
  }
  return p;
}

async function closeScreen(botId) {
  const p = screens.get(botId);
  if (!p) return;
  screens.delete(botId);
  reportBrowsers();
  const s = await p.catch(() => null);
  if (!s) return;
  s.desktop.stopScreencasts();
  s.closeBrowser?.();
  const [kc, ka] = asAgent('pkill', ['-f', `--user-data-dir=${s.profile}`]);
  await exec(kc, ka).catch(() => {});
  for (const proc of s.procs.reverse()) { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
  usedDisplays.delete(s.n);
  log(`Closed screen ${s.display} of Bot ${botId} (its browser profile is kept)`);
}

if (MULTI && process.platform !== 'linux') {
  console.error('--multi runs on Linux (a cloud VM with Xvfb).');
  process.exit(2);
}

// ---------- browsers by Bot ----------

const browsers = new Map(); // botId -> Promise<BotBrowser>
let socket = null;
let binaryFrames = false;

const send = (msg) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  // Drop obsolete video under congestion so it cannot queue seconds of stale frames
  // in front of action replies. RPC responses and input acknowledgements are never dropped.
  if (msg.event === 'frame') {
    if (socket.bufferedAmount > 256 * 1024) return;
    if (binaryFrames) {
      const bot = Buffer.from(msg.botId);
      const header = Buffer.from([0x53, 0x57, 0x46, 0x31, bot.length]); // SWF1 + one-byte Bot ID length
      socket.send(Buffer.concat([header, bot, Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data, 'base64')]));
      return;
    }
    if (Buffer.isBuffer(msg.data)) msg = { ...msg, data: msg.data.toString('base64') };
  }
  socket.send(JSON.stringify(msg));
};
const reportBrowsers = () => send({ event: 'browsers', bots: MULTI ? [...screens.keys()] : desktop ? [...desktop.used.keys()] : [...browsers.keys()] });

function browserFor(botId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(botId))) throw new Error('bad bot id');
  let p = browsers.get(botId);
  if (!p) {
    const b = new BotBrowser(
      botId,
      (id, data) => send({ event: 'frame', botId: id, data }),
      () => { if (browsers.get(botId) === p) { browsers.delete(botId); reportBrowsers(); } },
    );
    p = b.start().then(() => b);
    browsers.set(botId, p);
    p.then(() => { log(`Opened a browser for Bot ${botId}`); reportBrowsers(); }, (e) => { log(`Could not open a browser for Bot ${botId}: ${e.message}`); b.close(); if (browsers.get(botId) === p) browsers.delete(botId); });
  }
  return p.then((b) => { b.lastUsed = Date.now(); return b; });
}

async function closeBrowser(botId) {
  const p = browsers.get(botId);
  if (!p) return;
  browsers.delete(botId);
  reportBrowsers();
  try { (await p).close(); } catch { /* never started */ }
}

const METHODS = {
  screenshot: async (b) => b.screenshot(),
  open: async (b, p) => b.open(String(p.url ?? '')),
  click: async (b, p) => b.click(p),
  drag: async (b, p) => b.drag(p),
  type: async (b, p) => b.type(String(p.text ?? '')),
  key: async (b, p) => b.key(String(p.keys ?? '')),
  scroll: async (b, p) => b.scroll(p),
  'screencast.start': async (b) => b.startScreencast(),
  'screencast.stop': async (b) => b.stopScreencast(),
};

// Full desktop: every Bot shares this computer's screen.
const DESKTOP_METHODS = {
  screenshot: (d) => d.screenshot(),
  open: (d, p) => d.open(String(p.url ?? '')),
  click: (d, p) => d.click(p),
  drag: (d, p) => d.drag(p),
  type: (d, p) => d.type(String(p.text ?? '')),
  key: (d, p) => d.key(String(p.keys ?? '')),
  scroll: (d, p) => d.scroll(p),
  shell: (d, p) => d.shell(String(p.command ?? ''), Number(p.timeout) || 120),
  'screencast.start': (d, p) => d.startScreencast(p.botId, p.mode),
  'screencast.stop': (d, p) => d.stopScreencast(p.botId),
};

async function handleDesktop(msg) {
  const { id, method, params = {} } = msg;
  try {
    let result;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(params.botId))) throw new Error('bad bot id');
    if (MULTI) {
      // Each Bot has its own screen; nothing is shared between Bots but the shell's machine.
      if (method === 'input') { const sp = screens.get(params.botId); if (sp) (await sp).desktop.input(params); return; }
      if (method === 'close') result = await closeScreen(params.botId);
      else if (method === 'browser') {
        const tool = String(params.tool ?? '');
        result = await (await screenFor(params.botId)).browser(tool, params.args && typeof params.args === 'object' ? params.args : {});
        log(`${params.botId} ${tool}${tool === 'browser_navigate' ? ` ${params.args?.url}` : ''}`);
      }
      else if (method === 'screencast.stop' && !screens.has(params.botId)) result = {};
      else if (DESKTOP_METHODS[method]) {
        const d = (await screenFor(params.botId)).desktop;
        result = await DESKTOP_METHODS[method](d, params);
        if (!['screenshot', 'screencast.start', 'screencast.stop'].includes(method)) log(`${params.botId} ${method}${method === 'open' ? ` ${params.url}` : method === 'key' ? ` ${params.keys}` : method === 'shell' ? ` ${String(params.command).slice(0, 80)}` : ''}`);
      } else throw new Error(`Unknown method ${method}`);
      if (id !== undefined) send({ id, result: result ?? {} });
      return;
    }
    if (method === 'input') return desktop.input(params);
    if (method === 'close') {
      desktop.stopScreencast(params.botId);
      if (desktop.used.delete(params.botId)) reportBrowsers();
    } else if (DESKTOP_METHODS[method]) {
      if (!params.peek && !method.startsWith('screencast.')) {
        const first = !desktop.used.has(params.botId);
        desktop.used.set(params.botId, Date.now());
        if (first) reportBrowsers();
      }
      result = await DESKTOP_METHODS[method](desktop, params);
      if (!['screenshot', 'screencast.start', 'screencast.stop'].includes(method)) log(`${params.botId} ${method}${method === 'open' ? ` ${params.url}` : method === 'key' ? ` ${params.keys}` : method === 'shell' ? ` ${String(params.command).slice(0, 80)}` : ''}`);
    } else throw new Error(`Unknown method ${method}`);
    if (id !== undefined) send({ id, result: result ?? {} });
  } catch (e) {
    if (id !== undefined) send({ id, error: String(e?.message ?? e) });
  }
}

async function handle(msg) {
  if (desktop || MULTI) return handleDesktop(msg);
  const { id, method, params = {} } = msg;
  try {
    let result;
    if (method === 'close') result = await closeBrowser(params.botId);
    else if (method === 'input') { const b = await browsers.get(params.botId); if (b) await b.input(params); return; }
    else if (METHODS[method]) {
      const b = await browserFor(params.botId);
      result = await METHODS[method](b, params);
      if (method !== 'screenshot' && method !== 'screencast.start' && method !== 'screencast.stop') log(`${params.botId} ${method}${method === 'open' ? ` ${params.url}` : method === 'key' ? ` ${params.keys}` : ''}`);
    } else throw new Error(`Unknown method ${method}`);
    if (id !== undefined) send({ id, result: result ?? {} });
  } catch (e) {
    if (id !== undefined) send({ id, error: String(e?.message ?? e) });
  }
}

// Close browsers nobody has used for a while (keeps this PC light).
setInterval(async () => {
  if (MULTI) return; // screens stay until the server closes them; the whole VM sleeps when idle
  if (desktop) {
    const before = desktop.used.size;
    for (const [botId, t] of desktop.used) if (!desktop.viewers.has(botId) && Date.now() - t > IDLE_MS) desktop.used.delete(botId);
    if (desktop.used.size !== before) reportBrowsers();
    return;
  }
  for (const [botId, p] of browsers) {
    const b = await p.catch(() => null);
    if (b && !b.screencasting && Date.now() - b.lastUsed > IDLE_MS) { log(`Closing idle browser for Bot ${botId}`); await closeBrowser(botId); }
  }
}, 60_000).unref();

// ---------- connection to Swarm ----------

const wsUrl = `${SERVER.replace(/^http/, 'ws')}/api/companion`;
let backoff = 1000;

function connect() {
  const ws = new WebSocket(wsUrl);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, version: VERSION, name: os.hostname(), platform: `${process.platform}-${process.arch}`, headless: DESKTOP || MULTI ? false : !HEADED, desktop: DESKTOP && !MULTI, mode: MULTI ? 'multi' : DESKTOP ? 'desktop' : 'browser', width: MULTI ? SCREEN_W : desktop?.shotWidth ?? W, height: MULTI ? SCREEN_H : desktop ? Math.round((desktop.logical.h * desktop.shotWidth) / desktop.logical.w) : H }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (msg.type === 'welcome') {
      binaryFrames = msg.binaryFrames === true;
      backoff = 1000;
      if (MULTI && msg.mode !== 'multi') {
        console.error('This Swarm server is not set up for cloud VMs (COMPUTER_PROVIDER=cloudvm); --multi is refused.');
        shutdown(1);
        return;
      }
      if (MULTI) log(`Connected to ${SERVER}. Cloud VM ready: one screen per Bot.`);
      else if (DESKTOP && msg.mode !== 'desktop') {
        console.error('This Swarm server gives Bots a browser only (COMPUTER_PROVIDER=local). Start the companion without --desktop, or set COMPUTER_PROVIDER=desktop on the server.');
        shutdown(1);
        return;
      }
      else if (DESKTOP) log(`Connected to ${SERVER}. Your Bots can now use this computer's desktop (${desktop.b.name}, ${desktop.logical.w}x${desktop.logical.h}) and a shell. Press Ctrl+C to stop.`);
      else log(`Connected to ${SERVER}. Your Bots can now use a browser on this PC${HEADED ? '' : ' (headless; watch it from Swarm)'}. Press Ctrl+C to stop.`);
      reportBrowsers();
      return;
    }
    if (msg.method) void handle(msg);
  };
  ws.onclose = (ev) => {
    if (socket === ws) {
      socket = null;
      binaryFrames = false;
      desktop?.stopScreencasts();
      for (const pending of screens.values()) void pending.then(s => s.desktop.stopScreencasts(), () => {});
      for (const pending of browsers.values()) void pending.then(b => b.stopScreencast(), () => {}).catch(() => {});
    }
    if (ev.code === 4401) { console.error('Swarm rejected the pairing token. Get a new command from Settings → Computer → Connect your PC.'); shutdown(1); return; }
    if (ev.code === 4403) { console.error(ev.reason || 'Swarm refused this companion.'); shutdown(1); return; }
    if (ev.code === 4409) { console.error('Another companion connected with this account, so this one is stopping.'); shutdown(1); return; }
    log(`Disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}). Reconnecting in ${Math.round(backoff / 1000)}s…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MULTI ? 2_000 : 30_000);
  };
  ws.onerror = () => { /* onclose follows */ };
}

// A cloud VM that was suspended wakes with a dead connection: notice the clock jump and reconnect now.
if (MULTI) {
  let tick = Date.now();
  setInterval(() => {
    const t = Date.now();
    if (t - tick > 5_000 && socket) { log('Woke up after a pause; reconnecting.'); try { socket.close(); } catch { /* */ } }
    tick = t;
  }, 1_000).unref();
}

async function shutdown(code = 0) {
  for (const botId of [...screens.keys()]) await closeScreen(botId).catch(() => {});
  for (const botId of [...browsers.keys()]) await closeBrowser(botId).catch(() => {});
  try { socket?.close(); } catch { /* */ }
  process.exit(code);
}
process.on('SIGINT', () => { log('Stopping…'); void shutdown(0); });
process.on('SIGTERM', () => void shutdown(0));

if (PARENT_PID) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0); } catch { log('Swarm server stopped; stopping too.'); void shutdown(0); }
  }, 3000).unref();
}

if (MULTI) log(`Swarm companion ${VERSION} · CLOUD VM: one screen per Bot${RUN_AS ? ` · Bots run as ${RUN_AS}` : ''} · files in ${AGENT_HOME}`);
else if (DESKTOP) log(`Swarm companion ${VERSION} · FULL DESKTOP: Bots can see this screen, use the mouse and keyboard, and run shell commands as ${os.userInfo().username}`);
else log(`Swarm companion ${VERSION} · Chrome: ${CHROME} · profiles: ${path.join(DATA_DIR, 'profiles')}${ALLOW_PRIVATE ? ' · local network ALLOWED' : ''}`);
connect();
