// QA SO L-01: real activation and work with a temporary database and mocked backends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-setup-'));
const evidence = path.join(root, '.context/skip-setup');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const apiPort = await port(), uiPort = await port(), modelPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Exclude inherited credentials and deployment settings. No computer is connected.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'skip-setup-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${modelBase}/v1`, LLM_PROVIDER: 'direct',
  OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `${modelBase}/api/v1`,
  COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', SWARM_API: apiBase,
};
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
const healthy = url => fetch(url).then(response => response.ok, () => false);

try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  await until(() => healthy(`${modelBase}/v1/models`), 'mock model');
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => healthy(`${apiBase}/api/health`), 'isolated API');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => healthy(base), 'local dev frontend');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) for (const dropEvents of width === 1280 ? [false, true] : [false]) {
    const label = `${width}${dropEvents ? '-missed-events' : ''}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    await context.route('**/api/bots/*/suggested-apps', route => route.fulfill({ json: { suggestions: [], status: 'ready' } }));
    await context.route('**/api/apps**', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], connections: [], categories: [] } }));
    await context.route('**/api/toolkits/**', route => route.fulfill({ json: { items: [] } }));
    if (dropEvents) await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        set onmessage(handler) {
          super.onmessage = event => {
            // The successful HTTP response must refresh an already open Setup and Harness.
            if (['setup', 'bot'].includes(JSON.parse(event.data).type)) return;
            handler?.call(this, event);
          };
        }
      };
    });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `skip-${label}@example.test` } });
    assert.equal(login.status(), 200);
    const api = async (url, method = 'GET', data) => {
      const response = await context.request.fetch(`${base}/api${url}`, { method, data });
      assert.ok(response.ok(), `${method} ${url}: ${response.status()}`);
      return response.json();
    };
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const create = page.getByRole('main', { name: 'Create a Bot', exact: true });
    await create.getByRole('textbox', { name: 'Bot name' }).fill(`Skip Bot ${label}`);
    const creation = page.waitForResponse(response => response.url().endsWith('/api/bots') && response.request().method() === 'POST');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    const { bot } = await (await creation).json();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const openSetup = async () => {
      if (!await details.isVisible()) await page.getByRole('button', { name: 'Show details', exact: true }).click();
      await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Setup', exact: true }).click();
    };
    const openPreview = async () => {
      await details.getByRole('tab', { name: 'Harness', exact: true }).click();
      const disclosure = details.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Preview assembled instructions' }) });
      if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    };
    await openSetup();
    await openPreview();
    await details.getByText(/Setup consultant instructions/).waitFor();
    if (width <= 1100) await details.getByRole('button', { name: 'Close details', exact: true }).click();

    const skipped = page.waitForResponse(response => response.url().endsWith(`/bots/${bot.id}/setup/skip`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Skip setup', exact: true }).click();
    const response = await skipped;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).bot.onboarding.status, 'active');
    await page.getByRole('button', { name: 'Skip setup', exact: true }).waitFor({ state: 'detached' });
    if (width <= 1100) { await openSetup(); await openPreview(); }
    await details.getByText(/Active configuration · Revision/).waitFor();
    await details.getByText(/Active Bot instructions/).waitFor();
    assert.equal(await details.getByText(/Setup consultant instructions/).count(), 0);
    await page.screenshot({ path: path.join(evidence, `${label}-harness.png`), fullPage: true });
    await details.getByRole('tab', { name: 'Responsibilities', exact: true }).click();
    assert.equal(await details.getByRole('region', { name: 'Setup status', exact: true }).count(), 0);
    assert.equal(await details.getByText('Preparation pending. Work waits for readiness.', { exact: true }).count(), 0);
    await details.getByText('You can work in chat. Computer actions need a ready computer.', { exact: true }).waitFor();
    await details.getByRole('region', { name: 'Computer preparation', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${label}-setup.png`), fullPage: true });

    const setup = await api(`/bots/${bot.id}/setup`);
    assert.equal(setup.onboarding.status, 'active');
    assert.deepEqual(setup.onboarding.missing, []);
    assert.ok(setup.manifest.brief.workflows.length > 0);
    assert.match(setup.manifest.brief.action_boundaries, /Ask before sending messages/);
    assert.equal(setup.computer.status, 'pending', 'activation must not pretend an offline computer is ready');

    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    // list_routines is an operational tool forbidden during setup. Its real result proves execution.
    await page.getByRole('textbox', { name: `Message ${bot.name}`, exact: true }).fill('Check my scheduled routines. mock: list_routines {} | say Routines checked: {last}');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('paragraph').filter({ hasText: /^Routines checked: \[\]$/ }).waitFor();
    const { rows } = await api(`/bots/${bot.id}/rows`);
    const tool = rows.find(row => row.body.name === 'list_routines');
    assert.equal(tool?.body.status, 'done', 'the operational tool runs after Skip setup');
    const requests = await (await fetch(`${modelBase}/_requests`)).json();
    const request = requests.at(-1).body;
    assert.match(request.input[0].content, /list_routines/, 'the operational tool is advertised in the tool catalog');
    assert.ok(!request.tools.some(tool => tool.name === 'save_agent_setup'));
    assert.doesNotMatch(request.input[0].content, /You are the setup consultant/);

    await page.reload();
    if (width <= 760) await page.locator('.bot-row').filter({ has: page.getByText(bot.name, { exact: true }) }).click();
    await openSetup();
    await details.getByText(/Active configuration · Revision/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Skip setup', exact: true }).count(), 0);
    assert.equal(await details.getByText('Preparation pending. Work waits for readiness.', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS QA SO L-01 ${label}: activation, current Setup/Harness, operational work, reload`);
  }
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages()).at(-1);
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
