#!/usr/bin/env node
// Grokbot companion: lets your Bots use a Chrome browser on this PC.
//
//   node grokbot-companion.mjs --server https://your-grokbot.example --token gbc_...
//
// Get the token (and the full command) from Grokbot: Settings → Computer → Connect your PC.
// Requires Node.js 22+ and Google Chrome (or Chromium). No other dependencies.
//
// What it does:
// - Connects out to your Grokbot server (no open ports on this PC) and waits for work.
// - Starts a separate Chrome per Bot, each with its own profile under --data-dir (default
//   ~/.grokbot-companion). Your everyday Chrome profile is never touched.
// - Drives Chrome through the DevTools protocol over a private pipe (no debugging port).
//
// Guard rails (enforced here, on your PC):
// - Bots get a browser only: no shell, no files from this PC.
// - Only http(s) pages; local-network and localhost addresses are blocked unless you pass
//   --allow-private-network.
// - Downloads are blocked and file-upload dialogs never open.
//
// Options:
//   --server URL              Grokbot server URL (or GROKBOT_SERVER)
//   --token TOKEN             pairing token (or GROKBOT_TOKEN)
//   --headed                  show the Chrome windows instead of running headless
//   --chrome PATH             Chrome/Chromium executable (or CHROME_PATH)
//   --data-dir DIR            where Bot profiles live (default ~/.grokbot-companion)
//   --allow-private-network   let Bots open localhost / LAN addresses
//   --no-sandbox              pass --no-sandbox to Chrome (only for containers/root)
//   --idle-minutes N          close a Bot's browser after N idle minutes (default 30)

import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.0.0';
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
const SERVER = (opt('server', process.env.GROKBOT_SERVER) ?? '').replace(/\/+$/, '');
const TOKEN = opt('token', process.env.GROKBOT_TOKEN);
const HEADED = flag('headed');
const DATA_DIR = path.resolve(opt('data-dir', path.join(os.homedir(), '.grokbot-companion')));
const ALLOW_PRIVATE = flag('allow-private-network');
const NO_SANDBOX = flag('no-sandbox');
const IDLE_MS = Number(opt('idle-minutes', '30')) * 60_000;

if (!SERVER || !TOKEN) {
  console.error('Usage: node grokbot-companion.mjs --server <grokbot url> --token <pairing token>\nGet both from Grokbot: Settings → Computer → Connect your PC.');
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
const CHROME = findChrome();

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

  // Live viewer input (someone took control in Grokbot).
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

// ---------- browsers by Bot ----------

const browsers = new Map(); // botId -> Promise<BotBrowser>
let socket = null;

const send = (msg) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); };
const reportBrowsers = () => send({ event: 'browsers', bots: [...browsers.keys()] });

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

async function handle(msg) {
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
  for (const [botId, p] of browsers) {
    const b = await p.catch(() => null);
    if (b && !b.screencasting && Date.now() - b.lastUsed > IDLE_MS) { log(`Closing idle browser for Bot ${botId}`); await closeBrowser(botId); }
  }
}, 60_000).unref();

// ---------- connection to Grokbot ----------

const wsUrl = `${SERVER.replace(/^http/, 'ws')}/api/companion`;
let backoff = 1000;

function connect() {
  const ws = new WebSocket(wsUrl);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, version: VERSION, name: os.hostname(), platform: `${process.platform}-${process.arch}`, headless: !HEADED, width: W, height: H }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (msg.type === 'welcome') {
      backoff = 1000;
      log(`Connected to ${SERVER}. Your Bots can now use a browser on this PC${HEADED ? '' : ' (headless; watch it from Grokbot)'}. Press Ctrl+C to stop.`);
      reportBrowsers();
      return;
    }
    if (msg.method) void handle(msg);
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    if (ev.code === 4401) { console.error('Grokbot rejected the pairing token. Get a new command from Settings → Computer → Connect your PC.'); shutdown(1); return; }
    if (ev.code === 4409) { console.error('Another companion connected with this account, so this one is stopping.'); shutdown(1); return; }
    log(`Disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}). Reconnecting in ${Math.round(backoff / 1000)}s…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  ws.onerror = () => { /* onclose follows */ };
}

async function shutdown(code = 0) {
  for (const botId of [...browsers.keys()]) await closeBrowser(botId).catch(() => {});
  try { socket?.close(); } catch { /* */ }
  process.exit(code);
}
process.on('SIGINT', () => { log('Stopping…'); void shutdown(0); });
process.on('SIGTERM', () => void shutdown(0));

log(`Grokbot companion ${VERSION} · Chrome: ${CHROME} · profiles: ${path.join(DATA_DIR, 'profiles')}${ALLOW_PRIVATE ? ' · local network ALLOWED' : ''}`);
connect();
