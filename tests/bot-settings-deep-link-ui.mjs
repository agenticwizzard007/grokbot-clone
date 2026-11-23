// QA R4 and D-01: real local app, temporary SQLite, DEV_LOGIN, and mocked providers.
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

  for (const width of [1440, 1280, 1024, 768, 390]) {
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
    // A fixture anchor inside the open surface exercises an actual pointer click
    // and browser hash navigation, without adding a test link to production UI.
    const clickLink = async (surface, hash) => {
      await surface.evaluate((element, value) => {
        const anchor = document.createElement('a');
        anchor.href = value;
        anchor.textContent = 'Open fixture settings';
        anchor.dataset.testid = 'settings-fixture-link';
        element.prepend(anchor);
      }, hash);
      await surface.getByTestId('settings-fixture-link').click();
      await page.getByTestId('settings-fixture-link').evaluateAll(links => links.forEach(link => link.remove()));
    };
    const appDestination = async (section = 'general') => {
      await appSettings.waitFor({ state: 'visible' });
      await botSettings.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.main-pane').getAttribute('hidden'), '');
      const state = await page.evaluate(async () => {
        const ui = (await import('/src/configStore.ts')).useConfigUI.getState();
        return { section: ui.appSettings, bot: ui.botSettings, hash: location.hash };
      });
      assert.deepEqual(state, { section, bot: null, hash: `#settings/${section}` });
    };
    const openApp = async (provider = null) => {
      if (provider) await page.evaluate(async selected => {
        (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings('subscriptions', selected);
      }, provider);
      else await page.keyboard.press('Control+,');
      await appDestination(provider ? 'subscriptions' : 'general');
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
      // D-01: click a Bot deep link while app Settings is visibly open.
      await clickLink(page.locator('.app-settings__main'), rawLink(bot, 'memories'));
      await destination(bot, 'memories');
      await page.screenshot({ path: path.join(evidence, `${width}-hash.png`) });
      await page.reload();
      await destination(bot, 'memories');

      // R4: the comma shortcut replaces Bot settings, including on phones.
      await openApp();
      await page.screenshot({ path: path.join(evidence, `${width}-exclusive-app-settings.png`) });
      await page.reload();
      await appDestination();
      // Section clicks also retain the matching URL through reload.
      const appSections = page.getByRole('navigation', { name: 'Settings sections' });
      if (!await appSections.isVisible()) await appSettings.getByRole('button', { name: 'Back to Settings', exact: true }).click();
      await appSections.getByRole('button', { name: 'Learning', exact: true }).click();
      await appDestination('learning');
      await page.reload();
      await appDestination('learning');

      // Direct entry points share the same exclusive switch as hash links.
      await page.evaluate(async id => (await import('/src/configStore.ts')).useConfigUI.getState().openBotSettings(id, 'routines'), bot.id);
      await destination(bot, 'routines');
      await page.reload();
      await destination(bot, 'routines');

      // The desktop account menu is another default Settings entry point.
      if (width === 1280) {
        await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Settings/ }).click();
        await appDestination();
      }

      // A production Bot settings button opens an explicit app section.
      await hashLink(rawLink(bot, 'learning'));
      await destination(bot, 'learning');
      await botSettings.getByRole('button', { name: 'Review history', exact: true }).click();
      await botSettings.getByRole('button', { name: 'View background learning usage', exact: true }).click();
      await appDestination('usage');
      await page.reload();
      await appDestination('usage');

      // A generated link also switches away from a provider-specific app section.
      await openApp('codex');
      const canonicalLink = await page.evaluate(async id => {
        return (await import('/src/configStore.ts')).botSettingsHash(id, 'skills');
      }, other.id);
      await clickLink(page.locator('.app-settings__main'), canonicalLink);
      await destination(other, 'skills');
      await page.reload();
      await destination(other, 'skills');
      await page.screenshot({ path: path.join(evidence, `${width}-generated-link.png`) });

      // A same-Bot link preserves its General draft across tabs.
      await openApp();
      await hashLink(rawLink(bot, 'general'));
      await destination(bot, 'general');
      await botSettings.getByLabel('Name', { exact: true }).fill('Unsaved fixture name');
      await page.waitForFunction(async () => (await import('/src/configStore.ts')).useConfigUI.getState().botSettingsDirty);
      await hashLink(rawLink(bot, 'memories'));
      await destination(bot, 'memories');
      await botSettings.getByRole('button', { name: 'General', exact: true }).click();
      assert.equal(await botSettings.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture name');

      // R4: app Settings cannot silently drop or cover an unsaved Bot draft.
      const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
      await page.keyboard.press('Control+,');
      await guard.waitFor();
      await appSettings.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async () => location.hash === (await import('/src/configStore.ts')).botSettingsHash(
        (await import('/src/configStore.ts')).useConfigUI.getState().botSettings.botId, 'general')), true);
      await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await destination(bot, 'general');
      assert.equal(await botSettings.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture name');

      // A different Bot still asks before dropping that draft.
      await hashLink(rawLink(other, 'skills'));
      await guard.waitFor();
      await appSettings.waitFor({ state: 'detached' });
      await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await destination(bot, 'general');
      assert.equal(await botSettings.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture name');
      await hashLink(rawLink(other, 'skills'));
      await guard.getByRole('button', { name: 'Discard', exact: true }).click();
      await destination(other, 'skills');
      await page.screenshot({ path: path.join(evidence, `${width}-discard.png`) });

      // An app section link also guards a draft, restores the Bot URL on Cancel,
      // and opens only app Settings after Discard.
      await hashLink(rawLink(bot, 'general'));
      await destination(bot, 'general');
      await botSettings.getByLabel('Name', { exact: true }).fill('Discard this fixture draft');
      await page.waitForFunction(async () => (await import('/src/configStore.ts')).useConfigUI.getState().botSettingsDirty);
      await clickLink(botSettings.locator('header').first(), '#settings/learning');
      await guard.waitFor();
      await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await destination(bot, 'general');
      await hashLink('#settings/learning');
      await guard.getByRole('button', { name: 'Discard', exact: true }).click();
      await appDestination('learning');
      await page.reload();
      await appDestination('learning');

      // A passive roster refresh is not a new navigation.
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

      // Keep the held HTTP response as the only source of the initial roster.
      await page.addInitScript(() => {
        window.EventSource = class {
          constructor() { setTimeout(() => this.onopen?.(), 0); }
          close() {}
        };
      });
      // Ordinary routes show the roster gate; scoped work routes retain their shell.
      // Settings intent and a later Bot link must survive either loading surface.
      for (const entry of ['', `#bot/${encodeURIComponent(bot.id)}/tasks`])
      for (const [target, link] of [[bot, rawLink(bot, 'skills')], [other, canonicalLink]]) for (const reopenSettings of [false, true]) {
        const releaseBots = Promise.withResolvers();
        await page.route('**/api/bots', async route => {
          await releaseBots.promise;
          await route.continue();
        });
        try {
          const botsRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/bots');
          await page.goto(`${origin}/?delayed-bots=${reopenSettings}${entry}`);
          await botsRequested;
          const loading = page.locator(entry ? '.tasks-view' : '.boot--data');
          await loading.getByText('Loading Bots...', { exact: true }).waitFor();
          const pendingApp = async () => {
            await page.keyboard.press('Control+,');
            await page.waitForFunction(async () => {
              const ui = (await import('/src/configStore.ts')).useConfigUI.getState();
              return ui.appSettings === 'general' && ui.botSettings === null && location.hash === '#settings/general';
            });
            await botSettings.waitFor({ state: 'detached' });
            if (entry) await appDestination();
            else await loading.waitFor({ state: 'visible' });
          };
          await pendingApp();
          await hashLink(link);
          assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().bots.length), 0);
          // A newer explicit Settings action cancels the pending navigation.
          if (reopenSettings) await pendingApp();
          releaseBots.resolve();
          await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), target.id);
          if (reopenSettings) {
            assert.equal(await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().appSettings), 'general');
            assert.equal(await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().botSettings), null, 'A canceled link does not open a hidden Bot page');
            await appDestination();
          } else {
            await destination(target, 'skills');
            await page.screenshot({ path: path.join(evidence, `${width}-delayed-${entry ? 'work' : 'boot'}-${target.id}.png`) });
          }
        } finally {
          releaseBots.resolve();
          // Wait for released handlers before Playwright can fall back or close the page.
          await page.unrouteAll({ behavior: 'wait' });
        }
        if (!reopenSettings) { await page.reload(); await destination(target, 'skills'); }
      }
      assert.deepEqual(errors, []);
      console.log(`PASS R4 and D-01 ${width}px: exclusive settings, in-app link clicks, shortcuts, reload, drafts, delayed loading, and passive refresh`);
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
