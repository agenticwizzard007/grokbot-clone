// QA SO D-01: real local app, temporary SQLite, DEV_LOGIN, and mocked providers.
// Run: node tests/bot-settings-deep-link-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-settings-deep-link-'));
const evidence = path.join(root, '.context/bot-settings-deep-link');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [], failures = [];
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port(), mockPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
// Do not inherit provider credentials or storage locations from the workspace.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'cli'), SESSION_SECRET: 'deep-link-test-only',
  DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: origin, SERVER_URL: apiBase,
  COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`, COMPOSIO_API_KEY: '',
};
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    if (children.some(child => child.exitCode !== null)) throw new Error(`Local process exited: ${logs.join('')}`);
    await sleep(100);
  }
  throw new Error(`Local server did not start: ${url}`);
}

try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', 'server/src/index.ts']);
  await ready(`${apiBase}/api/health`);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort)], path.join(root, 'web'), { SWARM_API: apiBase });
  await ready(origin);
  const login = await fetch(`${apiBase}/api/auth/dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'deep-link@example.test', name: 'QA account' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(route, method = 'GET', body) {
    const response = await fetch(`${apiBase}/api${route}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    return response.json();
  }
  const primary = (await api('/bots')).bots.find(bot => bot.isPrimary);
  const bot = (await api(`/bots/${primary.id}`, 'PATCH', { name: 'Fixture Bot' })).bot;
  const other = (await api('/bots', 'POST', { name: 'Target Bot' })).bot;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: 'swarm_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await context.addInitScript(botId => {
      localStorage.setItem('swarm.theme', 'light');
      localStorage.setItem('swarm.selectedBot', botId);
    }, bot.id);
    const errors = [];
    // Keep toolkit discovery deterministic and block all external browser traffic.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } });
      if (url.pathname === '/api/apps/connections') return route.fulfill({ json: { connections: [] } });
      if (url.pathname.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      if (url.pathname.startsWith('/api/cli')) return route.fulfill({ json: {
        runtime: 'server', serverLoginAvailable: false, selected: null, connected: false,
        providers: { codex: { installed: false, authenticated: false }, claude: { installed: false, authenticated: false } },
      } });
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const appSettings = page.locator('.app-settings');
    const botSettings = page.locator('.bot-settings-page');
    const rawLink = (target, tab) => `#bot/${encodeURIComponent(target.id)}/settings/${tab}`;
    const hashLink = hash => page.evaluate(value => new Promise(resolve => {
      if (location.hash === value) { resolve(); return; }
      window.addEventListener('hashchange', () => resolve(), { once: true });
      location.hash = value;
    }), hash);
    const openApp = async (provider = null) => {
      if (provider) await page.evaluate(async selected => {
        (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings('subscriptions', selected);
      }, provider);
      else await page.keyboard.press('Control+,');
      await appSettings.waitFor({ state: 'visible' });
      assert.equal(await page.locator('.main-pane').getAttribute('hidden'), '');
    };
    const destination = async (target, tab) => {
      await appSettings.waitFor({ state: 'detached' });
      await botSettings.getByRole('heading', { name: `${target.name} · ${tab[0].toUpperCase()}${tab.slice(1)}`, exact: true }).waitFor();
      const active = botSettings.getByRole('navigation', { name: 'Bot settings sections' }).locator('[aria-current]');
      assert.equal(await active.innerText(), tab[0].toUpperCase() + tab.slice(1));
      assert.equal(await page.locator('.main-pane').getAttribute('hidden'), null);
      // A visible-looking page must also receive pointer events above every Settings layer.
      await active.click({ trial: true });
      const state = await page.evaluate(async () => {
        const { useConfigUI, botSettingsHash } = await import('/src/configStore.ts');
        const ui = useConfigUI.getState();
        return { appSettings: ui.appSettings, home: ui.appSettingsHome, provider: ui.subscriptionProvider,
          botSettings: ui.botSettings, hash: location.hash, expectedHash: botSettingsHash(ui.botSettings.botId, ui.botSettings.tab) };
      });
      assert.equal(state.appSettings, null);
      assert.equal(state.home, false);
      assert.equal(state.provider, null);
      assert.deepEqual(state.botSettings, { botId: target.id, tab });
      assert.equal(state.hash, state.expectedHash);
    };
    try {
      await page.goto(origin);
      await page.locator('.app').waitFor();
      await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), bot.id);
      await openApp();
      // Address-bar and anchor links both dispatch this browser hashchange event.
      await hashLink(rawLink(bot, 'memories'));
      await destination(bot, 'memories');
      await page.screenshot({ path: path.join(evidence, `${width}-hash.png`) });
      await page.reload();
      await destination(bot, 'memories');

      // A generated link must also uncover a different Bot while Settings covers the old one.
      await openApp('codex');
      const canonicalLink = await page.evaluate(async id => {
        return (await import('/src/configStore.ts')).botSettingsHash(id, 'skills');
      }, other.id);
      await hashLink(canonicalLink);
      await destination(other, 'skills');
      await page.reload();
      await destination(other, 'skills');
      await page.screenshot({ path: path.join(evidence, `${width}-generated-link.png`) });

      // A same-Bot link preserves its General draft when uncovering another tab.
      await openApp();
      await hashLink(rawLink(bot, 'general'));
      await destination(bot, 'general');
      await botSettings.getByLabel('Name', { exact: true }).fill('Unsaved fixture name');
      await page.waitForFunction(async () => (await import('/src/configStore.ts')).useConfigUI.getState().botSettingsDirty);
      await openApp();
      await hashLink(rawLink(bot, 'memories'));
      await destination(bot, 'memories');
      await botSettings.getByRole('button', { name: 'General', exact: true }).click();
      assert.equal(await botSettings.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture name');

      // A different Bot still asks before dropping that draft, with the guard uncovered.
      await openApp();
      await hashLink(rawLink(other, 'skills'));
      const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
      await guard.waitFor();
      await appSettings.waitFor({ state: 'detached' });
      await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await destination(bot, 'general');
      assert.equal(await botSettings.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture name');
      await openApp();
      await hashLink(rawLink(other, 'skills'));
      await guard.getByRole('button', { name: 'Discard', exact: true }).click();
      await destination(other, 'skills');
      await page.screenshot({ path: path.join(evidence, `${width}-discard.png`) });

      // A passive roster refresh is not a new link, even if phone Settings keeps the underlying hash.
      await openApp();
      const sectionAfterRefresh = await page.evaluate(async () => {
        await (await import('/src/store.ts')).useStore.getState().loadBots();
        return (await import('/src/configStore.ts')).useConfigUI.getState().appSettings;
      });
      assert.equal(sectionAfterRefresh, 'general', 'A roster refresh preserves intentionally opened app Settings');
      await appSettings.waitFor({ state: 'visible' });
      await hashLink(rawLink(other, 'memories'));
      await destination(other, 'memories');

      // Returning from the destination still restores the ordinary phone Bot list.
      if (width === 390) {
        await botSettings.getByRole('button', { name: 'Back to Bots', exact: true }).click();
        await page.locator('.app.is-mobile.pane-list').waitFor();
        await botSettings.waitFor({ state: 'detached' });
        await appSettings.waitFor({ state: 'detached' });
        await page.waitForFunction(() => location.hash === '');
      }

      // Links can arrive while the initial Bot list is still loading behind Settings.
      for (const [target, link] of [[bot, rawLink(bot, 'skills')], [other, canonicalLink]]) for (const reopenSettings of [false, true]) {
        const releaseBots = Promise.withResolvers();
        await page.route('**/api/bots', async route => {
          await releaseBots.promise;
          await route.continue();
        });
        try {
          const botsRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/bots');
          await page.goto(`${origin}/?delayed-bots=${reopenSettings}`);
          await page.locator('.app').waitFor();
          await botsRequested;
          await openApp();
          await hashLink(link);
          assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().bots.length), 0);
          // A newer explicit Settings action cancels the pending navigation.
          if (reopenSettings) await openApp();
          releaseBots.resolve();
          await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), target.id);
          if (reopenSettings) {
            assert.equal(await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().appSettings), 'general');
            assert.equal(await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().botSettings), null, 'A canceled link does not open a hidden Bot page');
            await appSettings.waitFor({ state: 'visible' });
          } else {
            await destination(target, 'skills');
            await page.screenshot({ path: path.join(evidence, `${width}-delayed.png`) });
          }
        } finally {
          releaseBots.resolve();
          await page.unroute('**/api/bots');
        }
        if (!reopenSettings) { await page.reload(); await destination(target, 'skills'); }
      }
      assert.deepEqual(errors, []);
      console.log(`PASS D-01 ${width}px: links, reload, drafts, delayed loading, passive refresh, and newer Settings navigation`);
    } catch (error) {
      failures.push(`${width}px: ${error.message}`);
      await page.screenshot({ path: path.join(evidence, `${width}-failure.png`) }).catch(() => {});
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'Bot settings deep links must replace app Settings at every viewport');
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  throw error;
} finally {
  await browser?.close();
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }));
  fs.rmSync(temp, { recursive: true, force: true });
}
