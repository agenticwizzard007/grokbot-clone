// Local Vite app, real DEV_LOGIN session in a temporary SQLite database, and mocked backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-sidebar-boot-'));
const children = [];
let logs = '', browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function start(args, env, cwd = new URL('..', import.meta.url)) {
  // Do not inherit provider credentials or an existing database from the workspace.
  const child = spawn(process.execPath, args, {
    cwd, env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error(logs);
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await delay(100);
  }
  throw new Error(`Local session test server did not start: ${logs}`);
}

try {
  const apiPort = await port(), mockPort = await port(), webPort = await port();
  const backend = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${webPort}`;
  start(['tests/mock-provider.mjs', String(mockPort)], {});
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'session-boot-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
    PORT: String(apiPort), APP_URL: origin, SERVER_URL: backend,
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`, COMPOSIO_API_KEY: '',
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    { SWARM_API: backend }, new URL('../web', import.meta.url));
  await ready(`${backend}/api/health`);
  await ready(origin);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const unexpected = [];
    let held;
    page.on('pageerror', error => unexpected.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.theme', 'light');
      window.footerLabels = [];
      const record = () => {
        for (const footer of document.querySelectorAll('.sidebar-usage')) {
          window.footerLabels.push(footer.getAttribute('aria-label'));
        }
      };
      new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
      if (url.origin !== origin) { unexpected.push('External request attempted'); return route.abort(); }
      if (!endpoint.startsWith('/api/')) return route.continue();
      if (endpoint === '/api/auth/me' && request.method() === 'GET') return route.continue();
      if (endpoint === '/api/models') { held = route; return; }
      if (endpoint === '/api/auth/me' && request.method() === 'PATCH') return route.continue();
      if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${endpoint}`); return route.abort(); }
      // Models, toolkits and the signed-in shell use synthetic responses only.
      const fixtures = {
        '/api/bots': { bots: [], live: [] },
        '/api/computer': { computer: { provider: 'local', status: 'absent', screens: [] } },
        '/api/apps': { apps: [], connected: [], categories: [], total: 0 },
        '/api/settings': { settings: {}, computer: { provider: 'local' } },
        '/api/needs-you': { items: [] },
        '/api/tasks': { tasks: [] },
        '/api/voice/options': { voices: [], languages: [], speeds: [], configured: false },
        '/api/checkins/reports': { reports: [], nextCursor: null, hasMore: false },
        '/api/team/exchanges': { exchanges: [], nextBefore: null },
      };
      if (!(endpoint in fixtures)) unexpected.push(`Unexpected API ${endpoint}`);
      return route.fulfill({ json: fixtures[endpoint] ?? {} });
    });

    await page.goto(origin);
    await page.getByRole('heading', { name: 'Welcome to Swarm' }).waitFor();
    const login = await page.request.post(`${backend}/api/auth/dev`, { data: { email: `session-${width}@example.test`, name: 'Session QA' } });
    assert.equal(login.status(), 200);
    await page.reload();
    await page.locator('.app').waitFor();

    const footer = page.locator('.sidebar-usage');
    await footer.waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('.sidebar-usage')?.getAttribute('aria-label')?.includes('Loading usage...'));
    // An empty account keeps the catalog idle until a consumer requests it.
    await page.evaluate(async () => {
      const { useModels } = await import('/src/lib/models.ts');
      void useModels.getState().load();
    });
    for (let attempt = 0; !held && attempt < 100; attempt++) await delay(20);
    assert.ok(held, 'catalog request is held during normal boot');
    assert.match(await footer.getAttribute('aria-label'), /Loading usage/);
    await held.fulfill({ json: { provider: 'direct', billing: 'api', models: [], favourites: [], canFast: false } });
    await page.waitForFunction(() => document.querySelector('.sidebar-usage')?.getAttribute('aria-label')?.includes('API credits'));
    const labels = await page.evaluate(() => window.footerLabels);
    assert.ok(labels.length > 0);
    assert.ok(labels.some(label => label.includes('Loading usage...')));
    assert.ok(labels.some(label => label.includes('API credits')));
    assert.ok(labels.every(label => !/Check connection|Checking connection|unavailable/i.test(label)), 'first paint through ready stays neutral');

    // Exercise idle explicitly so an effect starting the fetch cannot hide a first-render regression.
    for (const status of ['idle', 'loading', 'error', 'ready']) {
      await page.evaluate(async status => {
        const { useModels } = await import('/src/lib/models.ts');
        useModels.setState({ status, provider: null, billing: null, error: status === 'error' ? 'Fixture failure' : null });
      }, status);
      const expected = status === 'idle' || status === 'loading' ? 'Loading usage...' : 'Check connection';
      await page.waitForFunction(expected => document.querySelector('.sidebar-usage')?.getAttribute('aria-label')?.includes(expected), expected);
    }
    // A completed response with a provider but no billing is also unknown.
    await page.evaluate(async () => {
      const { useModels } = await import('/src/lib/models.ts');
      useModels.setState({ status: 'ready', provider: 'direct', billing: null });
    });
    assert.match(await footer.getAttribute('aria-label'), /Check connection/);
    assert.deepEqual(unexpected, [], 'no page errors, live requests, or unexpected API calls');
    await page.close();
  }
  console.log('PASS T-footer: neutral first paint through ready and completed failure states at 390, 768, 1280px.');
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  })));
  await rm(root, { recursive: true, force: true });
}
