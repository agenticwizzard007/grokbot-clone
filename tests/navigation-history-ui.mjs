// QA R4 and D-01: real local app, temporary SQLite, DEV_LOGIN, and mocked providers.
// Run: node tests/navigation-history-ui.mjs
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
const evidence = path.join(root, '.context/navigation');
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

  for (const width of [1280,390]) {
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
    const hash = async expected => { await page.waitForFunction(value => location.hash === value, expected); };
    const back = async expected => { await page.goBack(); await hash(expected); };
    const forward = async expected => { await page.goForward(); await hash(expected); };
    const reload = async expected => { await page.reload(); await hash(expected); await page.locator('.app').waitFor(); };
    const snap = async name => page.screenshot({path:`${evidence}/${name}-${width}.png`});
    try {
      await page.goto(`${origin}/#bots`);
      await page.locator('.app').waitFor();
      await page.locator('.pinned__tile').click();
      await page.locator('.composer__input').waitFor();
      const chat = await page.evaluate(() => location.hash);
      assert.match(chat, /^#bot\/fixture-bot~/);
      await page.keyboard.press('Control+,');
      if (width === 390) {
        await hash('#settings');
        await page.getByRole('navigation', {name:'Settings sections'}).getByRole('button', {name:'General',exact:true}).click();
      }
      await hash('#settings/general');
      const sections = page.getByRole('navigation', {name:'Settings sections'});
      for (const section of ['Account','Messaging','Usage']) {
        if (width === 390) {
          await page.getByRole('button', {name:'Back to Settings',exact:true}).click();
          await hash('#settings');
          await sections.getByRole('button',{name:section,exact:true}).click();
        } else await sections.getByRole('button',{name:section,exact:true}).click();
        await hash(`#settings/${section.toLowerCase()}`);
      }
      if (width === 1280) {
        await page.locator('.settings-nav__back').getByText('Back to Settings',{exact:true}).waitFor();
        await snap('settings-sidebar-back');
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        const rail = page.locator('.sidebar');
        const railBack = await rail.getByRole('button', { name: 'Back to Settings', exact: true }).boundingBox();
        const railExpand = await rail.getByRole('button', { name: 'Expand sidebar to browse settings', exact: true }).boundingBox();
        assert.ok(railBack && railExpand && railBack.y + railBack.height <= railExpand.y, 'collapsed Back and Expand controls do not overlap');
        const brand = await rail.locator('.sidebar__brand').boundingBox();
        assert.ok(brand && railBack.y + railBack.height <= brand.y, 'Back sits above the brand and all other rail icons');
        await snap('settings-collapsed-back');
        await rail.getByRole('button', { name: 'Expand sidebar to browse settings', exact: true }).click();
      }
      for (const section of width === 390 ? [] : ['messaging','account','general']) { await back(`#settings/${section}`); await page.locator('.access-settings__bar-title').getByText(section[0].toUpperCase()+section.slice(1),{exact:true}).waitFor(); }
      if (width === 390) await back('#settings');
      await back(chat);
      await page.locator('.composer__input').waitFor();
      if (width === 390) await forward('#settings');
      if (width === 390) await forward('#settings/usage');
      else { await forward('#settings/general'); await forward('#settings/account'); }
      await reload(width === 390 ? '#settings/usage' : '#settings/account');
      await page.getByRole('heading',{name:width === 390 ? 'Understand reported usage' : 'Your account',exact:true}).waitFor();
      if (width === 390) {
        await page.getByRole('button',{name:'Back to Settings',exact:true}).click(); await hash('#settings');
        await reload('#settings'); await sections.waitFor();
        assert.equal(await page.getByRole('button', { name: /^Back/ }).count(), 0);
        await page.getByRole('button',{name:'Close settings',exact:true}).click();
      } else {
        await page.locator('.settings-nav__back').getByText('Back to Settings', {exact:true}).waitFor();
        await page.locator('.access-settings__bar').getByRole('button', {name:'Back to Settings',exact:true}).waitFor();
        await page.locator('.settings-nav__back').click(); await hash('#settings');
        await page.keyboard.press('Escape');
      }
      await hash(chat);
      if (width === 390) {
        await page.keyboard.press('Control+,'); await hash('#settings');
        for (const section of ['Account', 'Messaging', 'General']) {
          await sections.getByRole('button', {name:section,exact:true}).click();
          await hash(`#settings/${section.toLowerCase()}`);
          if (section !== 'General') {
            await page.getByRole('button', {name:'Back to Settings',exact:true}).click(); await hash('#settings');
            await forward(`#settings/${section.toLowerCase()}`); await back('#settings');
            await reload('#settings');
          }
        }
        for (const route of ['#settings', chat]) await back(route);
        for (const route of ['#settings', '#settings/general']) await forward(route);
        await page.getByRole('button', {name:'Close settings',exact:true}).click(); await hash(chat);
      }
      await page.keyboard.press('Control+k'); await hash('#search');
      await page.getByRole('button',{name:'Close search',exact:true}).waitFor();
      await back(chat); await page.getByRole('dialog',{name:'Search',exact:true}).waitFor({state:'detached'});
      await page.keyboard.press('Control+k'); await page.getByRole('button',{name:'Close search',exact:true}).click(); await hash(chat);
      await back('#bots'); await forward(chat);
      await page.keyboard.press('Control+k'); await page.keyboard.press('Escape'); await hash(chat); await back('#bots'); await forward(chat);
      await page.keyboard.press('Control+k'); await reload('#search'); await page.getByRole('button',{name:'Close search',exact:true}).click(); await hash(chat);
      // Tasks and every work tab are restorable, at both widths.
      if (width === 390) { await page.getByRole('button',{name:'All Bots',exact:true}).click(); await hash('#bots'); }
      await page.locator('.sidebar-island').click(); await hash('#tasks');
      for (const tab of ['Team','Goals','Reports']) { await page.getByRole('navigation',{name:'Work sections'}).getByRole('button',{name:tab === 'Reports' ? 'Files' : tab,exact:true}).click(); await hash(`#${tab.toLowerCase()}`); }
      await reload('#reports');
      assert.equal(await page.locator('.tasks-view__header').getByRole('button', { name: /^Back/ }).count(), 0);
      for (const tab of ['goals','team','tasks']) await back(`#${tab}`);
      await back(width === 390 ? '#bots' : chat); await forward('#tasks');
      await back(width === 390 ? '#bots' : chat);
      // Create and group have distinct entries, including direct entry and reload.
      await page.keyboard.press('Alt+Shift+n'); await hash('#new-bot');
      await reload('#new-bot'); await page.getByRole('heading',{name:'Create a Bot',exact:true}).waitFor();
      await page.getByRole('button',{name:'New group chat instead',exact:true}).click(); await hash('#new-bot/group');
      await reload('#new-bot/group'); await page.getByRole('heading',{name:'New group chat',exact:true}).waitFor();
      await back('#new-bot'); await forward('#new-bot/group');
      await page.getByRole('button',{name:'Back to create a Bot',exact:true}).click(); await hash('#new-bot');
      await back(width === 390 ? '#bots' : chat);
      if (width === 390) await page.locator('.pinned__tile').click();
      await page.getByRole('button',{name:'Show details',exact:true}).click();
      await hash(`${chat}/details/activity`);
      const detailTabs = page.getByRole('navigation',{name:'Conversation details sections'});
      for (const [label,slug] of [['Tasks','tasks'],['Files','files'],['Setup','setup']]) { await detailTabs.getByRole('button',{name:label,exact:true}).click(); await hash(`${chat}/details/${slug}`); }
      for (const tab of ['Harness','Files','History']) { await page.getByRole('tablist',{name:'Bot configuration sections'}).getByRole('tab',{name:tab,exact:true}).click(); await hash(`${chat}/details/setup/${tab.toLowerCase()}`); }
      await reload(`${chat}/details/setup/history`);
      await page.getByRole('tab',{name:'History',exact:true}).waitFor();
      await back(`${chat}/details/setup/files`); await back(`${chat}/details/setup/harness`); await back(`${chat}/details/setup`);
      await detailTabs.getByRole('button',{name:'Activity',exact:true}).click();
      // Create has a fixed parent; browser Back still retains the details entry.
      await page.keyboard.press('Alt+Shift+n'); await hash('#new-bot');
      await reload('#new-bot');
      await page.getByRole('button', {name:'Back to Bots',exact:true}).waitFor();
      await snap('create-details-reload');
      await page.getByRole('button', {name:'Back to Bots',exact:true}).click(); await hash('#bots');
      await back('#new-bot'); await back(`${chat}/details/activity`);
      await page.locator('.details').waitFor();
      await page.getByRole('button',{name:'Bot settings',exact:true}).click(); await hash(`${chat}/settings/general`);
      for (const tab of ['Skills','Memories','Routines','Learning','Analytics']) { await page.getByRole('navigation',{name:'Bot settings sections'}).getByRole('button',{name:tab,exact:true}).click(); await hash(`${chat}/settings/${tab.toLowerCase()}`); }
      await reload(`${chat}/settings/analytics`);
      await page.getByRole('button', {name:'Back to Fixture Bot chat',exact:true}).waitFor();
      for (const tab of ['learning','routines','memories','skills','general']) await back(`${chat}/settings/${tab}`);
      await back(`${chat}/details/activity`); await page.locator('.details').waitFor();
      await page.getByRole('button',{name:'Close details',exact:true}).click(); await hash(chat);
      await reload(chat); await page.locator('.composer__input').waitFor();
      // A persisted origin can disappear while this page is closed/reloaded.
      await page.getByRole('button', {name:'Show details',exact:true}).click();
      await page.keyboard.press('Alt+Shift+n'); await hash('#new-bot');
      const withoutOrigin = async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({response, json:{...body, bots:body.bots.filter(item => item.id !== bot.id)}});
      };
      await context.route('**/api/bots', withoutOrigin);
      await reload('#new-bot');
      await page.getByRole('button', {name:'Back to Bots',exact:true}).waitFor();
      await page.getByRole('button', {name:'Back to Bots',exact:true}).click(); await hash('#bots');
      await context.unroute('**/api/bots', withoutOrigin);
      await page.goto(`${origin}/?restored=1${chat}`); await page.locator('.composer__input').waitFor();
      await page.goto(`${origin}/#bot/deleted/settings/general`); await hash('#bots');
      // Same Create URL without a known in-app trail must not reuse details.
      await page.goto(`${origin}/?fresh=1#new-bot`); await reload('#new-bot');
      const fallbackLabel = 'Back to Bots';
      await page.getByRole('button', {name:fallbackLabel,exact:true}).waitFor();
      await snap('create-parent-reload');
      await page.locator('.setup-paper__back').click(); await hash('#bots');
      await page.goto(`${origin}/#new-bot/group`); await page.getByRole('button',{name:'Back to create a Bot',exact:true}).click(); await hash('#new-bot');
      await page.locator('.setup-paper__close').click(); await page.locator('.app').waitFor(); assert.equal(new URL(page.url()).origin, origin);
      await snap('safe-deep-link-back');
      if (width === 1280) {
        const sidebar = page.locator('.sidebar');
        for (const theme of ['Light', 'Dark']) {
          for (const [label, destination] of [['chat', chat], ['Tasks', '#tasks'], ['details', `${chat}/details/activity`]]) {
            await page.goto(`${origin}/?rail=${theme}-${label}${destination}`);
            await page.locator('.app').waitFor();
            if (label === 'chat') await page.locator('.composer__input').waitFor();
            if (label === 'Tasks') await page.locator('.tasks-view__header').waitFor();
            if (label === 'details') await page.locator('.details').waitFor();
            await page.keyboard.press('Control+,'); await hash('#settings/general');
            const compact = page.getByRole('switch', { name: 'Compact sidebar', exact: true });
            if (await compact.getAttribute('aria-checked') !== 'true') await compact.click();
            await reload('#settings/general');
            await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: theme, exact: true }).click();
            const backButton = sidebar.getByRole('button', { name: 'Back to Settings', exact: true });
            await backButton.waitFor();
            assert.equal(await backButton.getAttribute('title'), 'Back to Settings');
            assert.equal(await backButton.locator('svg.lucide-arrow-left').count(), 1, 'Back uses an arrow, distinct from Expand');
            const box = await backButton.boundingBox();
            assert.ok(box && box.width >= 44 && box.height >= 44, 'Back has a full icon-button target');
            const railBox = await sidebar.boundingBox();
            assert.ok(box.x >= railBox.x && box.x + box.width <= railBox.x + railBox.width && box.y >= railBox.y);
            for (const otherButton of await sidebar.getByRole('button').all()) {
              if (await otherButton.getAttribute('aria-label') === 'Back to Settings') continue;
              const otherBox = await otherButton.boundingBox();
              if (otherBox) assert.ok(box.y + box.height <= otherBox.y, 'Back is above every other visible rail icon without overlap');
            }
            const expand = sidebar.getByRole('button', { name: 'Expand sidebar', exact: true });
            assert.match(await expand.getAttribute('title'), /^Expand sidebar/);
            await expand.click(); await hash('#settings/general');
            await sidebar.locator('.settings-nav__back').getByText('Back to Settings', { exact: true }).waitFor();
            assert.equal(await sidebar.locator('.sidebar__back').count(), 0, 'expanding restores the labeled row');
            await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
            await page.keyboard.press('Tab');
            await backButton.focus();
            assert.ok(await backButton.evaluate(el => el.matches(':focus-visible')));
            await snap(`compact-back-${theme.toLowerCase()}-${label}`);
            if (label === 'Tasks') await page.keyboard.press('Enter');
            else await backButton.click();
            await hash('#settings');
            assert.equal(await sidebar.locator('.sidebar__back').count(), 0, 'Settings home has no Back control');
            await page.keyboard.press('Escape'); await hash(destination);
            console.log(`PASS compact rail ${theme}: Back to Settings above all icons from ${label}, separate Expand, reload and navigation`);
          }
          await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
          const botsLabel = sidebar.locator('.sidebar__section-label');
          assert.equal(await botsLabel.getAttribute('type'), 'button');
          await botsLabel.click(); await hash('#bots');
          await page.getByRole('heading', { name: 'Your Bots', exact: true }).waitFor();
          for (const key of ['Enter', 'Space']) {
            await sidebar.locator('.pinned__tile').click(); await hash(chat);
            await page.keyboard.press('Tab');
            await botsLabel.focus();
            assert.ok(await botsLabel.evaluate(el => el.matches(':focus-visible')));
            await page.keyboard.press(key); await hash('#bots');
          }
          console.log(`PASS Your Bots ${theme}: click, Enter and Space open #bots`);
        }
      }
      // Planned provider returns without a hash still reopen their saved section.
      await page.evaluate(target => sessionStorage.setItem('swarm.resume', JSON.stringify(target)), {
        section: 'subscriptions', provider: 'codex', accountId: (await api('/auth/me')).user.id,
        action: 'login', expiresAt: Date.now() + 600_000,
      });
      await page.goto(origin); await hash('#settings/subscriptions');
      await page.locator('.access-settings__bar-title').getByText('Models & access', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS navigation ${width}px: Settings, Back/Forward/reload, Tasks, Search, details, Bot settings, Create/group and safe deep links`);
    } catch(error) { console.error('Page errors:', errors); await snap('failure'); throw error; }
    finally { await context.close(); }
  }
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
