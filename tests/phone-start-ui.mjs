// Local Vite app with DEV_LOGIN=1, a temporary SQLite database, and mocked backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-phone-start-'));
const evidence = new URL('../.context/phone-start/', import.meta.url);
await mkdir(evidence, { recursive: true });
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
  throw new Error(`Local phone test server did not start: ${logs}`);
}

try {
  const apiPort = await port(), mockPort = await port(), webPort = await port();
  const backend = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${webPort}`;
  start(['tests/mock-provider.mjs', String(mockPort)], {});
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'phone-start-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
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

  const line = {
    number: '+15550000100', connectCommand: 'connect @swarm',
    smsLink: 'sms:+15550000100?&body=connect%20%40swarm',
    whatsapp: { messageLink: 'https://wa.me/15550000300?text=Hi%20Swarm' },
  };
  const unavailable = 'Phone sign-in is temporarily unavailable. Try again later or use another sign-in method.';
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const errors = [];
    let response = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push('External request attempted'); return route.abort(); }
      if (url.pathname === '/api/auth/phone/start' && response) return route.fulfill(response);
      if (url.pathname === '/api/models') return route.fulfill({ json: { models: [], favourites: [] } });
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], categories: [], total: 0 } });
      return route.continue();
    });
    await page.goto(origin);
    const phone = page.getByRole('textbox', { name: 'Phone number', exact: true });
    const begin = page.getByRole('button', { name: 'Continue with phone', exact: true });
    const code = page.getByRole('textbox', { name: '6-digit code', exact: true });
    const alert = page.getByRole('alert');
    await phone.fill('+15550000200');
    await begin.click();
    await alert.filter({ hasText: unavailable }).waitFor();
    assert.equal(await code.count(), 0, 'the real unconfigured server does not open the code form');
    assert.equal(await begin.isEnabled(), true);
    await page.screenshot({ path: new URL(`${width}-unavailable.png`, evidence).pathname });

    response = { json: { id: 'legacy-platform-attempt', line } };
    await begin.click();
    await alert.filter({ hasText: unavailable }).waitFor();
    assert.equal(await code.count(), 0, 'the old platform response cannot open a code form');

    response = { json: { id: 'first-contact', delivery: 'text-first', textNumber: null, line } };
    await begin.click();
    await code.waitFor();
    await page.getByText('Connect to get your code.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open Messages', exact: true }).getAttribute('href'), line.smsLink);
    assert.equal(await page.getByRole('link', { name: 'Open WhatsApp', exact: true }).getAttribute('href'), line.whatsapp.messageLink);
    assert.match(await page.locator('.phone-auth__help').innerText(), /connect @swarm/);
    assert.match(await page.locator('.phone-auth__help').innerText(), /reply “hi” there/);
    await page.screenshot({ path: new URL(`${width}-first-contact.png`, evidence).pathname });

    await page.getByRole('button', { name: 'Use a different number' }).click();
    response = { json: { id: 'connected', delivery: 'text-first', textNumber: '+15550000400', line: null } };
    await begin.click();
    await code.waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open Messages', exact: true }).getAttribute('href'), 'sms:+15550000400?&body=hi');
    assert.match(await page.locator('.phone-auth__help').innerText(), /Text Swarm first/);

    await page.getByRole('button', { name: 'Use a different number' }).click();
    response = { json: { id: 'delivered', delivery: 'sent', textNumber: null, line: null } };
    await begin.click();
    await code.waitFor();
    await page.getByText('Your code is on its way to your phone.', { exact: false }).waitFor();
    response = { status: 503, json: { error: unavailable } };
    await page.getByRole('button', { name: 'Send it again', exact: true }).click();
    await alert.filter({ hasText: unavailable }).waitFor();
    assert.equal(await code.count(), 0, 'an unsuccessful resend returns to the retryable phone form');
    assert.equal(await begin.isEnabled(), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS P-04: unavailable messaging, incomplete contract, first contact, direct thread, confirmed send and failed resend on the local dev app.');
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  })));
  await rm(root, { recursive: true, force: true });
}
