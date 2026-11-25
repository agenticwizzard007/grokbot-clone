// Local navigation acceptance: temporary SQLite, local providers, no live sign-in.
// Run: node tests/navigation-routes-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-routes-'));
const evidence = path.join(root, '.context/navigation-routes');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
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
  await api('/bots', 'POST', { name: 'Target Bot' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280,390]) for (const theme of ['light','dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: 'swarm_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await context.addInitScript(({id, theme}) => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', id);
    }, {id: bot.id, theme});
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
    const snap = async name => page.screenshot({path:`${evidence}/${name}-${width}-${theme}.png`});
    const title = async expected => { await page.waitForFunction(value => document.title === value, `${expected} · Swarm`); };
    let visit = 0;
    const fresh = async route => { await page.goto(`${origin}/?route-check=${++visit}${route}`); await page.locator('.app').waitFor(); await page.locator('.pinned__tile').waitFor({state:'attached'}); };
    const link = async route => { await page.evaluate(value => { location.hash = value; }, route); await hash(route); };
    const closeSettings = async () => {
      if (width === 390) await page.getByRole('button', {name:'Close settings',exact:true}).click();
      else await page.locator('.access-settings__bar button').click();
    };
    const expectBack = async (selector, label, destination) => {
      const control = page.locator(selector).getByRole('button', {name:label, exact:true});
      await control.waitFor(); await control.click(); await hash(destination);
    };
    try {
      // Search is one overlay whether opened by URL, sidebar or shortcut.
      await fresh('#search'); await page.getByRole('dialog', {name:'Search',exact:true}).waitFor(); await title('Search');
      await page.getByRole('button', {name:'Close search',exact:true}).click(); await hash('#bots'); await title('Bots');
      await page.locator('.sidebar__search').click(); await hash('#search'); await title('Search');
      await page.keyboard.press('Escape'); await hash('#bots');
      await fresh('#tasks'); await title('Tasks');
      await page.keyboard.press('Control+k'); await hash('#search'); await title('Search');
      await reload('#search'); await page.getByRole('dialog', {name:'Search',exact:true}).waitFor(); await title('Search');
      await page.getByRole('button', {name:'Close search',exact:true}).click(); await hash('#tasks'); await title('Tasks');
      console.log(`PASS ${width} ${theme}: direct search, sidebar search, shortcut, reload and close`);

      // Fresh URLs never inherit the saved selected chat as their Back target.
      for (const [route, label] of [['#tasks','Tasks'], ['#team','Team'], ['#goals','Goals'], ['#reports','Reports'], ['#new-bot','Create a Bot']]) {
        await fresh(route); await title(label); await reload(route); await title(label);
        if (route === '#new-bot') await expectBack('.setup-paper__bar', 'Back to Bots', '#bots');
        else assert.equal(await page.locator('.tasks-view__header').getByRole('button', { name: /^Back/ }).count(), 0);
      }
      await fresh('#tasks');
      if (width === 1280) await page.locator('.sidebar__brand').click();
      else await link('#bots');
      await title('Bots');
      assert.equal(await page.locator('#sidebar-back-slot button').count(), 0); await back('#tasks');
      await fresh('#settings/permissions'); await title('Settings · Permissions');
      if (width === 1280) await page.locator('.sidebar-island').click();
      else await link('#tasks');
      await hash('#tasks'); await title('Tasks');
      assert.equal(await page.locator('.tasks-view__header').getByRole('button', { name: /^Back/ }).count(), 0); await back('#settings/permissions');
      await title('Settings · Permissions');
      console.log(`PASS ${width} ${theme}: direct entry and Settings then Tasks Back destinations`);

      // A form is not a group conversation, and an older origin cannot leak past Tasks.
      await fresh('#new-bot/group'); await title('New group chat');
      await page.keyboard.press('Control+,'); await hash(width === 390 ? '#settings' : '#settings/general');
      if (width === 1280) await page.getByRole('button', {name:'Back to new group chat',exact:true}).first().waitFor();
      else assert.equal(await page.getByRole('button', { name: /^Back/ }).count(), 0);
      if (width === 1280) await page.locator('.sidebar-island').click();
      else await link('#tasks');
      await hash('#tasks'); await page.keyboard.press('Control+,'); await hash(width === 390 ? '#settings' : '#settings/general');
      if (width === 1280) await page.getByRole('button', {name:'Back to Tasks',exact:true}).first().waitFor();
      else assert.equal(await page.getByRole('button', { name: /^Back/ }).count(), 0);
      if (width === 390) await page.getByRole('navigation', {name:'Settings sections'}).getByRole('button', {name:'Permissions',exact:true}).click();
      await reload(width === 390 ? '#settings/permissions' : '#settings/general');
      if (width === 390) {
        await page.getByRole('button', {name:'Back to Settings',exact:true}).click(); await hash('#settings');
      }
      if (width === 1280) await page.getByRole('button', {name:'Back to Tasks',exact:true}).first().waitFor();
      else assert.equal(await page.getByRole('button', { name: /^Back/ }).count(), 0);
      await closeSettings(); await hash('#tasks');
      for (const tab of ['Team', 'Goals', 'Reports']) {
        await page.getByRole('navigation', {name:'Work sections'}).getByRole('button', {name:tab,exact:true}).click();
        await title(tab); assert.equal(await page.locator('.tasks-view__header').getByRole('button', { name: /^Back/ }).count(), 0);
      }
      await back('#goals'); await title('Goals');
      console.log(`PASS ${width} ${theme}: current origins, phone Settings parent history and work tab Back labels`);

      // The hidden Reports screen must not be exposed by role or the accessibility tree.
      await fresh('#reports'); await title('Reports');
      await page.keyboard.press('Control+,');
      const sections = page.getByRole('navigation', {name:'Settings sections'});
      await sections.waitFor();
      for (const [section, label] of [['permissions','Permissions'],['apps','Connected apps'],['mcp','MCP servers'],['subscriptions','Models & access'],['keys','API keys'],['general','General'],['account','Account'],['messaging','Messaging'],['usage','Usage'],['computer','Computer'],['learning','Learning']]) {
        if (width === 390 && !await sections.isVisible()) await page.getByRole('button', {name:'Back to Settings',exact:true}).click();
        // Sample title in the same click dispatch, before React's passive effects.
        const immediate = await sections.getByRole('button', {name:label,exact:true}).evaluate(button => { button.click(); return document.title; });
        assert.equal(immediate, `Settings · ${label} · Swarm`);
        await hash(`#settings/${section}`); await title(`Settings · ${label}`);
        await page.locator('.app-settings__page').waitFor();
        assert.equal(await page.getByRole('heading', {name:'Reports',exact:true}).count(), 0);
        assert.equal(await page.getByRole('main').count(), 0, 'underlying work main is hidden');
        const hidden = page.locator('.main-pane');
        assert.equal(await hidden.getAttribute('hidden'), '');
      }
      await snap('settings-active-section');
      await closeSettings(); await hash('#reports'); await title('Reports');
      if (width === 1280) {
        await page.locator('.sidebar__brand').click(); await hash('#bots');
        await page.getByRole('button', {name:'All tasks',exact:true}).click(); await hash('#tasks'); await title('Tasks');
        await page.getByRole('navigation', {name:'Work sections'}).getByRole('button', {name:'Reports',exact:true}).click();
      }
      // Sidebar Tasks always means Tasks, even after visiting Reports.
      if (width === 390) await page.getByRole('button', {name:'Bot list',exact:true}).click();
      await page.locator('.sidebar-island').click(); await hash('#tasks'); await title('Tasks');
      console.log(`PASS ${width} ${theme}: all Settings titles update immediately, Reports is hidden, sidebar Tasks destination`);

      await fresh('#bots'); await page.locator('.pinned__tile').click();
      await page.locator('.composer__input').waitFor(); await title('Fixture Bot');
      const chat = new URL(page.url()).hash;
      for (const [suffix, label] of [['details/activity','Activity'],['details/tasks','Tasks'],['details/files','Files'],['details/setup','Setup'],['details/setup/harness','Harness'],['details/setup/files','Configuration files'],['details/setup/history','History'],['settings/general','General'],['settings/skills','Skills'],['settings/memories','Memories'],['settings/routines','Routines'],['settings/learning','Learning'],['settings/analytics','Analytics']]) {
        await fresh(`${chat}/${suffix}`); await title(`Fixture Bot · ${label}`);
      }
      await fresh('#new-bot'); await title('Create a Bot'); await snap('create-safe-back');
      await page.getByRole('button', {name:'New group chat instead',exact:true}).click(); await title('New group chat');
      await page.getByRole('button', {name:'Back to create a Bot',exact:true}).click(); await title('Create a Bot');
      await fresh('#apps/connect'); await page.getByRole('dialog', {name:'Connect Apps',exact:true}).waitFor(); await title('Connect apps');
      await fresh('#search'); await page.getByRole('dialog', {name:'Search',exact:true}).waitFor(); await snap('search-direct');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width} ${theme}: Bots, chat, Bot details/settings, Create, group and apps route titles`);
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
