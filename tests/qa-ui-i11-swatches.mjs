// Run: node tests/qa-ui-i11-swatches.mjs
// The real app runs on local Vite with fake API data and no backend access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const colors = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];
const bot = {
  id: 'swatch-fixture-bot', name: 'Test Bot', label: '', description: '', instructions: '',
  avatarShape: 'square', avatarColor: 'blue', mode: 'personal', isPrimary: true, pinned: false, kind: 'agent',
  effort: 'medium', fast: false, model: null, voice: '', voiceSpeed: 1, voiceLanguage: 'auto',
  generation: 1, unread: 0, lastPreview: null, lastActivityAt: 1, createdAt: 1, onboarding: { status: 'active' },
};
const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser;
vite.stdout.on('data', chunk => { log += chunk; });
vite.stderr.on('data', chunk => { log += chunk; });
const failures = [];

try {
  await mkdir('.context/qa-ui-i11', { recursive: true });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (vite.exitCode !== null) throw new Error(log);
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Local Vite did not become ready: ${log}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      const errors = [], unexpected = [];
      await context.addInitScript(botId => {
        localStorage.setItem('swarm.selectedBot', botId);
        localStorage.setItem('swarm.theme', 'light');
        window.EventSource = class {
          static CLOSED = 2;
          readyState = 1;
          constructor() { queueMicrotask(() => this.onopen?.({})); }
          close() { this.readyState = 2; }
        };
      }, bot.id);
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = json => route.fulfill({ json });
        if (url.pathname === `/api/bots/${bot.id}/suggested-apps` && request.method() === 'POST') return send({ suggestions: [] });
        if (request.method() === 'GET') {
          if (url.pathname === '/api/auth/me') return send({ user: { id: 'swatch-fixture-account', name: 'Test account', email: 'swatches@example.test', timezone: 'UTC' } });
          if (url.pathname === '/api/bots') return send({ bots: [bot], live: [] });
          if (url.pathname === `/api/bots/${bot.id}/rows`) return send({ generation: 1, rows: [] });
          if (url.pathname === `/api/bots/${bot.id}/routines`) return send({ routines: [] });
          if (url.pathname === `/api/bots/${bot.id}/tasks`) return send({ tasks: [] });
          if (url.pathname === `/api/bots/${bot.id}/settings`) return send({ skills: [], memories: [], routines: [], approvals: [], connections: [] });
          if (url.pathname === `/api/bots/${bot.id}/coworker-setups`) return send({ setups: [] });
          if (url.pathname === '/api/tasks') return send({ tasks: [] });
          if (url.pathname === '/api/needs-you') return send({ items: [] });
          if (url.pathname === '/api/team/exchanges') return send({ exchanges: [] });
          if (url.pathname === '/api/cli') return send({ runtime: 'server', connected: false, selected: null, providers: {} });
          if (url.pathname === '/api/providers/openrouter') return send({ connected: false, active: false });
          if (url.pathname === '/api/computer') return send({ computer: { status: 'suspended', provider: 'cloudvm', screens: [], orgoId: null, error: null, desktop: false } });
          if (url.pathname === '/api/models') return send({ provider: 'direct', billing: 'api', models: [], favourites: [], canFast: false });
          if (url.pathname === '/api/apps') return send({ apps: [], connected: [], connectedApps: [], categories: [] });
          if (url.pathname === '/api/apps/connections') return send({ connections: [] });
          if (url.pathname === '/api/settings/keys') return send({ isolated: true });
        }
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 400, json: { error: 'Unexpected fixture request' } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.locator('.app').waitFor();
      if (width === 390) await page.locator('.pinned__tile').click();
      await page.locator('.chat__pill').click();
      await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
      const settings = page.locator('.bot-settings-page');
      await settings.getByRole('button', { name: 'General', exact: true }).click();
      await settings.getByRole('button', { name: 'Change look', exact: true }).click();
      const picker = settings.locator('.cfg-picker');
      await picker.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const swatches = picker.getByRole('radiogroup', { name: 'Character color', exact: true }).getByRole('radio');
      assert.deepEqual(await swatches.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), colors, 'Keep all eleven standard colors');
      await page.screenshot({ path: `.context/qa-ui-i11/swatches-${width}.png` });

      const card = await picker.boundingBox();
      assert.ok(card, 'The picker card is visible');
      const viewport = page.viewportSize();
      for (const color of colors) {
        const swatch = picker.getByRole('radio', { name: color, exact: true });
        assert.ok(await swatch.isVisible(), `${width}px: ${color} is visible`);
        const box = await swatch.boundingBox();
        assert.ok(box, `${width}px: ${color} has a bounding box`);
        const fits = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
        assert.ok(fits(card, box), `${width}px: ${color} must fit inside the picker card: ${JSON.stringify({ card, box })}`);
        assert.ok(fits({ x: 0, y: 0, ...viewport }, box), `${width}px: ${color} must fit inside the viewport: ${JSON.stringify(box)}`);
        assert.equal(box.width, 32, `${width}px: ${color} retains its button width`);
        assert.equal(box.height, 32, `${width}px: ${color} retains its button height`);
      }
      for (const color of colors) {
        const swatch = picker.getByRole('radio', { name: color, exact: true });
        await swatch.click();
        assert.equal(await swatch.getAttribute('aria-checked'), 'true', `${color} can be selected`);
        assert.equal(await swatches.filter({ has: page.locator('.is-selected') }).count(), 1, 'Only one color is selected');
      }
      assert.deepEqual(errors, [], 'No browser errors');
      assert.deepEqual(unexpected, [], 'All API requests use fixtures and no Bot changes are saved');
      console.log(`PASS I11: all eleven swatches fit and can be selected at ${width}px`);
    } catch (error) {
      failures.push(error);
      console.error(error.message);
    } finally {
      await context.close();
    }
  }
  assert.equal(failures.length, 0, `${failures.length} swatch viewport checks failed`);
} finally {
  await browser?.close();
  vite.kill();
}
