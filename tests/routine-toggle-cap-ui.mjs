// QA SO D-02: routine cap rejection through the real API and UI, with isolated local data.
// Run: node tests/routine-toggle-cap-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-routine-toggle-cap-'));
const children = [], logs = [], unexpected = [];
let browser, db;
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
function start(args, env = {}) {
  // Inherit no provider credentials or database configuration from the workspace.
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
const apiPort = await port(), webPort = await port(), mockPort = await port();
const apiOrigin = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${webPort}`;
try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', '--input-type=module', '--eval', `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return originalFetch(input, init);
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
      if (url.hostname === 'telemetry.composio.dev') return Response.json({});
      console.error('UNEXPECTED_BACKEND_REQUEST', url.hostname);
      throw new Error('External backends are blocked in this test');
    };
    await import('./server/src/index.ts');
  `], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'routine-toggle-cap-test-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1',
    PORT: String(apiPort), APP_URL: origin, SERVER_URL: apiOrigin, LLM_PROVIDER: 'direct',
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    COMPOSIO_API_KEY: '', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['web/node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { SWARM_API: apiOrigin });
  await until(() => fetch(`${origin}/api/health`).then(response => response.ok, () => false), 'Local app did not start');
  const login = await fetch(`${origin}/api/auth/dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'routine-toggle-cap@example.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(url, method = 'GET', body) {
    const response = await fetch(`${origin}/api${url}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${method} ${url}`);
    return response.json();
  }
  const bot = (await api('/bots')).bots.find(item => item.isPrimary);
  await api(`/bots/${bot.id}`, 'PATCH', { name: 'Routine test Bot' });
  db = new Database(path.join(root, 'app.db'));
  const insert = db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)');
  // A yearly schedule avoids running any fixture during the test, even after a successful enable.
  for (let i = 1; i <= 11; i++) {
    insert.run(`rt_cap_${i}`, bot.id, `Routine ${i}`, 'Local test prompt', '0 0 1 1 *', 'UTC', i <= 10 ? 1 : 0, Date.now() + i);
  }
  const enabled = id => db.prepare('SELECT enabled FROM routines WHERE id=?').get(id).enabled;
  const activeCount = () => db.prepare('SELECT COUNT(*) n FROM routines WHERE bot_id=? AND enabled=1').get(bot.id).n;
  const out = new URL('../.context/routine-toggle-cap/', import.meta.url);
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'swarm_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await context.addInitScript(botId => localStorage.setItem('swarm.selectedBot', botId), bot.id);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(`External request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], categories: [], total: 0 } });
      if (url.pathname.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => unexpected.push(error.message));
    await page.goto(`${origin}/#bot/${bot.id}/settings/routines`);
    const target = page.getByRole('switch', { name: 'Routine 11 schedule on', exact: true });
    await target.waitFor();
    assert.equal(await target.getAttribute('aria-checked'), 'false');
    assert.equal(activeCount(), 10);
    async function toggle(control, id, status) {
      const pending = page.waitForResponse(response => response.url() === `${origin}/api/routines/${id}` && response.request().method() === 'PATCH');
      await control.click();
      const response = await pending;
      assert.equal(response.status(), status);
      return response.json();
    }
    const rejected = await toggle(target, 'rt_cap_11', 429);
    assert.match(rejected.error, /10 active routines \(the limit is 10\)/);
    const alert = page.getByRole('alert').filter({ hasText: rejected.error });
    await alert.waitFor();
    assert.equal(await alert.innerText(), rejected.error, 'Show the actionable API error');
    await until(async () => await target.getAttribute('aria-checked') === 'false', 'Rejected switch must revert to off');
    assert.equal(enabled('rt_cap_11'), 0);
    assert.equal(activeCount(), 10);
    assert.equal(await page.getByRole('status').filter({ hasText: 'Resumed' }).count(), 0, 'Rejection must not announce success');
    await page.screenshot({ path: new URL(`cap-${width}.png`, out).pathname });

    await page.reload();
    await target.waitFor();
    assert.equal(await target.getAttribute('aria-checked'), 'false', 'Rejected enable stays off after reload');
    // Free a slot and retry. Successful pause and resume still work without an error toast.
    const first = page.getByRole('switch', { name: 'Routine 1 schedule on', exact: true });
    await toggle(first, 'rt_cap_1', 200);
    await page.getByRole('status').filter({ hasText: 'Paused' }).waitFor();
    assert.equal(enabled('rt_cap_1'), 0);
    await toggle(target, 'rt_cap_11', 200);
    await page.getByRole('status').filter({ hasText: 'Resumed' }).waitFor();
    assert.equal(await target.getAttribute('aria-checked'), 'true');
    assert.equal(enabled('rt_cap_11'), 1);
    assert.equal(activeCount(), 10);
    assert.equal(await page.locator('.toast--error').count(), 0);
    // Restore the fixture through the API for the next viewport.
    await api('/routines/rt_cap_11', 'PATCH', { enabled: false });
    await api('/routines/rt_cap_1', 'PATCH', { enabled: true });
    await context.close();
    console.log(`PASS D-02 at ${width}: cap error alert, switch rollback, persisted state, pause and retry`);
  }
  assert.deepEqual(unexpected, [], 'No page errors or external browser requests');
  assert.doesNotMatch(logs.join(''), /UNEXPECTED_BACKEND_REQUEST/);
} catch (error) {
  console.error(logs.join('').slice(-6000));
  throw error;
} finally {
  await browser?.close();
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
  }));
  db?.close();
  await rm(root, { recursive: true, force: true });
}
