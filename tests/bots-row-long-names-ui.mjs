// QA N02: real local SQLite, dev login, and mocked model and toolkit backends.
// Run: node tests/bots-row-long-names-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), 'swarm-bots-row-'));
const evidence = path.join(root, '.context/bots-row-long-names');
await mkdir(evidence, { recursive: true });
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port(), mockPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
// Deliberately omit inherited app credentials and local .env files.
const env = {
  PATH: process.env.PATH, TMPDIR: temp, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'cli'), SESSION_SECRET: 'bots-row-test-only',
  DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin,
  COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0',
  INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1', COMPOSIO_API_KEY: 'bots-row-test-project',
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, LLM_PROVIDER: 'direct',
};
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    if (children.some(child => child.exitCode !== null)) throw new Error(logs.join(''));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting local server: ${logs.join('')}`);
}

try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  await ready(`http://127.0.0.1:${mockPort}/v1/models`);
  start(['--import', 'tsx', '--input-type=module', '-e', `
    const localFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return localFetch(input, init);
      if (url.hostname === 'backend.composio.dev') return Response.json({ items: [] });
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
      if (url.hostname === 'telemetry.composio.dev') return Response.json({});
      throw new Error('Unexpected external request: ' + url.hostname);
    };
    const { composio } = await import('./server/src/composio.ts');
    composio().connectedAccounts.list = async () => ({ items: [] });
    await import('./server/src/index.ts');
  `]);
  await ready(`${apiBase}/api/health`);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await ready(origin);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  const failures = [];
  for (const width of [1280, 1024, 768]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const api = async (pathname, method = 'GET', data) => {
      const response = await context.request.fetch(`${origin}/api${pathname}`, { method, data });
      assert.ok(response.ok(), `${method} ${pathname}: ${response.status()}`);
      return response.json();
    };
    await api('/auth/dev', 'POST', { email: `bots-row-${width}@example.test`, name: 'QA account' });
    const primary = (await api('/bots')).bots.find(bot => bot.isPrimary);
    await api(`/bots/${primary.id}`, 'PATCH', { name: 'Primary Bot', label: '' });
    const fixtures = [
      { name: 'B'.repeat(60), label: 'L'.repeat(40), description: 'Long name and label fixture' },
      { name: 'C'.repeat(60), label: '', description: 'Long name fixture' },
      { name: 'Notes Bot', label: 'Research', description: 'Ordinary row fixture' },
    ];
    for (const fixture of fixtures) await api('/bots', 'POST', fixture);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      errors.push('Unexpected external browser request');
      return route.abort();
    });
    try {
      await page.goto(origin);
      await page.getByRole('complementary', { name: 'Your Bots' }).locator('.sidebar__section-label').click();
      await page.getByRole('heading', { name: 'Your Bots', exact: true }).waitFor();
      await page.locator('.bots-view__item').filter({ hasText: fixtures[0].name }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const fixture of fixtures) {
        const row = page.locator('.bots-view__item').filter({ hasText: fixture.name });
        const expected = fixture.label ? `${fixture.name} · ${fixture.label}` : fixture.name;
        assert.equal(await row.locator('strong').textContent(), expected, 'Full name and label are rendered');
        const measured = await row.evaluate(element => {
          const box = node => {
            const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
          };
          const name = element.querySelector('strong');
          const range = document.createRange();
          range.selectNodeContents(name);
          return {
            row: box(element), avatar: box(element.querySelector(':scope > .bot-avatar')),
            text: box(name.parentElement), chevron: box(element.querySelector(':scope > svg')),
            lines: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
            rowOverflows: element.scrollWidth > element.clientWidth,
          };
        });
        assert.equal(measured.avatar.width, 36, 'Avatar retains its intended 36px width');
        assert.equal(measured.avatar.height, 36, 'Avatar retains its intended 36px height');
        assert.equal(measured.text.left - measured.avatar.right, 16, 'Text begins one row gap after the avatar');
        assert.equal(measured.chevron.width, 18, 'Chevron retains its intended width');
        assert.ok(measured.text.right <= measured.chevron.left - 15.5, 'Text leaves room for the chevron');
        assert.ok(measured.row.left >= 0 && measured.row.right <= width, 'Row stays in the viewport');
        assert.equal(measured.rowOverflows, false, 'Row has no horizontal overflow');
        for (const line of measured.lines) for (const bounds of [measured.text, measured.row]) {
          assert.ok(line.left >= bounds.left - 0.5 && line.right <= bounds.right + 0.5 && line.top >= bounds.top - 0.5 && line.bottom <= bounds.bottom + 0.5, 'Every name line stays inside the text column and row');
        }
        // The 752px directory can fit a 60-character name without a label.
        // Require wrapping when the long label is present; containment above covers both cases.
        if (fixture.label && fixture.name.length === 60) assert.ok(measured.lines.length > 1, 'Long name plus label wraps');
        if (fixture.name.length < 60) assert.equal(measured.lines.length, 1, 'Ordinary names stay on one line');
      }
      assert.ok(await page.locator('.bots-view').evaluate(element => element.scrollWidth <= element.clientWidth), 'Bot list has no horizontal overflow');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewport has no horizontal overflow');
      assert.deepEqual(errors, [], 'No browser errors or external requests');
      await page.screenshot({ path: path.join(evidence, `${width}.png`) });
      await page.locator('.bots-view__item').filter({ hasText: fixtures[0].name }).click();
      await page.locator('.chat').waitFor();
      assert.equal(await page.locator('.chat__pill-name').textContent(), fixtures[0].name, 'Wrapped row still opens the correct Bot');
      console.log(`PASS N02 ${width}px: long names and labels contained, 36px avatars, ordinary row spacing, row navigation`);
    } catch (error) {
      failures.push(`${width}px: ${error.message}`);
      await page.screenshot({ path: path.join(evidence, `${width}-failure.png`) });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'Your Bots rows contain long names at every required viewport');
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  })));
  await rm(temp, { recursive: true, force: true });
}
