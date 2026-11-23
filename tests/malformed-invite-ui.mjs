// QA SO A-05: malformed invite URLs, temporary SQLite, mocked providers and toolkits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-malformed-invite-ui-'));
const screenshots = '.context/malformed-invite-errors';
fs.mkdirSync(screenshots, { recursive: true });
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
function start(args, env = {}) {
  // Only pass local fixture configuration, never workspace provider credentials.
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out waiting for invite fixture');
}

const apiPort = await port(), mockPort = await port(), webPort = await port();
const backend = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${webPort}`;
try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'malformed-invite-fixture-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(apiPort),
    APP_URL: base, SERVER_URL: backend, DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['web/node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { SWARM_API: backend });
  await until(() => fetch(`${backend}/api/health`).then(response => response.ok, () => false));
  await until(() => fetch(base).then(response => response.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route('**/api/apps?*', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } }));
    // Vite rejects malformed URL escapes before its SPA fallback. Serve its dev
    // entry document at /join/* so the browser exercises App with the original URL.
    await context.route(`${base}/join/**`, async route => {
      const response = await context.request.get(base);
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], inviteRequests = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/join/')) inviteRequests.push(request.url());
      if (request.method() === 'POST') mutations.push(request.url());
    });
    const db = new Database(path.join(root, 'app.db'), { readonly: true });
    const usersBefore = db.prepare('SELECT count(*) AS count FROM users').get().count;
    for (const segment of ['%', '%2', '%GG', '%E0%A4%A', '%FF', '%ED%A0%80']) {
      await page.goto(`${base}/join/${segment}`);
      await page.getByRole('heading', { name: 'This invite can’t be used', exact: true }).waitFor();
      assert.ok(await page.getByText('This invite link is invalid. Ask for a new invitation.', { exact: true }).isVisible());
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
      assert.ok(await page.getByRole('link', { name: 'Sign in', exact: true }).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    }
    assert.deepEqual(inviteRequests, [], 'malformed codes must not reach the invite API');
    assert.deepEqual(mutations, [], 'malformed links cannot claim invites or create accounts');
    assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, usersBefore);
    db.close();
    await page.screenshot({ path: `${screenshots}/malformed-${width}.png` });
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).waitFor();

    // A correctly encoded code is decoded once and still reaches the existing invite API.
    let validLookups = 0;
    await context.route('**/api/join/fixture%25code', route => {
      validLookups++;
      return route.fulfill({ json: { valid: true, line: { number: '+15555550123' } } });
    });
    await page.goto(`${base}/join/fixture%25code`);
    await page.getByRole('heading', { name: 'You’re invited to Swarm', exact: true }).waitFor();
    assert.ok(await page.getByLabel('Phone number', { exact: true }).isVisible());
    assert.ok(validLookups >= 1, 'valid encoding reaches the invite lookup');
    await page.goto(`${base}/join/nonexistent-fixture`);
    await page.getByRole('heading', { name: 'This invite can’t be used', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS A-05 at ${width}: malformed encoding, no account creation, recovery link, valid encoding and unknown invite.`);
  }
} catch (error) {
  console.error(logs.join('').slice(-4000));
  throw error;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
