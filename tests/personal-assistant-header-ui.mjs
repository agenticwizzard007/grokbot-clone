// QA SO L-02: real creation and reload against local SQLite, dev login and mocked providers.
// Run: node tests/personal-assistant-header-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), 'swarm-header-'));
const evidence = path.join(root, '.context/personal-assistant-header');
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
  CLI_PROFILES_DIR: path.join(temp, 'cli'), SESSION_SECRET: 'header-test-only',
  DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin,
  COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0',
  INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1', COMPOSIO_API_KEY: 'header-test-project',
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

  for (const width of [390, 768, 1280, 1440, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const api = async (pathname, method = 'GET', data) => {
      const response = await context.request.fetch(`${origin}/api${pathname}`, { method, data });
      assert.ok(response.ok(), `${method} ${pathname}: ${response.status()}`);
      return response.json();
    };
    await api('/auth/dev', 'POST', { email: `header-${width}@example.test`, name: 'Header test account' });
    const primary = (await api('/bots')).bots.find(bot => bot.isPrimary);
    await api(`/bots/${primary.id}`, 'PATCH', { name: 'Primary Bot', label: '' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      errors.push('Unexpected external browser request');
      return route.abort();
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'New Bot', exact: true }).waitFor();
    const subtitle = page.locator('.chat__subtitle');
    const check = async expected => {
      await page.waitForFunction(text => {
        const subtitle = document.querySelector('.chat__subtitle');
        return subtitle?.textContent === text && subtitle.getBoundingClientRect().width > 0;
      }, expected).catch(async error => {
        await page.screenshot({ path: path.join(evidence, `failure-${width}.png`) });
        throw new Error(`Expected subtitle "${expected}" at ${width}px, received "${await subtitle.textContent()}"`, { cause: error });
      });
      assert.equal(await subtitle.innerText(), expected);
      const bounds = await subtitle.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Header subtitle is visible in the viewport');
    };
    const open = async name => {
      if (width <= 760 && await page.getByRole('button', { name: 'All Bots', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      }
      await page.locator('.bot-row, .pinned__tile').filter({ has: page.getByText(name, { exact: true }) }).click();
    };
    const created = [];
    for (const [mode, type, expected] of [['personal', 'Personal assistant', 'Personal assistant'], ['teammate', 'Teammate', 'Your teammate']]) {
      if (width <= 760 && await page.getByRole('button', { name: 'All Bots', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      }
      await page.getByRole('button', { name: 'New Bot', exact: true }).click();
      const name = `${type} Bot`;
      await page.getByPlaceholder('Give your Bot a name', { exact: true }).fill(name);
      // create-type: radio semantics, one tab stop, arrow selection and wraparound.
      const types = page.getByRole('radiogroup', { name: 'Bot type', exact: true });
      const personal = types.getByRole('radio', { name: 'Personal assistant', exact: true });
      const teammate = types.getByRole('radio', { name: 'Teammate', exact: true });
      const selected = async (radio, other) => {
        assert.equal(await radio.getAttribute('aria-checked'), 'true');
        assert.equal(await radio.getAttribute('tabindex'), '0');
        assert.equal(await other.getAttribute('aria-checked'), 'false');
        assert.equal(await other.getAttribute('tabindex'), '-1');
        assert.equal(await radio.evaluate(element => element === document.activeElement), true);
      };
      await page.getByRole('combobox', { name: 'Color' }).focus();
      await page.keyboard.press('Tab');
      await selected(personal, teammate);
      for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
        await page.keyboard.press(key);
        await selected(teammate, personal);
        await page.keyboard.press(key);
        await selected(personal, teammate);
      }
      await teammate.click();
      await selected(teammate, personal);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      await selected(teammate, personal);
      await personal.click();
      await selected(personal, teammate);
      if (mode === 'teammate') {
        await page.keyboard.press('ArrowRight');
        await selected(teammate, personal);
      }
      await page.screenshot({ path: path.join(evidence, `create-type-${mode}-${width}.png`) });
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await check(expected);
      const bot = (await api('/bots')).bots.find(bot => bot.name === name);
      assert.ok(bot && !bot.isPrimary && !bot.label && !bot.description);
      assert.equal(bot.mode, mode, 'The selected type is persisted by the creation API');
      created.push(bot);
      await page.reload();
      await page.getByRole('button', { name: 'New Bot', exact: true }).waitFor();
      await open(name);
      await check(expected);
      if (mode === 'personal') await page.screenshot({ path: path.join(evidence, `personal-${width}.png`) });
      await api(`/bots/${bot.id}`, 'PATCH', { description: 'Custom purpose' });
      await check('Custom purpose');
      await api(`/bots/${bot.id}`, 'PATCH', { label: 'Custom label' });
      await check('Custom label');
      await api(`/bots/${bot.id}`, 'PATCH', { label: '', description: '' });
      await check(expected);
    }
    // QA header-sep: a compressed menu chevron must not look like a stray separator.
    const headerBot = created[0];
    await open(headerBot.name);
    for (const name of ['QA-Short', 'QA-Long-' + 'B'.repeat(52)]) {
      for (const label of ['', 'L'.repeat(40)]) {
        await api(`/bots/${headerBot.id}`, 'PATCH', { name, label });
        await page.waitForFunction(expected => document.querySelector('.chat__pill-name')?.textContent === expected, name);
        await check(label || 'Personal assistant');
        await page.evaluate(() => document.fonts.ready);
        const pill = page.locator('.chat__pill');
        const geometry = await pill.evaluate(element => {
          const box = node => {
            const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
          };
          const name = element.querySelector('.chat__pill-name');
          const subtitle = document.querySelector('.chat__subtitle');
          return {
            pill: box(element), name: box(name), chevron: box(element.querySelector('svg')),
            anchor: box(element.parentElement), subtitle: box(subtitle),
            details: box(document.querySelector('.chat__details')),
            nameTruncated: name.scrollWidth > name.clientWidth,
            subtitleTruncated: subtitle.scrollWidth > subtitle.clientWidth,
            nameOverflow: getComputedStyle(name).textOverflow,
            subtitleOverflow: getComputedStyle(subtitle).textOverflow,
          };
        });
        const scenario = `${width}px ${name.startsWith('QA-Long') ? 'long' : 'short'} name, ${label ? 'long' : 'empty'} label`;
        await page.screenshot({ path: path.join(evidence, `header-sep-${width}-${name.startsWith('QA-Long') ? 'long' : 'short'}-${label ? 'label' : 'empty'}.png`) });
        assert.equal(await pill.textContent(), name, `${scenario}: no trailing separator text`);
        assert.equal(geometry.chevron.width, 14, `${scenario}: menu chevron keeps its full width`);
        assert.equal(geometry.chevron.height, 14, `${scenario}: menu chevron keeps its full height`);
        assert.ok(geometry.name.width >= (name.startsWith('QA-Long') ? 80 : 40), `${scenario}: name stays readable`);
        assert.ok(geometry.name.right < geometry.chevron.left, `${scenario}: name does not overlap the chevron`);
        for (const bounds of [geometry.pill, geometry.anchor]) {
          assert.ok(geometry.chevron.left >= bounds.left && geometry.chevron.right <= bounds.right + 0.5 &&
            geometry.chevron.top >= bounds.top && geometry.chevron.bottom <= bounds.bottom + 0.5,
          `${scenario}: the complete chevron stays inside its control and column`);
        }
        assert.ok(geometry.anchor.right <= geometry.details.left, `${scenario}: header stays clear of Details`);
        assert.ok(geometry.subtitle.top >= geometry.pill.bottom, `${scenario}: subtitle remains below the name`);
        assert.equal(geometry.nameOverflow, 'ellipsis');
        assert.equal(geometry.subtitleOverflow, 'ellipsis');
        if (width === 390 && label) assert.ok(geometry.subtitleTruncated, `${scenario}: exercises subtitle truncation`);
        if (name.startsWith('QA-Long')) assert.ok(geometry.nameTruncated, `${scenario}: exercises name truncation`);
        else assert.ok(!geometry.nameTruncated, `${scenario}: short name fits`);
        await pill.locator('svg').click();
        await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).waitFor();
        assert.equal(await pill.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await pill.getAttribute('aria-expanded'), 'false');
      }
    }
    await open('Primary Bot');
    await check('Your primary Bot');
    await api(`/bots/${primary.id}`, 'PATCH', { label: 'Primary label' });
    await check('Primary label');
    for (const bot of created) await api(`/bots/${bot.id}/setup/skip`, 'POST');
    const group = await api('/rooms', 'POST', { name: 'Header group', botIds: created.map(bot => bot.id) });
    await api(`/bots/${group.id}`, 'PATCH', { label: '' });
    await open('Header group');
    await check('Group conversation');
    await api(`/bots/${group.id}`, 'PATCH', { label: 'Group label' });
    await check('Group label');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px: personal and teammate creation, persisted mode, reload, label, description, primary and group precedence; header-sep long and short names with empty and long labels`);
  }
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  })));
  await rm(temp, { recursive: true, force: true });
}
