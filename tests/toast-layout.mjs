// Exercise the real global toast in a local Vite dev app with synthetic API data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/i02-toast/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => {
  const socket = http.createServer().listen(0, '127.0.0.1', () => {
    const port = socket.address().port;
    socket.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
  env: { ...process.env, SWARM_API: 'http://127.0.0.1:1' },
});
let logs = '';
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
const now = Date.now();
const bot = {
  id: 'toast-fixture', name: 'Test Bot', description: '', instructions: '', label: '',
  mode: 'personal', pinned: true, isPrimary: true, kind: 'agent', onboarding: { status: 'active' },
  effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: '',
  lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto',
  avatarColor: 'blue', avatarShape: 'blob',
};
const rows = [{
  botId: bot.id, generation: 1, seq: 1, updatedSeq: 1, createdAt: now, kind: 'message',
  body: { type: 'message', role: 'assistant', text: 'This is a local test conversation. The composer should remain available while a notification is visible.' },
}];
const messages = [
  { tone: 'info', message: 'Test notification saved.' },
  { tone: 'error', message: 'This is a synthetic notification with enough text to wrap across several lines on a phone. Every line should remain readable while the conversation and composer stay available.' },
];
let browser, page;
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    if (server.exitCode !== null) throw new Error(`Vite exited: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Vite started: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const viewport = { width, height: 900 };
    page = await browser.newPage({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(id => {
      localStorage.setItem('swarm.selectedBot', id);
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    }, bot.id);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'fixture-owner', name: 'Test Account', email: 'account@example.test' } };
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/needs-you') body = { items: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/computer') body = { computer: { provider: 'local', status: 'absent', screens: [] } };
      else if (path === '/api/models') body = { models: [], favourites: [], provider: 'direct', billing: 'api' };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      else if (path === '/api/apps/suggestions') body = { suggestions: [] };
      return route.fulfill({ json: body });
    });
    await page.goto(origin);
    if (width <= 760) await page.locator('.pinned__tile').click();
    const composer = page.locator('.composer__input');
    await composer.waitFor({ state: 'visible' });
    await page.getByText(rows[0].body.text, { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const notification of messages) {
      await page.evaluate(async ({ message, tone }) => {
        const { toast } = await import('/src/lib/toast.ts');
        toast(message, { tone });
      }, notification);
      const toast = page.locator('body > .toast--global');
      await toast.waitFor({ state: 'visible' });
      await toast.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      assert.equal(await toast.textContent(), notification.message);
      const metrics = await toast.evaluate(el => {
        const box = el.getBoundingClientRect(), style = getComputedStyle(el);
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()];
        const px = value => parseFloat(value) || 0;
        const contentHeight = lines.length * px(style.lineHeight) + px(style.paddingTop) + px(style.paddingBottom)
          + px(style.borderTopWidth) + px(style.borderBottomWidth);
        const radius = Math.min(px(style.borderTopLeftRadius), box.width / 2, box.height / 2);
        const insideBackground = (x, y) => {
          const centerX = Math.max(box.left + radius, Math.min(x, box.right - radius));
          const centerY = Math.max(box.top + radius, Math.min(y, box.bottom - radius));
          return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2 + 1;
        };
        return {
          box: box.toJSON(), contentHeight, lines: lines.length,
          textOnBackground: lines.every(line => [[line.left, line.top], [line.right, line.top], [line.left, line.bottom], [line.right, line.bottom]]
            .every(([x, y]) => insideBackground(x, y))),
          clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
            || lines.some(line => line.top < box.top || line.bottom > box.bottom || line.left < box.left || line.right > box.right),
          composerTop: document.querySelector('.composer').getBoundingClientRect().top,
        };
      });
      const label = `${width}x900 ${notification.tone}`;
      assert.ok(metrics.box.height < viewport.height / 4, `${label}: toast is not a screen-covering column: ${JSON.stringify(metrics)}`);
      assert.ok(Math.abs(metrics.box.height - metrics.contentHeight) <= 1, `${label}: height follows the text and padding`);
      assert.ok(metrics.box.bottom < metrics.composerTop, `${label}: toast does not overlap the composer`);
      assert.equal(metrics.clipped, false, `${label}: every line fits inside the toast`);
      if (width === 390) assert.ok(metrics.textOnBackground, `${label}: text stays inside the rounded background`);
      assert.equal(metrics.box.top, 16, `${label}: global toast keeps its top anchor`);
      assert.ok(metrics.box.left >= 0 && metrics.box.right <= width, `${label}: toast fits horizontally`);
      assert.ok(Math.abs(metrics.box.left + metrics.box.width / 2 - width / 2) <= 1, `${label}: toast stays centered`);
      if (width === 390 && notification.tone === 'error') assert.ok(metrics.lines > 1, 'phone regression exercises wrapped text');
      await composer.fill('Local draft remains editable');
      assert.equal(await composer.inputValue(), 'Local draft remains editable', `${label}: composer remains usable`);
      await page.screenshot({ path: new URL(`${width}x900-${notification.tone}.png`, evidence).pathname });
      await toast.click();
      await toast.waitFor({ state: 'hidden' });
      console.log(`PASS ${label}: ${metrics.box.height}px, ${metrics.lines} text lines, composer clear, text unclipped`);
    }
    assert.deepEqual(errors, []);
    await page.close();
    page = null;
  }
} catch (error) {
  if (page) await page.screenshot({ path: new URL('failure.png', evidence).pathname });
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
