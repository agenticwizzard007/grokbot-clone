// Browser -> authenticated HTTP -> real PTY -> fake official CLI. No live auth.
// Run after npm run build -w web: node tests/cli-login-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { useAccessViteAssets } from './access-vite-assets.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cli-login-ui-'));
const screenshots = path.resolve('.context/cli-login-ui');
await fs.mkdir(screenshots, { recursive: true });
const auditFile = path.join(temp, 'codes.jsonl');
const executable = path.join(temp, 'fake-cli.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => {
  const reserve = http.createServer().listen(0, '127.0.0.1', () => {
    const value = reserve.address().port;
    reserve.close(() => resolve(value));
  });
});
const port = await freePort(), modelPort = await freePort();
const base = `http://localhost:${port}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
let server, model, browser, page, logs = '';
const errors = [];
await fs.writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const args = process.argv.slice(2);
const provider = ['login','exec','app-server'].includes(args[0]) ? 'codex' : 'claude';
const marker = path.join(process.env.HOME, provider + '-fake-auth');
const status = args[0] === 'login' && args[1] === 'status' || args[0] === 'auth' && args[1] === 'status';
if (status) {
  const auth = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  if (provider === 'codex') console.error(auth === 'subscription' ? 'Logged in using ChatGPT' : 'Not logged in');
  else console.log(JSON.stringify({ loggedIn: auth === 'subscription', authMethod: 'claude.ai', subscriptionType: auth === 'subscription' ? 'max' : null }));
  process.exit(auth === 'subscription' ? 0 : 1);
}
if (args[0] === 'login' || args[0] === 'auth' && args[1] === 'login') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(87);
  // Match provider login prompts that deliberately disable terminal echo.
  process.stdin.setRawMode(true);
  console.log('Open https://' + (provider === 'claude' ? 'claude.com' : 'auth.openai.com') + '/fake-sign-in');
  console.log('Paste code here if prompted >');
  let buffer = '';
  process.stdin.on('data', data => {
    buffer += data.toString();
    const end = buffer.search(/[\\r\\n]/);
    if (end < 0) return;
    const code = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ provider, code }) + '\\n');
    setTimeout(() => {
      if (code === 'NOAUTH') { fs.rmSync(marker, { force: true }); process.exit(0); }
      if (code !== provider + '-fake-code#verified') process.exit(7);
      fs.writeFileSync(marker, 'subscription', { mode: 0o600 });
      console.log('Login successful.'); process.exit(0);
    }, 600);
  });
} else {
  // The full app refreshes the selected subscription's model catalog on success.
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line), method = request.method ?? request.request?.subtype;
    const codex = args[0] === 'app-server';
    const result = method === 'initialize' ? (codex ? {} : { account: { subscriptionType: 'max' }, models: [{ value: 'fake-model', displayName: 'Fake model' }] })
      : method === 'account/read' ? { account: { type: 'chatgpt', planType: 'pro' } }
      : method === 'model/list' ? { data: [{ model: 'fake-model', displayName: 'Fake model', isDefault: true, inputModalities: ['text'] }], nextCursor: null }
      : {};
    console.log(JSON.stringify(codex ? { id: request.id, result } : { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: result } }));
  }
}
`, { mode: 0o700 });

async function until(check) {
  for (let n = 0; n < 150; n++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out waiting for fake CLI login UI.');
}

try {
  model = spawn(process.execPath, ['tests/mock-provider.mjs', String(modelPort)], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  await until(() => fetch(`${modelBase}/v1/models`).then(response => response.ok, () => false));
  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', PORT: String(port), SERVER_URL: base, APP_URL: base,
      DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
      SESSION_SECRET: 'offline-cli-login-browser-fixture', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1',
      MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', SWARM_CLI_CODEX_PATH: executable, SWARM_CLI_CLAUDE_PATH: executable,
      DIRECT_API_KEY: 'mock-key', LLM_PROVIDER: 'direct', OPENROUTER_API_KEY: '', XAI_API_KEY: '', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', INKBOX_API_KEY: '', INKBOX_ADMIN_API_KEY: '',
      DIRECT_BASE_URL: `${modelBase}/v1`, OPENROUTER_BASE_URL: `${modelBase}/api/v1`,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  await until(() => fetch(`${base}/api/health`).then(response => response.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await useAccessViteAssets(context, base);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
    if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } });
    if (url.pathname === '/api/apps/connections') return route.fulfill({ json: { connections: [] } });
    return route.fallback();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  let accountId;
  const loginCalls = [], writes = [], resetBodies = [], botLoads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/bots') botLoads.push(url.pathname);
    if (!url.pathname.startsWith('/api/cli')) return;
    assert.ok(url.searchParams.get('expectedUserId'), 'CLI calls carry the displayed account');
    if (url.pathname === '/api/cli/reset' && request.method() === 'POST') resetBodies.push(request.postDataJSON());
    if (url.pathname === '/api/cli/login' && request.method() === 'POST') loginCalls.push(request.postDataJSON());
    if (/\/login\/[^/]+\/input$/.test(url.pathname)) writes.push(request.postDataJSON().data);
  });
  const terminal = page.getByRole('region', { name: /login terminal$/ });
  const recovery = page.getByRole('region', { name: 'Continue connection', exact: true });
  const assertNoSignIn = async () => {
    assert.equal(await page.getByRole('region', { name: /Confirm it.s you/ }).count(), 0);
    assert.equal(await page.locator('input[type="tel"], input[type="email"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Continue with phone|Continue with OpenRouter|Sign in with (Apple|Google)/ }).count(), 0);
    assert.equal(await page.locator('.subscription-settings a[href*="/api/auth/"]').count(), 0);
  };
  const fixture = async label => {
    assert.equal((await context.request.post(`${base}/api/auth/dev`, { data: { email: `cli-${label}@example.test` } })).status(), 200);
    accountId = (await (await context.request.get(`${base}/api/auth/me`)).json()).user.id;
    const db = new Database(path.join(temp, 'app.db'));
    const age = Date.now() - 2 * 3600_000;
    db.prepare('UPDATE auth_sessions SET created_at=?,authenticated_at=? WHERE user_id=?').run(age, age, accountId);
    db.close();
  };
  const resumeAt = (provider, action = 'login', expiresAt = Date.now() + 600_000) => page.evaluate(target => sessionStorage.setItem('swarm.resume', JSON.stringify(target)), { section: 'subscriptions', provider, accountId, action, expiresAt });
  const cancelTerminal = () => terminal.getByRole('button', { name: 'Cancel login and close terminal', exact: true }).click();
  const readyTerminal = () => until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());

  for (const width of [1280, 390]) {
    await fixture(`connect-${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    await page.getByRole('button', { name: 'Account & settings', exact: true }).waitFor();
    await page.keyboard.press('Control+,');
    await page.locator('.app-settings').waitFor();
    const sections = page.getByRole('navigation', { name: 'Settings sections', exact: true });
    if (!await sections.isVisible()) await page.getByRole('button', { name: 'Back to Settings', exact: true }).click();
    await sections.getByRole('button', { name: 'Models & access', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose how models are billed', exact: true }).waitFor();
    for (const provider of ['claude', 'codex']) {
      const name = provider === 'claude' ? 'Claude Code' : 'Codex';
      await page.getByRole('tab', { name, exact: true }).click();
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/cli/login' && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
      assert.equal((await response).status(), 200, 'two-hour-old session reaches the real login endpoint');
      const field = terminal.getByLabel('Authorization code', { exact: true });
      await readyTerminal();
      await assertNoSignIn();
      assert.equal(await recovery.count(), 0);
      assert.equal(await terminal.getByRole('button', { name: `Connect ${name}`, exact: true }).isDisabled(), true);
      const code = `${provider}-fake-code#verified`;
      await page.evaluate(value => navigator.clipboard.writeText(value), `  ${code}  `);
      await field.click(); await page.keyboard.press('Control+V');
      await until(async () => (await field.inputValue()).trim() === code);
      assert.equal(await field.getAttribute('type'), 'password');
      await terminal.getByRole('button', { name: 'Show code', exact: true }).click();
      assert.equal(await field.getAttribute('type'), 'text');
      await terminal.screenshot({ path: path.join(screenshots, `${provider}-${width}-connect.png`) });
      await terminal.getByRole('button', { name: 'Hide code', exact: true }).click();
      assert.equal(await field.getAttribute('type'), 'password');
      if (provider === 'claude') await terminal.getByRole('button', { name: `Connect ${name}`, exact: true }).click();
      else await field.press('Enter');
      await terminal.getByText(`Code sent. Waiting for ${name} to finish signing in…`, { exact: true }).waitFor();
      assert.equal(await terminal.getByRole('heading', { name: `${name} connected`, exact: true }).count(), 0);
      await terminal.getByRole('heading', { name: `${name} connected`, exact: true }).waitFor();
      assert.equal(await field.count(), 0);
      assert.equal(await terminal.locator('.cli-login-terminal__screen').isVisible(), false);
      await terminal.getByRole('button', { name: 'View login details', exact: true }).click();
      assert.equal(await terminal.locator('.cli-login-terminal__screen').isVisible(), true);
      await terminal.getByRole('button', { name: 'Hide login details', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await terminal.getByRole('button', { name: 'Done', exact: true }).click();
      const status = await (await context.request.get(`${base}/api/cli`)).json();
      assert.equal(status.selected, provider);
      assert.equal(status.providers[provider].subscription, true);
    }
    await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
    await page.getByText(/Connection reset\. Both CLIs are signed out/).waitFor();
    await assertNoSignIn();
    const reset = await (await context.request.get(`${base}/api/cli`)).json();
    assert.equal(reset.selected, 'codex');
    assert.equal(reset.providers.claude.authenticated, false);
    assert.equal(reset.providers.codex.authenticated, false);
  }
  assert.deepEqual(writes, Array(2).fill(['claude-fake-code#verified\r', 'codex-fake-code#verified\r']).flat());
  const received = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(received, Array(2).fill([{ provider: 'claude', code: 'claude-fake-code#verified' }, { provider: 'codex', code: 'codex-fake-code#verified' }]).flat());

  await fixture('recovery');
  await page.goto(`${base}/#settings/subscriptions`);
  // A return from authentication automatically starts the intended provider, once.
  for (const [provider, callback] of [['claude', '/'], ['codex', '/?openrouter=connected#settings/keys']]) {
    await resumeAt(provider);
    const before = loginCalls.length;
    await page.goto(`${base}${callback}`);
    await readyTerminal();
    assert.equal(loginCalls.length, before + 1);
    assert.equal(loginCalls.at(-1).provider, provider);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('swarm.resume')), null);
    await assertNoSignIn();
    await cancelTerminal();
  }
  // Denied callbacks never auto-start. One Continue returns to connect with the valid session.
  for (const callback of ['?login=google_denied', '?openrouter=openrouter_denied#settings/keys']) {
    await resumeAt('codex');
    const before = loginCalls.length;
    await page.goto(`${base}/${callback}`);
    await recovery.getByText('Sign-in did not complete. Try again to continue.', { exact: true }).waitFor();
    assert.equal(loginCalls.length, before);
    await assertNoSignIn();
    await recovery.getByRole('button', { name: 'Continue connection', exact: true }).click();
    await readyTerminal();
    assert.equal(loginCalls.length, before + 1);
    await cancelTerminal();
  }
  // A successful CLI exit without subscription proof still fails.
  await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
  await readyTerminal();
  await terminal.getByLabel('Authorization code', { exact: true }).fill('NOAUTH');
  await terminal.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await terminal.getByText(/could not verify a subscription login/).waitFor();
  assert.equal(await terminal.getByRole('heading', { name: 'Codex connected', exact: true }).count(), 0);
  await terminal.getByRole('button', { name: 'Close login terminal', exact: true }).click();

  const loginRoute = url => url.origin === base && url.pathname === '/api/cli/login';
  await page.route(loginRoute, route => route.fulfill({ status: 403, json: { error: 'Connection request denied.' } }));
  await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
  await terminal.getByText(/Connection request denied\./).waitFor();
  assert.equal(await recovery.count(), 0, '403 is not mistaken for a session failure');
  await assertNoSignIn();
  await terminal.getByRole('button', { name: 'Close login terminal', exact: true }).click();
  await page.unroute(loginRoute);

  await page.route(loginRoute, route => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }));
  await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
  await recovery.waitFor();
  await assertNoSignIn();
  await page.unroute(loginRoute);
  await recovery.getByRole('button', { name: 'Continue connection', exact: true }).click();
  await readyTerminal();
  await cancelTerminal();

  // A terminal-triggered status read begun before reset must not overwrite its result.
  // Use a fresh fixture identity to retain the real per-account login rate limit.
  await fixture('stale-status');
  await page.goto(`${base}/?fixture=stale-status#settings/subscriptions`);
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  await terminal.getByLabel('Authorization code', { exact: true }).fill('codex-fake-code#verified');
  await terminal.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await terminal.getByRole('button', { name: 'Done', exact: true }).click();
  const readySnapshot = await (await context.request.get(`${base}/api/cli`)).json();
  let releaseStatus, observedStatus;
  const heldStatus = new Promise(resolve => { releaseStatus = resolve; });
  const statusStarted = new Promise(resolve => { observedStatus = resolve; });
  let holdStatus = false;
  const cliStatusRoute = url => url.origin === base && url.pathname === '/api/cli';
  await page.route(cliStatusRoute, async route => {
    if (holdStatus && route.request().method() === 'GET') {
      holdStatus = false; observedStatus(); await heldStatus;
      await route.fulfill({ json: readySnapshot }).catch(() => {});
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Log in again', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  holdStatus = true;
  await terminal.getByLabel('Authorization code', { exact: true }).fill('NOAUTH');
  await terminal.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await statusStarted;
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await page.getByText(/Connection reset\. Both CLIs are signed out/).waitFor();
  releaseStatus();
  await pause(200);
  assert.equal(await page.getByRole('button', { name: 'Log in again', exact: true }).count(), 0, 'an older ready snapshot cannot revive the reset connection');
  await page.unroute(cliStatusRoute);

  // A late auth denial can arrive after real reset effects. Reconcile instead of promising no change.
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  await terminal.getByLabel('Authorization code', { exact: true }).fill('unsent-late-reset');
  const cliResetRoute = url => url.origin === base && url.pathname === '/api/cli/reset';
  await page.route(cliResetRoute, async route => {
    const applied = await route.fetch();
    assert.equal(applied.status(), 200, 'the real server first stops the terminal and clears the profile');
    await route.fulfill({ status: 401, json: { error: 'unauthenticated' } });
  });
  const resetCount = resetBodies.length;
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await recovery.getByText(/Reset may already have stopped login sessions or removed saved connections/).waitFor();
  // Polling can observe cancellation before retirement, or a missing retired session.
  await terminal.getByText(/^(Failed|Cancelled)$/).waitFor();
  assert.equal(await terminal.getByLabel('Authorization code', { exact: true }).count(), 0);
  await page.locator('.cfg-row__sub').getByText('ChatGPT via Codex · Blocked', { exact: true }).waitFor();
  assert.equal(await page.getByText(/This request has not been applied|Your current terminal stays open/).count(), 0);
  assert.equal(resetBodies.length, resetCount + 1, 'late denial must not replay reset automatically');
  assert.equal((await (await context.request.get(`${base}/api/cli`)).json()).providers.codex.authenticated, false);
  await page.unroute(cliResetRoute);
  await recovery.getByRole('button', { name: 'Not now', exact: true }).click();
  await terminal.getByRole('button', { name: 'Close login terminal', exact: true }).click();

  // Genuine expiry still needs authentication. Preserve the destination through the redirect.
  await fixture('expired');
  await page.goto(`${base}/#settings/subscriptions`);
  await resumeAt('claude');
  const expired = new Database(path.join(temp, 'app.db'));
  expired.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run(Date.now() - 1, accountId);
  expired.close();
  await page.reload();
  await page.getByRole('heading', { name: 'Welcome to Swarm', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => sessionStorage.getItem('swarm.resume')));
  await context.request.post(`${base}/api/auth/dev`, { data: { email: 'cli-expired@example.test' } });
  await page.goto(`${base}/`);
  await readyTerminal();
  assert.equal(loginCalls.at(-1).provider, 'claude');
  await assertNoSignIn();
  await cancelTerminal();

  // Switching accounts never resumes a login for the previous identity.
  await resumeAt('codex');
  const previousAccount = accountId;
  await fixture('other');
  const switchedReset = page.waitForResponse(response => new URL(response.url()).pathname === '/api/cli/reset' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  assert.equal((await switchedReset).status(), 409);
  assert.equal(resetBodies.at(-1).expectedUserId, previousAccount);
  await page.getByText(/Your account changed\. Reload this page/).waitFor();
  const before = loginCalls.length;
  const loadsBefore = botLoads.length;
  await page.goto(`${base}/?fixture=other-account`);
  await page.getByText(/belongs to another account/).waitFor();
  assert.equal(loginCalls.length, before);
  assert.ok(botLoads.length > loadsBefore, 'the new account loads its own shell state');
  assert.notEqual(accountId, previousAccount);
  await resumeAt('codex', 'login', Date.now() - 1);
  await page.goto(`${base}/?fixture=expired-resume`);
  await page.getByRole('button', { name: 'Account & settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Choose how models are billed', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('CLI login UI passed: aged sessions, both providers at 390 and 1280, clipboard and PTY input, verified subscription success, reset, session recovery, automatic resume and account isolation.');
} catch (error) {
  console.error(logs.slice(-4000));
  if (errors.length) console.error('Browser errors:', errors);
  if (page) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }); }
  throw error;
} finally {
  await browser?.close();
  model?.kill('SIGTERM');
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const force = setTimeout(() => server.kill('SIGKILL'), 5000);
      server.once('exit', () => { clearTimeout(force); resolve(); });
    });
  }
  await fs.rm(temp, { recursive: true, force: true });
}
