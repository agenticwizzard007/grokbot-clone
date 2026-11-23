// QA P-17: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'destructive-menu-contrast-'));
const evidence = path.join(root, '.context/destructive-menu-contrast');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'destructive-menu-contrast-fixture',
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

const measurements = [];
try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 768, 1280, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'contrast@example.test', name: 'QA account' } });
    assert.equal(login.status(), 200);
    const timezone = await context.request.patch(`${base}/api/auth/me`, { data: { timezone: 'UTC' } });
    assert.equal(timezone.status(), 200);
    const page = await context.newPage();
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base || (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()))) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    await page.goto(base);
    await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
    const item = page.locator('.account .menu__item.is-danger');
    await item.waitFor();
    assert.equal(await item.count(), 1);
    for (const state of ['default', 'hover', 'focus', 'pressed']) {
      if (state === 'hover') await item.hover();
      if (state === 'focus') {
        await page.mouse.move(width - 1, 0);
        await page.keyboard.press('End');
        // Establish keyboard input, then focus the item without relying on menu navigation.
        await item.focus();
        assert.equal(await item.evaluate(el => el.matches(':focus-visible')), true);
      }
      if (state === 'pressed') {
        await item.hover();
        await page.mouse.down();
        assert.equal(await item.evaluate(el => el.matches(':active')), true);
      }
      await item.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
      const measured = await item.evaluate(el => {
        const parse = value => {
          const channels = value.match(/[\d.]+/g).map(Number);
          return [...channels.slice(0, 3), channels[3] ?? 1];
        };
        const over = (front, back) => [
          ...front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3])), 1,
        ];
        const layers = [];
        for (let node = el; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
        const background = layers.reverse().reduce((back, front) => over(front, back), [255, 255, 255, 1]);
        const luminance = color => color.slice(0, 3).map(channel => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
        const foreground = parse(getComputedStyle(el.querySelector('.menu__label')).color);
        const a = luminance(over(foreground, background)), b = luminance(background);
        return {
          foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          fontSize: getComputedStyle(el).fontSize,
          iconColor: getComputedStyle(el.querySelector('.menu__icon')).color,
          labelColor: getComputedStyle(el.querySelector('.menu__label')).color,
        };
      });
      measurements.push({ width, theme, state, ...measured });
      assert.equal(measured.fontSize, '13px');
      assert.equal(measured.iconColor, measured.labelColor);
      assert.ok(measured.ratio >= 4.5, `${width}px ${theme} ${state}: ${measured.ratio.toFixed(2)}:1 must be at least 4.5:1`);
      console.log(`${width}px ${theme} ${state}: ${measured.ratio.toFixed(2)}:1`);
      if (state === 'pressed') {
        // Release away from the action so the destructive handler never runs.
        await page.mouse.move(width - 1, 0);
        await page.mouse.up();
      }
    }
    await page.screenshot({ path: path.join(evidence, `${width}-${theme}.png`) });
    assert.deepEqual(unexpected, [], 'No browser errors, external requests, or API writes');
    await context.close();
  }
  await fs.writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n');
  console.log('PASS P-17: destructive menu text contrast in both themes and all interaction states');
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
