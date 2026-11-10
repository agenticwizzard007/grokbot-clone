// Real cloud companion: Playwright, 1080p binary frames, coordinate scaling and encoder cleanup.
// No provider keys or deployed VMs. Requires npm run build, Chrome, Xvfb, xdotool, ImageMagick.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { jpegSize } from '../server/dist/computers/rfb.js';
import { decodeCompanionFrame } from '../server/dist/computers/frames.js';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-vm-performance-'));
const log = [], frames = [], pending = new Map();
let socket, companion, nextId = 0, binary = true;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(30); } throw new Error('Timed out: ' + log.slice(-6).join('')); }
const site = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>VM performance</title><style>body{margin:0}button,input{width:200px;height:50px}#viewer{position:absolute;left:1500px;top:700px}#agent{position:absolute;left:1500px;top:850px}</style>
    <label>First<input name="first"></label><label>Last<input name="last"></label>
    <button id="submit" onclick="document.querySelector('output').textContent=document.querySelector('[name=first]').value+' '+document.querySelector('[name=last]').value">Submit</button>
    <output>Ready</output><button id="viewer" onclick="this.textContent='Viewer correct'">Viewer test</button>
    <button id="agent" onclick="this.textContent='Agent correct'">Agent test</button>`);
});
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('connection', ws => {
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const frame = decodeCompanionFrame(raw);
      assert.ok(frame, 'valid binary JPEG envelope');
      frames.push({ at: performance.now(), binary: true, ...jpegSize(frame.jpeg) });
      return;
    }
    const msg = JSON.parse(raw);
    if (msg.type === 'hello') { socket = ws; ws.send(JSON.stringify({ type: 'welcome', mode: 'multi', binaryFrames: binary })); }
    else if (msg.event === 'frame') frames.push({ at: performance.now(), binary: false, ...jpegSize(Buffer.from(msg.data, 'base64')) });
    else if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
  });
});
function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params: { botId: 'performance-bot', ...params } }));
  });
}
function input(type, x, y) { socket.send(JSON.stringify({ method: 'input', params: { botId: 'performance-bot', kind: 'mouse', type, x, y, width: 1920, height: 1080, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 } })); }
const text = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
async function browser(tool, args = {}) { const r = await rpc('browser', { tool, args }); assert.equal(r.isError, false, text(r)); return text(r); }
async function point(selector) {
  const result = await browser('browser_evaluate', { function: `() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: window.screenX + r.x + r.width / 2, y: window.screenY + window.outerHeight - window.innerHeight + r.y + r.height / 2 }; }` });
  const x = Number(result.match(/"x":\s*([\d.]+)/)?.[1]);
  const y = Number(result.match(/"y":\s*([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(x) && Number.isFinite(y), result);
  return { x: Math.round(x), y: Math.round(y) };
}
function encoders() {
  try {
    return fs.readFileSync(`/proc/${companion.pid}/task/${companion.pid}/children`, 'utf8').trim().split(/\s+/).filter(pid => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('image2pipe'); } catch { return false; }
    });
  } catch { return []; }
}
async function launch(encoder, useBinary) {
  binary = useBinary; socket = null; frames.length = 0;
  companion = spawn(process.execPath, ['companion/swarm-companion.mjs', '--multi', '--no-sandbox', '--server', `http://127.0.0.1:${server.address().port}`, '--token', 'isolated-test', '--agent-home', path.join(root, 'home'), '--data-dir', path.join(root, 'data')], {
    env: { ...process.env, SWARM_FFMPEG: encoder, SWARM_VIEWER_FPS: '30', SWARM_SCREEN_WIDTH: '1920', SWARM_SCREEN_HEIGHT: '1080' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  companion.stdout.on('data', d => log.push(String(d))); companion.stderr.on('data', d => log.push(String(d)));
  await until(() => socket);
}
async function stop() {
  if (companion && companion.exitCode === null) { companion.kill('SIGTERM'); await new Promise(r => companion.once('exit', r)); }
}
try {
  await Promise.all([new Promise(r => site.listen(0, '127.0.0.1', r)), new Promise(r => server.once('listening', r))]);
  await launch(process.env.SWARM_FFMPEG ?? require('ffmpeg-static'), true);
  const page = await browser('browser_navigate', { url: `http://127.0.0.1:${site.address().port}` });
  assert.match(page, /### Snapshot/);
  assert.match(page, /First/);
  assert.ok(!page.includes('- [Snapshot]('), 'action includes actual page instead of an unreadable file link');
  const start = performance.now();
  await browser('browser_fill_form', { fields: [
    { name: 'First', target: 'input[name=first]', type: 'textbox', value: 'Quick' },
    { name: 'Last', target: 'input[name=last]', type: 'textbox', value: 'VM' },
  ] });
  const submitted = await browser('browser_click', { target: '#submit' });
  assert.match(submitted, /Quick VM/);
  const formMs = Math.round(performance.now() - start);
  const shot = await rpc('screenshot');
  assert.equal(shot.width, 1280); assert.equal(shot.height, 720);
  await rpc('screencast.start');
  await until(() => frames.length >= 10);
  const first = frames.length;
  await sleep(2000);
  const sample = frames.slice(first);
  const fps = (sample.length - 1) / ((sample.at(-1).at - sample[0].at) / 1000);
  assert.ok(fps >= 20, `expected >=20 FPS locally, got ${fps}`);
  assert.ok(sample.every(f => f.binary && f.width === 1920 && f.height === 1080));
  assert.equal(encoders().length, 1, 'one persistent encoder per watched screen');
  const viewerPoint = await point('#viewer');
  input('mousePressed', viewerPoint.x, viewerPoint.y); input('mouseReleased', viewerPoint.x, viewerPoint.y);
  await until(async () => /Viewer correct/.test(await browser('browser_snapshot')));
  // Agent coordinates still refer to its 1280x720 screenshot while the viewer uses 1920x1080.
  const agentPoint = await point('#agent');
  await rpc('click', { x: Math.round(agentPoint.x * 1280 / 1920), y: Math.round(agentPoint.y * 720 / 1080) });
  await until(async () => /Agent correct/.test(await browser('browser_snapshot')));
  await rpc('screencast.stop');
  await until(() => encoders().length === 0);
  await sleep(150); const stoppedFrames = frames.length; await sleep(250);
  assert.equal(frames.length, stoppedFrames, 'no captures after the viewer closes');
  await rpc('screencast.start'); await until(() => encoders().length === 1);
  socket.close(); await until(() => encoders().length === 0);
  await stop();
  console.log(JSON.stringify({ playwrightFormMs: formMs, viewerFps: +fps.toFixed(2), resolution: '1920x1080', binaryFrames: true, coordinateChecks: 'passed', encoderCleanup: 'passed' }));
  // An older image without ffmpeg still works, including with an older JSON-only server.
  await launch('/missing/swarm-ffmpeg', false);
  await rpc('screenshot'); await rpc('screencast.start');
  await until(() => frames.length >= 5);
  assert.ok(frames.every(f => !f.binary));
  assert.ok(log.some(l => l.includes('screenshot fallback')));
  await rpc('close');
  await sleep(200); const closedFrames = frames.length; await sleep(300);
  assert.equal(frames.length, closedFrames);
  console.log('PASS fallback, legacy transport, screen-close cleanup');
} catch (e) { console.error(log.slice(-12).join('')); throw e; }
finally {
  await stop();
  for (const p of pending.values()) clearTimeout(p.timer);
  for (const ws of server.clients) ws.terminate();
  server.close(); site.close();
  fs.rmSync(root, { recursive: true, force: true });
}
