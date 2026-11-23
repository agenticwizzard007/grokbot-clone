// Run: node tests/connected-account-details-ui.mjs
// Local Vite, real API/auth, temporary SQLite, DEV_LOGIN=1 and mocked providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-details-ui-'));
const evidence = path.join(root, '.context/connected-account-details');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser, db;
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
const apiPort = await port(), uiPort = await port(), apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'details-ui-test-only',
  DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'mock-details-only',
  DIRECT_API_KEY: 'mock-model-only', DIRECT_BASE_URL: 'http://model.invalid/v1', LLM_PROVIDER: 'direct',
  SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, SWARM_API: apiBase };
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
async function ready(url) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await fetch(url).then(r => r.ok, () => false)) return;
    assert.ok(children.every(child => child.exitCode === null), 'Fixture process exited');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local server startup timed out');
}
try {
  start(['--import', 'tsx', 'tests/fixtures/connected-account-details.server.mts']);
  await ready(`${apiBase}/api/health`); db = new Database(env.DB_PATH);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await ready(base);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const errors = [], mutations = [];
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== base) return route.abort();
      if (url.pathname.startsWith('/api/apps') && req.method() !== 'GET') {
        mutations.push(`${req.method()} ${url.pathname}`); return route.abort();
      }
      return route.continue();
    });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `details-${width}@example.test`, name: 'Test account' } });
    assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    const createdAt = '2026-11-21T09:30:00.000Z';
    const fixture = (suffix, extra = {}) => ({ id: `ca_${width}_${suffix}`, toolkit: { slug: 'gmail' }, status: 'ACTIVE', createdAt, ...extra });
    const accounts = [fixture('first', { data: { email: 'name@gmail.com' } }), fixture('second'),
      fixture('fallback_long_identifier', { toolkit: { slug: 'github' } }),
      fixture('expired', { status: 'EXPIRED', data: { email: 'expired@gmail.com' } }),
      fixture('failed', { status: 'FAILED', data: { email: 'failed@gmail.com' } }),
      fixture('long', { toolkit: { slug: 'github' }, data: { email: `${'long'.repeat(28)}@example.test` } })];
    for (const account of accounts) db.prepare('INSERT INTO fixture_accounts VALUES (?,?,?)').run(account.id, user.id, JSON.stringify(account));
    const bots = (await (await context.request.get(`${base}/api/bots`)).json()).bots;
    const bot = bots.find(b => b.isPrimary);
    const botRow = db.prepare('SELECT generation FROM bots WHERE id=?').get(bot.id);
    const body = { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'Read mail for the requested task.', status: 'connected', connectedAccountId: accounts[0].id };
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(bot.id, botRow.generation, 100, 100, 'card', JSON.stringify(body), Date.now());
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(async () => !!(await import('/src/store.ts')).useStore.getState().user);
    const open = section => page.evaluate(async section => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings(section), section);
    await open('apps');
    const settings = page.locator('.access-apps-settings');
    const active = settings.getByRole('region', { name: 'Your connected accounts', exact: true });
    await active.getByText('name@gmail.com', { exact: true }).waitFor();
    await active.getByText('profile@gmail.com', { exact: true }).waitFor();
    assert.equal(await active.locator('.connected-account-details').count(), 4);
    const firstRow = active.locator('.cfg-row').filter({ hasText: 'name@gmail.com' });
    assert.match(await firstRow.innerText(), /Gmail/);
    assert.match(await firstRow.innerText(), /Active/);
    assert.match(await firstRow.innerText(), /Connected 21 Nov 2026/);
    const fallback = active.locator(`[data-account-id="${accounts[2].id}"]`);
    assert.ok((await fallback.innerText()).includes(`Connected account ${accounts[2].id.slice(0, 9)}...`));
    await settings.getByText('Expired connections (1)', { exact: true }).click();
    const expired = settings.getByRole('region', { name: 'Expired connections', exact: true }).locator(`[data-account-id="${accounts[3].id}"]`);
    assert.match(await expired.innerText(), /expired@gmail.com\s+Needs reauth\s+Connected 21 Nov 2026/);
    assert.match(await settings.getByRole('region', { name: 'Other connections', exact: true }).locator(`[data-account-id="${accounts[4].id}"]`).innerText(), /failed@gmail.com\s+Failed\s+Connected 21 Nov 2026/);

    // All visible detail labels wrap within their text column and avoid actions and badges.
    const checkLayout = async scope => {
      const failures = await scope.evaluate(element => {
        const bad = [];
        for (const details of element.querySelectorAll('.connected-account-details')) {
          const box = details.getBoundingClientRect(), label = details.querySelector('.connected-account-details__label');
          const row = details.closest('.cfg-row, .app-row, .connect-card');
          if (box.x < 0 || box.right > innerWidth + 1 || label.scrollWidth > label.clientWidth + 1) bad.push('Overflow: ' + label.textContent);
          const name = row?.querySelector('.cfg-row__title, .app-row__name, .card__title')?.getBoundingClientRect();
          if (name && box.y < name.bottom - 1) bad.push('Label overlaps app name');
          for (const action of row?.querySelectorAll('button, .app-row__status, .cfg-chip') ?? []) {
            const a = action.getBoundingClientRect();
            if (Math.min(box.right, a.right) - Math.max(box.x, a.x) > 1 && Math.min(box.bottom, a.bottom) - Math.max(box.y, a.y) > 1) bad.push('Details overlap action or badge');
          }
        }
        return bad;
      });
      assert.deepEqual(failures, []);
    };
    await checkLayout(settings);
    await page.screenshot({ path: path.join(evidence, `settings-${width}.png`), fullPage: true });
    await settings.getByRole('button', { name: 'Manage apps', exact: true }).click();
    const [catalogResponse] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps'),page.getByRole('button', { name: '2 connected', exact: true }).click()]);
    await catalogResponse.finished();
    await page.getByRole('heading', { name: 'Connected', exact: true }).waitFor();
    const catalog = page.locator('.access-apps-catalog');
    await catalog.getByText('name@gmail.com', { exact: true }).waitFor();
    const gmailCard = catalog.locator('.app-row').filter({ has: page.getByText('Gmail', { exact: true }) });
    assert.equal(await gmailCard.locator('.connected-account-details').count(), 4);
    assert.match(await gmailCard.innerText(), /name@gmail.com/); assert.match(await gmailCard.innerText(), /profile@gmail.com/);
    await checkLayout(catalog);
    await gmailCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `catalog-${width}.png`), fullPage: true });
    await open('messaging');
    const messaging = page.locator('.access-messaging__account');
    await messaging.getByText('name@gmail.com', { exact: true }).waitFor();
    await messaging.getByText('profile@gmail.com', { exact: true }).waitFor();
    await checkLayout(messaging);
    // The same catalog is opened from chat and Bot connector entry points.
    await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().closeAppSettings());
    await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().setModal('apps'));
    const [modalResponse] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps'),page.locator('.apps-modal').getByRole('button', { name: '2 connected', exact: true }).click()]);
    await modalResponse.finished();
    await page.locator('.apps-modal').getByRole('heading', { name: 'Connected', exact: true }).waitFor();
    await page.locator('.apps-modal').getByText('name@gmail.com', { exact: true }).waitFor();
    await checkLayout(page.locator('.apps-modal'));
    await page.locator('.apps-modal').getByRole('button', { name: 'Close', exact: true }).click();
    // A legacy resolved chat card loads details for its bound account.
    await page.evaluate(async botId => (await import('/src/store.ts')).useStore.getState().selectBot(botId), bot.id);
    const chatCard = page.locator('.connect-card').filter({ hasText: 'name@gmail.com' });
    await chatCard.waitFor(); await checkLayout(chatCard);
    await page.screenshot({ path: path.join(evidence, `chat-${width}.png`), fullPage: true });
    assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: Gmail email and profile fallback, account fallback, statuses, dates, multiple accounts, long identifiers, Settings, catalog, messaging and chat; no overlap or mutations`);
    await context.close();
  }
} catch (error) {
  console.error(logs.join('').slice(-3000));
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); db?.close();
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exitCode !== null ? null : once(child, 'exit')));
  fs.rmSync(temp, { recursive: true, force: true });
}
