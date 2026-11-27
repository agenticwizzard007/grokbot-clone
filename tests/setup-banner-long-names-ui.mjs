// QA N07: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-banner-long-names-'));
const evidence = path.join(root, '.context/setup-banner-long-names');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Do not inherit provider credentials or database settings from the caller.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'setup-banner-long-names-fixture',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${modelBase}/v1`,
  OPENROUTER_BASE_URL: `${modelBase}/v1`, COMPOSIO_API_KEY: 'fixture-only',
};
const preload = path.join(temp, 'mock-backends.mjs');
await fs.writeFile(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected external request: ' + url.origin + url.pathname);
};
`);
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(child.exitCode, null, logs.join(''));
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${logs.join('')}`);
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const failures = [];
  const viewports = [1280, 1024, 768, 390].map(width => ({ width, height: 900 }));
  viewports.push({ width: 390, height: 460 });
  for (const viewport of viewports) for (const name of ['W'.repeat(60), 'Notes Bot']) {
    const label = `${viewport.width}x${viewport.height}-${name.length === 60 ? 'long' : 'ordinary'}`;
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const api = async (pathname, method = 'GET', data) => {
      const response = await context.request.fetch(`${base}/api${pathname}`, { method, data });
      assert.ok(response.ok(), `${method} ${pathname}: ${response.status()}`);
      return response.json();
    };
    await api('/auth/dev', 'POST', { email: `banner-${label}@example.test`, name: 'QA account' });
    const { bot } = await api('/bots', 'POST', { name });
    assert.equal(bot.onboarding.status, 'interviewing', 'Fixture is legitimately still in setup');
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      errors.push('External browser request attempted');
      return route.abort();
    });
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
    }, bot.id);
    try {
      await page.goto(`${base}/#bot/${encodeURIComponent(bot.id)}`);
      const banner = page.getByRole('region', { name: `${name} setup`, exact: true });
      await banner.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await banner.locator('.setup-banner__text').textContent(), 'Finish setup');
      const geometry = await banner.evaluate(element => {
        const rect = node => {
          const { left, right, top, bottom } = node.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const text = element.querySelector('.setup-banner__text');
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          banner: rect(element), text: rect(text),
          lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
          buttons: [...element.querySelectorAll('button')].map(button => ({
            ...rect(button), label: button.textContent,
            hit: button.contains(document.elementFromPoint(
              (rect(button).left + rect(button).right) / 2,
              (rect(button).top + rect(button).bottom) / 2)),
          })),
          overflow: element.scrollWidth > element.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      await page.screenshot({ path: path.join(evidence, `${label}.png`) });
      await fs.writeFile(path.join(evidence, `${label}.json`), JSON.stringify(geometry, null, 2) + '\n');
      const contains = (outer, inner) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
        && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      assert.ok(contains({ left: 0, top: 0, right: viewport.width, bottom: viewport.height }, geometry.banner), 'Banner fits inside the viewport');
      assert.equal(geometry.overflow, false, 'Banner has no horizontal overflow');
      assert.equal(geometry.pageOverflow, false, 'Page has no horizontal overflow');
      for (const line of geometry.lines) {
        assert.ok(contains(geometry.text, line), 'Every rendered text line stays inside the text column');
        for (const button of geometry.buttons) assert.equal(overlaps(line, button), false, `Text does not paint over ${button.label}`);
      }
      for (const button of geometry.buttons) {
        assert.ok(contains(geometry.banner, button), `${button.label} stays inside the banner`);
        assert.ok(button.hit, `${button.label} receives pointer input`);
      }
      assert.equal(overlaps(...geometry.buttons), false, 'Action buttons do not overlap');
      await banner.getByRole('button', { name: 'Review setup', exact: true }).click();
      const details = page.getByRole('complementary', { name: 'Conversation details' });
      await details.getByRole('navigation', { name: 'Conversation details sections' })
        .getByRole('button', { name: 'Setup', exact: true }).waitFor();
      await details.getByRole('region', { name: 'Setup status', exact: true }).waitFor();
      await details.getByRole('button', { name: 'Close details', exact: true }).click();
      assert.equal((await api(`/bots/${bot.id}/setup`)).onboarding.status, 'interviewing', 'Review preserves pending setup');
      await banner.getByRole('button', { name: 'Skip setup', exact: true }).click();
      await banner.waitFor({ state: 'detached' });
      assert.equal((await api(`/bots/${bot.id}/setup`)).onboarding.status, 'active', 'Skip activates only the local fixture');
      assert.deepEqual(errors, [], 'No browser errors or external requests');
      console.log(`PASS N07 ${label}: contained text, visible actions, review navigation and skip activation`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      await page.screenshot({ path: path.join(evidence, `${label}-failure.png`) });
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'Setup banner contains names and keeps both actions usable');
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join(''));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}
