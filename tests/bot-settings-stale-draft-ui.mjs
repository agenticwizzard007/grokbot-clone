// QA SO D-04: real General forms and API, temporary SQLite, local model and toolkit mocks.
// Run: node tests/bot-settings-stale-draft-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-stale-settings-'));
const children = [], logs = [], unexpected = [];
let browser;
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
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'stale-settings-test-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1',
    PORT: String(apiPort), APP_URL: origin, SERVER_URL: apiOrigin, LLM_PROVIDER: 'direct',
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    COMPOSIO_API_KEY: '', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['web/node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { SWARM_API: apiOrigin });
  await until(() => fetch(`${origin}/api/health`).then(response => response.ok, () => false), 'Local app did not start');
  const login = await fetch(`${origin}/api/auth/dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stale-settings@example.test' }),
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
  const savedBot = async () => (await api('/bots')).bots.find(item => item.id === bot.id);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const liveEvents of [true, false]) {
    await api(`/bots/${bot.id}`, 'PATCH', { name: 'Settings test Bot', instructions: '', label: '' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'swarm_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await context.addInitScript(({ botId, liveEvents }) => {
      localStorage.setItem('swarm.selectedBot', botId);
      if (!liveEvents) window.EventSource = class { static CLOSED = 2; close() {} };
    }, { botId: bot.id, liveEvents });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(`External request: ${url.origin}`); return route.abort(); }
      // Toolkit discovery and suggestions are deterministic and never reach a real integration.
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], categories: [], total: 0 } });
      if (url.pathname.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      return route.continue();
    });
    const tabA = await context.newPage(), tabB = await context.newPage();
    for (const page of [tabA, tabB]) {
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => unexpected.push(error.message));
      await page.goto(`${origin}/#bot/${bot.id}/settings/general`);
      await page.locator('#cfg-name').waitFor();
    }
    const instructions = page => page.locator('#cfg-instructions');
    const saveButton = page => page.getByRole('button', { name: 'Save changes', exact: true });
    async function save(page, status = 200) {
      const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/bots/${bot.id}` && response.request().method() === 'PATCH');
      await saveButton(page).click();
      const response = await responsePromise;
      assert.equal(response.status(), status);
      await page.locator('.cfg-savebar__note').filter({ hasText: status === 200 ? 'Saved' : 'Instructions changed elsewhere' }).waitFor();
      await saveButton(page).waitFor();
      return response.request().postDataJSON();
    }
    async function waitForRemote(page, text) {
      if (!liveEvents) return;
      await until(() => page.evaluate(async ({ botId, text }) => {
        const { useStore } = await import('/src/store.ts');
        return useStore.getState().bots.find(item => item.id === botId)?.instructions === text;
      }, { botId: bot.id, text }), 'The other tab did not receive the updated Bot');
    }

    // A name draft survives a remote instructions save and a settings section switch.
    await tabA.locator('#cfg-name').fill('Renamed test Bot');
    await instructions(tabB).fill('New instructions from the second tab');
    const firstSave = await save(tabB);
    await waitForRemote(tabA, 'New instructions from the second tab');
    await tabA.getByRole('navigation', { name: 'Bot settings sections' }).getByRole('button', { name: 'Skills', exact: true }).click();
    await tabA.getByRole('navigation', { name: 'Bot settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
    const rename = await save(tabA);
    assert.deepEqual(rename, { name: 'Renamed test Bot' }, 'Untouched stale instructions must not enter the PATCH');
    assert.equal((await savedBot()).instructions, 'New instructions from the second tab');
    assert.equal((await savedBot()).name, 'Renamed test Bot');
    assert.deepEqual(firstSave, { instructions: 'New instructions from the second tab', expectedInstructions: '' }, 'Even an empty original value must be guarded');
    assert.equal(await saveButton(tabA).isDisabled(), true);

    // Both tabs edit instructions. The stale mixed patch must fail atomically, even with missed events.
    await instructions(tabA).fill('Stale local instructions');
    await tabA.locator('#cfg-label').fill('Unsaved local label');
    await instructions(tabB).fill('Latest saved instructions');
    await save(tabB);
    await waitForRemote(tabA, 'Latest saved instructions');
    const conflict = await save(tabA, 409);
    assert.deepEqual(conflict, { label: 'Unsaved local label', instructions: 'Stale local instructions', expectedInstructions: 'New instructions from the second tab' });
    assert.equal((await savedBot()).instructions, 'Latest saved instructions');
    assert.equal((await savedBot()).label, '', 'A conflict must not partly apply other fields');
    assert.equal(await instructions(tabA).inputValue(), 'Stale local instructions', 'Conflict preserves the local draft');
    assert.equal(await tabA.locator('#cfg-label').inputValue(), 'Unsaved local label');
    assert.equal(await saveButton(tabA).isEnabled(), true);

    // Conflict refreshes saved data without replacing the draft. Discard then starts from the latest text.
    await tabA.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await instructions(tabA).inputValue(), 'Latest saved instructions');
    await instructions(tabA).fill('Reviewed instructions');
    assert.deepEqual(await save(tabA), { instructions: 'Reviewed instructions', expectedInstructions: 'Latest saved instructions' });
    assert.equal((await savedBot()).instructions, 'Reviewed instructions');

    // Editing and reverting a value is clean, even if a remote update arrives during the draft.
    await tabA.locator('#cfg-name').fill('Temporary name');
    await api(`/bots/${bot.id}`, 'PATCH', { instructions: 'Another remote update' });
    await waitForRemote(tabA, 'Another remote update');
    await instructions(tabA).fill('Temporary instructions');
    await instructions(tabA).fill('Reviewed instructions');
    await tabA.locator('#cfg-name').fill('Renamed test Bot');
    assert.equal(await saveButton(tabA).isDisabled(), true, 'Reverted edits must not become dirty from live updates');
    await tabA.locator('#cfg-label').fill('Safe label');
    assert.deepEqual(await save(tabA), { label: 'Safe label' });
    assert.equal((await savedBot()).instructions, 'Another remote update');

    // Clearing instructions is an intentional edit and still sends the exact original text.
    await instructions(tabA).fill('');
    assert.deepEqual(await save(tabA), { instructions: '', expectedInstructions: 'Another remote update' });
    assert.equal((await savedBot()).instructions, '');
    await context.close();
    console.log(`PASS D-04 with ${liveEvents ? 'live' : 'missed'} Bot events: unrelated edits, empty baseline, atomic conflict, retained draft, recovery and reverted edits`);
  }
  assert.deepEqual(unexpected, [], 'No page errors or external browser requests');
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
  await rm(root, { recursive: true, force: true });
}
