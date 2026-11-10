// Browser → real Swarm routes → mock OpenRouter. No real credentials or credits.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-openrouter-ui-'));
const screenshots = path.resolve('.context/openrouter');
await fs.mkdir(screenshots, { recursive: true });
const keys = new Set(), codes = new Map();
const customKey = `sk-or-v1-${'b'.repeat(64)}`;
keys.add(customKey);
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/v1/auth/keys') {
    const code = codes.get(body.code); codes.delete(body.code);
    if (!code || code.challenge !== crypto.createHash('sha256').update(body.code_verifier).digest('base64url')) return json(403, { error: 'Invalid verifier' });
    const key = `sk-or-v1-${crypto.randomBytes(32).toString('hex')}`; keys.add(key);
    return json(200, { key, user_id: 'openrouter-browser-user' });
  }
  if (req.url === '/v1/key') return keys.has(req.headers.authorization?.replace('Bearer ', '')) ? json(200, { data: { label: 'Browser test', is_management_key: false } }) : json(401, { error: 'Invalid key' });
  if (req.url === '/v1/models') return json(200, { data: ['test/default', 'test/alternate'].map(id => ({ id, name: id === 'test/alternate' ? 'Alternate model' : 'Default model', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0', completion: '0' } })) });
  return json(404, { error: 'Unexpected request' });
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const reserve = http.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = `http://localhost:${port}`;
let logs = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(port), SERVER_URL: base, APP_URL: base, DB_PATH: path.join(temp, 'db.sqlite'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'browser-test-only', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', XAI_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: 'test/default', OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, SWARM_NO_SCHEDULER: '1', DEV_LOGIN: '1', INKBOX_TUNNEL: '0', INKBOX_ADMIN_API_KEY: '', INKBOX_API_KEY: '', APPLE_SERVICE_ID: '', APPLE_IOS_CLIENT_ID: '', APPLE_MACOS_CLIENT_ID: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
let browser, page;
async function until(fn) {
  for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for Swarm.');
}
try {
  await until(() => fetch(`${base}/api/health`).then(r => r.ok).catch(() => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Intercept the initial navigation: Chromium follows HTTP redirects within
  // the same intercepted request, so matching only the external URL is insufficient.
  await context.route(`${base}/api/auth/openrouter/start**`, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    assert.equal(response.status(), 302);
    const url = new URL(response.headers().location);
    assert.equal(url.origin, 'https://openrouter.ai');
    const code = crypto.randomBytes(24).toString('hex');
    codes.set(code, { challenge: url.searchParams.get('code_challenge') });
    const callback = new URL(url.searchParams.get('callback_url'));
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', code);
    await route.fulfill({ response, status: 302, headers: { ...response.headers(), location: callback.href } });
  });
  page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('link', { name: 'Continue with OpenRouter' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'signin-desktop.png') });
  await page.getByRole('link', { name: 'Continue with OpenRouter' }).click();
  await page.getByText('OpenRouter · Active', { exact: true }).waitFor();
  const first = (await (await context.request.get(`${base}/api/auth/me`)).json()).user;
  assert.ok(first.id);
  assert.equal((await (await context.request.get(`${base}/api/settings/models`)).json()).provider, 'openrouter');
  await page.getByRole('button', { name: 'Your OpenRouter default model', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Alternate model' }).click();
  await page.getByText('Default model saved for your Bots.', { exact: true }).waitFor();
  assert.equal((await (await context.request.get(`${base}/api/providers/openrouter`)).json()).model, 'test/alternate');
  await page.getByLabel('Or paste your API key').fill('bad-key');
  await page.getByRole('button', { name: 'Save & verify key', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'OpenRouter rejected this key' }).waitFor();
  assert.equal(await page.getByLabel('Or paste your API key').inputValue(), '');
  await page.getByLabel('Or paste your API key').fill(customKey);
  await page.getByRole('button', { name: 'Save & verify key', exact: true }).click();
  await page.getByText('Key verified and saved.', { exact: true }).waitFor();
  assert.ok(!(await page.content()).includes(customKey));
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes(customKey));
  await page.locator('.app-settings__main').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app-settings__main').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Disconnect key', exact: true }).click();
  await page.getByRole('button', { name: 'Remove my key', exact: true }).click();
  await page.getByText('OpenRouter · Reconnect to continue', { exact: true }).waitFor();
  let status = await (await context.request.get(`${base}/api/providers/openrouter`)).json();
  assert.equal(status.connected, false); assert.equal(status.linked, true); assert.equal(status.active, true);
  await page.getByRole('link', { name: 'Connect OpenRouter', exact: true }).click();
  await page.getByText('OpenRouter · Active', { exact: true }).waitFor();
  assert.equal((await (await context.request.get(`${base}/api/auth/me`)).json()).user.id, first.id);
  await context.request.post(`${base}/api/auth/logout`);
  await page.goto(base);
  await page.getByRole('link', { name: 'Continue with OpenRouter' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'signin-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('link', { name: 'Continue with OpenRouter' }).click();
  await page.getByText('OpenRouter · Active', { exact: true }).waitFor();
  assert.equal((await (await context.request.get(`${base}/api/auth/me`)).json()).user.id, first.id);
  assert.deepEqual(errors, []);
  // A non-owner has an independent connection and can paste a key without OAuth.
  const bob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await bob.request.post(`${base}/api/auth/dev`, { data: { email: 'bob@example.test' } });
  const bobPage = await bob.newPage(); await bobPage.goto(`${base}/#settings/keys`);
  await bobPage.getByLabel('Or paste your API key').fill(customKey);
  await bobPage.getByRole('button', { name: 'Save & verify key', exact: true }).click();
  await bobPage.getByText('Key verified and saved.', { exact: true }).waitFor();
  status = await (await bob.request.get(`${base}/api/providers/openrouter`)).json();
  assert.equal(status.connected, true); assert.equal(status.linked, false); assert.equal(status.active, true);
  console.log('OpenRouter browser checks passed: signup, repeat login, linking, manual keys, model selection, disconnect, non-owner access, desktop/mobile layouts.');
} catch (e) {
  console.error(logs.slice(-4000));
  if (page) { console.error('Browser URL:', page.url()); console.error((await page.locator('body').innerText()).slice(0, 3000)); await page.screenshot({ path: path.join(screenshots, 'failure.png') }); }
  throw e;
} finally {
  await browser?.close(); child.kill('SIGTERM');
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
