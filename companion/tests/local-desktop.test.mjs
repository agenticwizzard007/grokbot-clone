// Real browser and wire/lifecycle checks, isolated to a Linux Xvfb desktop. No app/server keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { descendantPids, findPlaywrightMcp } from '../swarm-companion.mjs';

const require = createRequire(import.meta.url);
const script = new URL('../swarm-companion.mjs', import.meta.url).pathname;
const cli = findPlaywrightMcp({ moduleUrl: new URL('../swarm-companion.mjs', import.meta.url).href });
const chromium = cli ? require(require.resolve('playwright', { paths: [cli] })).chromium : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000, details = () => '') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(30); }
  throw new Error(`Timed out. ${details()}`);
}
function alive(pid) { try { if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false; process.kill(pid, 0); return true; } catch { return false; } }
async function stop(proc) { if (!proc || proc.exitCode !== null || proc.signalCode !== null) return; proc.kill('SIGTERM'); await until(() => proc.exitCode !== null || proc.signalCode !== null, 10000); }
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

test('local companion browser, lifecycle and legacy Linux regressions', { skip: process.platform !== 'linux' || !cli, timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-desktop-test-'));
  const procs = [];
  const events = [];
  const server = http.createServer((req, res) => {
    events.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Local fixture</title><h1>Local fixture</h1><label>Message<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Send</button><output>Waiting</output><input type=file id=upload>');
  });
  const sockets = [];
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const connection = { socket, pathname: req.url, messages: [], pending: new Map() };
    sockets.push(connection);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); connection.messages.push(message);
      if (message.type === 'hello') { connection.hello = message; socket.send(JSON.stringify({ type: 'welcome', mode: message.mode })); }
      if (connection.pending.has(message.id)) { const pending = connection.pending.get(message.id); connection.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
    });
  });
  let external;
  t.after(async () => {
    await external?.close();
    for (const proc of [...procs].reverse()) await stop(proc);
    for (const { socket } of sockets) socket.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let display = '';
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(xvfb); xvfb.stdout.on('data', data => { display += data; });
  await until(() => display.trim()); display = `:${display.trim()}`;
  let id = 0;
  function rpc(connection, method, params = {}, botId = 'local-bot') {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 45000);
      connection.pending.set(requestId, { resolve, reject, timer });
      connection.socket.send(JSON.stringify({ id: requestId, method, params: { botId, ...params } }));
    });
  }
  async function browser(connection, tool, args = {}, botId) {
    const result = await rpc(connection, 'browser', { tool, args }, botId);
    assert.equal(result.isError, false, text(result)); return result;
  }
  async function launch(args, suffix = String(procs.length), env = {}) {
    const before = sockets.length;
    let logs = '';
    const tokenFile = path.join(root, `token-${suffix}`);
    fs.writeFileSync(tokenFile, 'isolated-test-token', { mode: 0o600 });
    const child = spawn(process.execPath, [script, '--server', url, '--token-file', tokenFile, '--no-sandbox', '--data-dir', path.join(root, suffix), ...args], { env: { ...process.env, DISPLAY: display, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(child); child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    const connection = await until(() => sockets.slice(before).find(item => item.hello), 15000, () => logs);
    return { connection, child, logs: () => logs };
  }

  await t.test('scoped hello advertises browser support; real managed Chrome is headed/persistent; all supported tools exist', async () => {
    const { connection, child } = await launch(['--desktop', '--local-device'], 'managed', {
      // These must not override explicit managed-browser policy.
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://remote.invalid:9222', PLAYWRIGHT_MCP_HEADLESS: 'true', PLAYWRIGHT_MCP_PORT: '9999',
    });
    assert.equal(connection.pathname, '/api/companion/local');
    assert.equal(connection.hello.mode, 'desktop');
    assert.equal(connection.hello.desktop, true);
    assert.equal(connection.hello.headless, false);
    assert.deepEqual(connection.hello.capabilities, { shell: true, browser: true });
    assert.deepEqual(await rpc(connection, 'captcha'), { captcha: null });
    const nav = await browser(connection, 'browser_navigate', { url });
    assert.match(text(nav), /Local fixture/);
    assert.match(text(nav), /textbox.*Message|textbox/);
    const snapshot = text(await browser(connection, 'browser_snapshot'));
    const target = snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    assert.ok(target, snapshot);
    await browser(connection, 'browser_type', { element: 'Message', target, text: 'structured local typing' });
    const clicked = await browser(connection, 'browser_click', { element: 'Send', target: 'button' });
    assert.match(text(clicked), /structured local typing/);
    const screenshot = await browser(connection, 'browser_take_screenshot');
    assert.ok(screenshot.content.some(item => item.type === 'image' && item.data.length > 100));
    const upload = path.join(root, 'upload.txt'); fs.writeFileSync(upload, 'local upload fixture');
    await browser(connection, 'browser_click', { element: 'Upload', target: '#upload' });
    await browser(connection, 'browser_file_upload', { paths: [upload] });
    assert.match(text(await browser(connection, 'browser_evaluate', { function: "() => document.querySelector('#upload').files[0].name" })), /upload.txt/);
    await browser(connection, 'browser_evaluate', { function: "() => { localStorage.setItem('swarm-test', 'persistent'); return navigator.webdriver; }" });
    const commands = descendantPids(child.pid).map(pid => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return ''; } });
    const chrome = commands.find(command => command.includes('--user-data-dir=') && command.includes('--remote-debugging-pipe'));
    assert.ok(chrome, commands.join('\n'));
    assert.ok(!chrome.includes('--headless'));
    assert.ok(!chrome.includes('--remote-debugging-port'));
    await rpc(connection, 'close');
    assert.ok(fs.existsSync(path.join(root, 'managed/desktop-browser-profiles/local-bot/Default/Preferences')));
    await browser(connection, 'browser_navigate', { url });
    assert.match(text(await browser(connection, 'browser_evaluate', { function: "() => localStorage.getItem('swarm-test')" })), /persistent/);
    await stop(child);
  });

  await t.test('desktop remains usable and reports false capability when a bundled MCP override is missing', async () => {
    const { connection, child } = await launch(['--desktop', '--local-device', '--playwright-mcp', path.join(root, 'missing.js')], 'missing');
    assert.deepEqual(connection.hello.capabilities, { shell: true, browser: false });
    const result = await rpc(connection, 'shell', { command: 'printf desktop-shell' });
    assert.equal(result.exit_code, 0); assert.match(result.output, /desktop-shell/);
    await assert.rejects(rpc(connection, 'browser', { tool: 'browser_snapshot' }), /bundled @playwright\/mcp/);
    await stop(child);
  });

  await t.test('explicit external CDP attach survives close/reset and companion shutdown', async () => {
    external = await chromium.launchPersistentContext(path.join(root, 'external-browser'), { executablePath: '/usr/bin/google-chrome', headless: false, args: ['--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], env: { ...process.env, DISPLAY: display } });
    const page = external.pages()[0]; await page.goto(url);
    const port = fs.readFileSync(path.join(root, 'external-browser/DevToolsActivePort'), 'utf8').split('\n')[0];
    const { connection, child } = await launch(['--desktop', '--local-device', '--browser-cdp', `http://127.0.0.1:${port}`], 'attached');
    await browser(connection, 'browser_snapshot');
    // The relay's HTTP handshake timeout must not become an idle WebSocket timeout.
    await sleep(5500);
    await browser(connection, 'browser_snapshot');
    await rpc(connection, 'close');
    assert.equal(await page.title(), 'Local fixture');
    await browser(connection, 'browser_snapshot');
    await stop(child);
    assert.equal(await page.title(), 'Local fixture');
    await external.close(); external = null;
  });

  await t.test('disconnect stops in-flight shell/browser and discards already queued browser work', async () => {
    const { connection, child } = await launch(['--desktop', '--local-device'], 'disconnect');
    await browser(connection, 'browser_navigate', { url });
    const shellMarker = path.join(root, 'shell-after-revoke');
    connection.socket.send(JSON.stringify({ id: ++id, method: 'shell', params: { botId: 'local-bot', command: `sleep 2; touch '${shellMarker}'` } }));
    connection.socket.send(JSON.stringify({ id: ++id, method: 'browser', params: { botId: 'local-bot', tool: 'browser_wait_for', args: { text: 'never-present' } } }));
    connection.socket.send(JSON.stringify({ id: ++id, method: 'browser', params: { botId: 'local-bot', tool: 'browser_evaluate', args: { function: "() => document.title = 'queued-should-not-run'" } } }));
    await sleep(100);
    const descendants = descendantPids(child.pid);
    connection.socket.close(4403, 'local-control-revoked');
    await until(() => !alive(child.pid));
    await until(() => descendants.every(pid => !alive(pid)));
    await sleep(2100);
    assert.equal(fs.existsSync(shellMarker), false);
    assert.equal(sockets.filter(item => item.pathname === '/api/companion/local' && item.hello).at(-1), connection);
  });

  await t.test('temporary disconnect cancels old work before reconnect and never forwards stale replies', async () => {
    const { connection, child } = await launch(['--desktop', '--local-device'], 'reconnect');
    await browser(connection, 'browser_navigate', { url });
    const obsoleteId = ++id;
    const marker = path.join(root, 'reconnect-shell-marker');
    connection.socket.send(JSON.stringify({ id: obsoleteId, method: 'shell', params: { botId: 'local-bot', command: `sleep 2; touch '${marker}'` } }));
    await sleep(100);
    const before = sockets.length;
    connection.socket.close(1012, 'network-test');
    const fresh = await until(() => sockets.slice(before).find(item => item.hello));
    assert.equal(fresh.pathname, '/api/companion/local');
    assert.equal((await rpc(fresh, 'shell', { command: 'printf fresh-session' })).output, 'fresh-session');
    await sleep(2100);
    assert.equal(fs.existsSync(marker), false);
    assert.ok(!fresh.messages.some(message => message.id === obsoleteId));
    await stop(child);
  });

  await t.test('close/reset cancels queued work for that Bot before starting a fresh browser', async () => {
    const { connection, child } = await launch(['--desktop', '--local-device'], 'reset-queue');
    await browser(connection, 'browser_navigate', { url });
    connection.socket.send(JSON.stringify({ id: ++id, method: 'browser', params: { botId: 'local-bot', tool: 'browser_wait_for', args: { text: 'never-present' } } }));
    connection.socket.send(JSON.stringify({ id: ++id, method: 'browser', params: { botId: 'local-bot', tool: 'browser_evaluate', args: { function: `() => fetch('${url}/queued-executed')` } } }));
    await sleep(100);
    await rpc(connection, 'close');
    await browser(connection, 'browser_navigate', { url });
    assert.ok(!events.includes('/queued-executed'));
    await stop(child);
  });

  await t.test('parent death stops local shell commands and managed browser children', async () => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); procs.push(parent);
    const { connection, child } = await launch(['--desktop', '--local-device', '--parent-pid', String(parent.pid)], 'parent');
    await browser(connection, 'browser_navigate', { url });
    connection.socket.send(JSON.stringify({ id: ++id, method: 'shell', params: { botId: 'local-bot', command: 'sleep 30' } }));
    await sleep(100);
    const descendants = descendantPids(child.pid);
    await stop(parent);
    await until(() => !alive(child.pid));
    await until(() => descendants.every(pid => !alive(pid)));
  });

  await t.test('legacy desktop keeps its original path', async () => {
    const { connection, child } = await launch(['--desktop'], 'legacy-desktop');
    assert.equal(connection.pathname, '/api/companion');
    assert.equal(connection.hello.mode, 'desktop');
    await stop(child);
  });

  await t.test('standalone downloaded browser-only companion still navigates and captures over a private pipe', async () => {
    const downloaded = path.join(root, 'downloaded-companion.mjs'); fs.copyFileSync(script, downloaded);
    const before = sockets.length;
    const child = spawn(process.execPath, [downloaded, '--server', url, '--token', 'test-only', '--no-sandbox', '--allow-private-network', '--data-dir', path.join(root, 'legacy-browser')], { stdio: 'ignore' }); procs.push(child);
    const connection = await until(() => sockets.slice(before).find(item => item.hello));
    assert.equal(connection.pathname, '/api/companion');
    assert.equal(connection.hello.mode, 'browser');
    assert.deepEqual(connection.hello.capabilities, { shell: false, browser: false });
    const result = await rpc(connection, 'open', { url }); assert.equal(result.url, url + '/');
    const shot = await rpc(connection, 'screenshot'); assert.ok(shot.data.length > 100); assert.equal(shot.width, 1280);
    await stop(child);
  });

  await t.test('Linux cloud multi screen retains existing browser RPC and separate route', async () => {
    const { connection, child } = await launch(['--multi', '--agent-home', path.join(root, 'multi-home')], 'multi');
    assert.equal(connection.pathname, '/api/companion'); assert.equal(connection.hello.mode, 'multi');
    assert.deepEqual(connection.hello.capabilities, { shell: true, browser: true });
    assert.match(text(await browser(connection, 'browser_navigate', { url }, 'cloud-bot')), /Local fixture/);
    const shot = await rpc(connection, 'screenshot', {}, 'cloud-bot'); assert.ok(shot.data.length > 100);
    await rpc(connection, 'close', {}, 'cloud-bot');
    await stop(child);
  });
});
