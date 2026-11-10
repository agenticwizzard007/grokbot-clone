// Built-UI regression check: waking a VM must finish even if its status changes
// before the HTTP response arrives. No VM, provider, or live account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { ByteQueue, browserHandshake, serverInit } from '../server/dist/computers/rfb.js';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
});
let logs = '', browser, desktop;
vite.stdout.on('data', d => { logs += d; });
vite.stderr.on('data', d => { logs += d; });
const origin = `http://127.0.0.1:${port}`;
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out: ${logs}`);
}
const bot = { id: 'wake-bot', name: 'Quinn', label: 'Your primary bot', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', isPrimary: true, pinned: true, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: Date.now(), createdAt: Date.now() };
try {
  await until(() => fetch(origin).then(r => r.ok, () => false));
  desktop = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => desktop.once('listening', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const scenario of [
    { provider: 'cloudvm', status: 'suspended' },
    { provider: 'orgo', status: 'stopped', intermediate: true },
    { provider: 'cloudvm', status: 'absent', fail: true },
    { provider: 'local', status: 'absent' },
    { provider: 'cloudvm', status: 'running', visibility: true },
    { provider: 'cloudvm', status: 'running', visibility: true, control: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    await page.addInitScript(socketURL => {
      window.testVisibility = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testVisibility });
      // Keep native WebSocket properties (noVNC validates them), but use the local test desktop.
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(Target, args) {
          if (String(args[0]).includes('/screen?')) args[0] = socketURL;
          return Reflect.construct(Target, args);
        },
      });
      window.EventSource = class {
        static CLOSED = 2;
        readyState = 1;
        constructor() { window.testEvents = this; queueMicrotask(() => this.onopen?.()); }
        close() { this.readyState = 2; }
      };
    }, `ws://127.0.0.1:${desktop.address().port}`);
    // Complete the real RFB handshake without a VM or a frame encoder.
    let opened = 0, closed = 0;
    const connect = socket => {
      opened++;
      const queue = new ByteQueue();
      socket.on('message', data => queue.push(Buffer.from(data)));
      socket.on('close', () => { closed++; queue.close(new Error('closed')); });
      browserHandshake(queue, data => socket.send(data), serverInit(1920, 1080, 'Test desktop')).catch(() => {});
    };
    desktop.on('connection', connect);
    let requests = 0, screenshots = 0;
    const pending = [];
    const computer = { provider: scenario.provider, status: scenario.status, screens: [], error: null };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'wake-user', name: 'Alex', email: 'wake@example.com' } };
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/computer') body = { computer };
      else if (path.endsWith('/screenshot')) { screenshots++; return route.fulfill({ status: 204 }); }
      else if (path === '/api/computer/ensure') {
        requests++;
        return new Promise(resolve => pending.push(async (body, status = 200) => {
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
          resolve();
        }));
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    if (scenario.visibility) {
      await until(() => screenshots === 1);
      await page.waitForTimeout(4300);
      assert.equal(screenshots, 1, 'the thumbnail must not repeatedly capture an unattended screen');
    }
    await page.locator('.panel-row--computer').click();
    const viewer = page.getByRole('dialog', { name: "Quinn's computer" });
    await viewer.waitFor();
    if (scenario.visibility) {
      await until(() => opened === 1);
      await viewer.locator('.viewer__overlay').waitFor({ state: 'hidden' });
      let connectionsBeforeHide = 1;
      if (scenario.control) {
        await viewer.getByRole('button', { name: 'Take control' }).click();
        connectionsBeforeHide++;
        await until(() => opened === connectionsBeforeHide && closed === 1);
        await viewer.locator('.viewer__overlay').waitFor({ state: 'hidden' });
      }
      const visibility = state => page.evaluate(state => {
        window.testVisibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
      await visibility('hidden');
      await until(() => closed === connectionsBeforeHide);
      assert.equal(screenshots, 1, 'a hidden viewer must not fall back to thumbnail capture');
      computer.status = 'suspended';
      await page.evaluate(state => window.testEvents.onmessage({ data: JSON.stringify({ type: 'computer', state }) }), computer);
      assert.equal(requests, 0, 'a background viewer must not wake an idle VM');
      await visibility('visible');
      await until(() => pending.length === 1);
      computer.status = 'running';
      await pending.shift()({ computer });
      await until(() => opened === connectionsBeforeHide + 1);
      await viewer.locator('.viewer__overlay').waitFor({ state: 'hidden' });
      await viewer.getByRole('button', { name: 'Close computer' }).click();
      await until(() => closed === connectionsBeforeHide + 1 && screenshots === 2);
      assert.equal(requests, 1, 'returning to a sleeping VM wakes it once');
    } else if (scenario.provider === 'local') {
      await viewer.getByRole('button', { name: 'Connect your PC' }).waitFor();
      assert.equal(requests, 0, 'local companions cannot be woken as cloud VMs');
    } else {
      await until(() => pending.length === 1);
      await viewer.getByText('Waking up…', { exact: true }).waitFor();
      assert.equal(await viewer.getByRole('button', { name: 'Wake computer' }).count(), 0, 'no duplicate wake while pending');
      if (scenario.intermediate) {
        await page.evaluate(state => window.testEvents.onmessage({ data: JSON.stringify({ type: 'computer', state }) }), { ...computer, status: 'resuming' });
        await page.locator('.viewer__status').filter({ hasText: 'Waking up…' }).waitFor();
      }
      if (scenario.fail) {
        await pending.shift()({ error: 'Temporary wake failure' }, 503);
        await viewer.getByText('Temporary wake failure', { exact: true }).waitFor();
        assert.equal(requests, 1, 'failure does not start an automatic retry loop');
        await viewer.getByRole('button', { name: 'Wake computer' }).click();
        await until(() => pending.length === 1);
      }
      await pending.shift()({ computer: { ...computer, status: 'running' } });
      await page.locator('.viewer__status').filter({ hasText: 'Awake' }).waitFor();
      await viewer.getByRole('button', { name: 'Take control' }).waitFor();
      assert.equal(requests, scenario.fail ? 2 : 1);
      assert.equal(await viewer.locator('.viewer__err').count(), 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
    desktop.off('connection', connect);
    console.log(`PASS viewer wake: ${scenario.provider}/${scenario.status}${scenario.intermediate ? ', intermediate status' : ''}${scenario.fail ? ', retry' : ''}${scenario.visibility ? `, ${scenario.control ? 'control' : 'watch'} hidden-tab pause/resume and no thumbnail polling` : ''}`);
  }
} finally {
  await browser?.close();
  if (desktop) { for (const socket of desktop.clients) socket.terminate(); desktop.close(); }
  vite.kill();
}
