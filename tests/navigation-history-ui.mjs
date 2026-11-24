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
          // Section list Back is deliberately exercised separately below. A real
          // fixture anchor allows consecutive section links on the phone too.
          await page.locator('.app-settings__main').evaluate((element, section) => { const a=document.createElement('a');a.href=`#settings/${section.toLowerCase()}`;a.textContent='Next section';a.id='next-section';element.prepend(a); }, section);
          await page.locator('#next-section').click();
          await page.locator('#next-section').evaluateAll(elements => elements.forEach(e=>e.remove()));
        } else await sections.getByRole('button',{name:section,exact:true}).click();
        await hash(`#settings/${section.toLowerCase()}`);
      }
      if (width === 1280) {
        await page.locator('.settings-nav__back').getByText('Back to chat',{exact:true}).waitFor();
        await snap('settings-sidebar-back');
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        const rail = page.getByRole('navigation', { name: 'Settings sidebar' });
        const railBack = await rail.getByRole('button', { name: 'Back to chat', exact: true }).boundingBox();
        const railExpand = await rail.getByRole('button', { name: 'Expand sidebar to browse settings', exact: true }).boundingBox();
        assert.ok(railBack && railExpand && railBack.y + railBack.height <= railExpand.y, 'collapsed Back and Expand controls do not overlap');
        await snap('settings-collapsed-back');
        await rail.getByRole('button', { name: 'Expand sidebar to browse settings', exact: true }).click();
      }
      for (const section of ['messaging','account','general']) { await back(`#settings/${section}`); await page.locator('.access-settings__bar-title').getByText(section[0].toUpperCase()+section.slice(1),{exact:true}).waitFor(); }
      if (width === 390) await back('#settings');
      await back(chat);
      await page.locator('.composer__input').waitFor();
      if (width === 390) await forward('#settings');
      await forward('#settings/general'); await forward('#settings/account');
      await reload('#settings/account'); await page.getByRole('heading',{name:'Your account',exact:true}).waitFor();
      if (width === 390) {
        await page.getByRole('button',{name:'Back to Settings',exact:true}).click(); await hash('#settings');
        await reload('#settings'); await sections.waitFor();
        await page.getByRole('button',{name:'Back to chat',exact:true}).click();
      } else await page.locator('.settings-nav__back').click();
      await hash(chat);
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
      for (const tab of ['Team','Goals','Reports']) { await page.getByRole('navigation',{name:'Work sections'}).getByRole('button',{name:tab,exact:true}).click(); await hash(`#${tab.toLowerCase()}`); }
      await reload('#reports');
      for (const tab of ['goals','team','tasks']) await back(`#${tab}`);
      await back(width === 390 ? '#bots' : chat); await forward('#tasks');
      await page.locator('.tasks-view__header button').first().click(); await hash(width === 390 ? '#bots' : chat);
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
      for (const tab of ['Harness','Files','History']) { await page.getByRole('tablist',{name:'Agent configuration sections'}).getByRole('tab',{name:tab,exact:true}).click(); await hash(`${chat}/details/setup/${tab.toLowerCase()}`); }
      await reload(`${chat}/details/setup/history`);
      await page.getByRole('tab',{name:'History',exact:true}).waitFor();
      await back(`${chat}/details/setup/files`); await back(`${chat}/details/setup/harness`); await back(`${chat}/details/setup`);
      await detailTabs.getByRole('button',{name:'Activity',exact:true}).click();
      await page.getByRole('button',{name:'Bot settings',exact:true}).click(); await hash(`${chat}/settings/general`);
      for (const tab of ['Skills','Memories','Routines','Learning','Analytics']) { await page.getByRole('navigation',{name:'Bot settings sections'}).getByRole('button',{name:tab,exact:true}).click(); await hash(`${chat}/settings/${tab.toLowerCase()}`); }
      await reload(`${chat}/settings/analytics`);
      for (const tab of ['learning','routines','memories','skills','general']) await back(`${chat}/settings/${tab}`);
      await back(`${chat}/details/activity`); await page.locator('.details').waitFor();
      await page.getByRole('button',{name:'Close details',exact:true}).click(); await hash(chat);
      await reload(chat); await page.locator('.composer__input').waitFor();
      await page.goto(`${origin}/#bot/deleted/settings/general`); await hash('#bots');
      await page.goto(`${origin}/#new-bot/group`); await page.getByRole('button',{name:'Back to create a Bot',exact:true}).click(); await hash('#new-bot');
      await page.locator('.setup-paper__close').click(); await page.locator('.app').waitFor(); assert.equal(new URL(page.url()).origin, origin);
      await snap('safe-deep-link-back');
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
