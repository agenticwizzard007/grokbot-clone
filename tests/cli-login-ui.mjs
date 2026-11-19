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

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cli-login-ui-'));
const screenshots = path.resolve('.context/cli-login-ui');
await fs.mkdir(screenshots, { recursive: true });
const auditFile = path.join(temp, 'codes.jsonl');
const executable = path.join(temp, 'fake-cli.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise(resolve => {
  const reserve = http.createServer().listen(0, '127.0.0.1', () => {
    const value = reserve.address().port;
    reserve.close(() => resolve(value));
  });
});
const base = `http://localhost:${port}`;
let server, browser, page, logs = '';
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
  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, NODE_ENV: 'test', SWARM_ROLE: 'standalone', PORT: String(port), SERVER_URL: base, APP_URL: base,
      DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
      SESSION_SECRET: 'offline-cli-login-browser-fixture', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1',
      MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', SWARM_CLI_CODEX_PATH: executable, SWARM_CLI_CLAUDE_PATH: executable,
      DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', INKBOX_API_KEY: '', INKBOX_ADMIN_API_KEY: '',
      DIRECT_BASE_URL: 'http://127.0.0.1:1/v1', OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  await until(() => fetch(`${base}/api/health`).then(response => response.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  assert.equal((await context.request.post(`${base}/api/auth/dev`, { data: { email: 'cli-login-ui@example.test' } })).status(), 200);
  let accountId = (await (await context.request.get(`${base}/api/auth/me`)).json()).user.id;
  page = await context.newPage();
  const resumeAt = async (provider, action = 'login', expiresAt = Date.now() + 600_000) => page.evaluate(target => sessionStorage.setItem('swarm.resume', JSON.stringify(target)), { section: 'subscriptions', provider, accountId, action, expiresAt });
  const errors = [], writes = [], deletes = [], resetBodies = [], botLoads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/cli\/login\/[^/]+\/input$/.test(new URL(request.url()).pathname)) writes.push(request.postDataJSON().data); });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' && pathname.startsWith('/api/cli/login/')) deletes.push(pathname);
    if (request.method() === 'POST' && pathname === '/api/cli/reset') resetBodies.push(request.postDataJSON());
    if (pathname === '/api/bots') botLoads.push(pathname);
  });
  await page.goto(`${base}/#settings/subscriptions`);
  const terminal = page.getByRole('region', { name: /login terminal$/ });

  for (const provider of ['claude', 'codex']) {
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    if (provider === 'codex') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const field = terminal.getByLabel('Authorization code', { exact: true });
    const submit = terminal.getByRole('button', { name: `Connect ${name}`, exact: true });
    await until(() => field.isEnabled());
    assert.equal(await submit.isDisabled(), true);
    const code = `${provider}-fake-code#verified`;
    await page.evaluate(value => navigator.clipboard.writeText(value), `  ${code}  `);
    await field.click();
    await page.keyboard.press('Control+V');
    await until(async () => (await field.inputValue()).trim() === code);
    assert.equal(await field.getAttribute('type'), 'password');
    await terminal.getByRole('button', { name: 'Show code', exact: true }).click();
    assert.equal(await field.getAttribute('type'), 'text');
    assert.equal((await field.inputValue()).trim(), code, 'pasted code is inspectable even though CLI echo is disabled');
    await terminal.screenshot({ path: path.join(screenshots, `${provider}-code-visible.png`) });
    await terminal.getByRole('button', { name: 'Hide code', exact: true }).click();
    assert.equal(await field.getAttribute('type'), 'password');
    if (provider === 'claude') await submit.click();
    else await field.press('Enter');
    await terminal.getByText(`Code sent. Waiting for ${name} to finish signing in…`, { exact: true }).waitFor();
    assert.equal(await terminal.getByRole('heading', { name: `${name} connected`, exact: true }).count(), 0, 'sending a code alone must not show success');
    await terminal.getByRole('heading', { name: `${name} connected`, exact: true }).waitFor();
    assert.equal(await field.count(), 0, 'authorization code entry disappears once verified');
    assert.equal(await terminal.locator('.cli-login-terminal__screen').isVisible(), false, 'completed terminal collapses into a clear success state');
    assert.equal(await terminal.getByText(/subscription is verified and selected for all your Bots/).isVisible(), true);
    const status = await (await context.request.get(`${base}/api/cli`)).json();
    assert.equal(status.selected, provider);
    assert.equal(status.providers[provider].subscription, true);
    await terminal.screenshot({ path: path.join(screenshots, `${provider}-connected.png`) });
    await terminal.getByRole('button', { name: 'View login details', exact: true }).click();
    assert.equal(await terminal.locator('.cli-login-terminal__screen').isVisible(), true);
    await terminal.getByRole('button', { name: 'Hide login details', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await terminal.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await terminal.count(), 0);
  }

  // A CLI exiting successfully without real subscription auth must still fail.
  await page.getByRole('button', { name: 'Log in again', exact: true }).click();
  const field = terminal.getByLabel('Authorization code', { exact: true });
  await until(() => field.isEnabled());
  await field.fill('NOAUTH');
  await terminal.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await terminal.getByText(/could not verify a subscription login/).waitFor();
  assert.equal(await terminal.getByRole('heading', { name: 'Codex connected', exact: true }).count(), 0);
  assert.equal(await terminal.getByRole('button', { name: 'Done', exact: true }).count(), 0);
  await terminal.getByRole('button', { name: 'Close login terminal', exact: true }).click();
  assert.deepEqual(writes, ['claude-fake-code#verified\r', 'codex-fake-code#verified\r', 'NOAUTH\r'], 'each button/Enter submission sends exactly one trimmed code and Enter');
  const received = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(received, [{ provider: 'claude', code: 'claude-fake-code#verified' }, { provider: 'codex', code: 'codex-fake-code#verified' }, { provider: 'codex', code: 'NOAUTH' }]);

  // Credential changes need a sign-in from the last 10 minutes. An aged session must get a way to
  // sign in again in place instead of an empty failed terminal.
  const db = new Database(path.join(temp, 'app.db'));
  db.prepare('UPDATE auth_sessions SET authenticated_at=?').run(Date.now() - 11 * 60_000);
  db.close();
  // The unverified login above signed Codex out, so the primary action reads Login again.
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const reauth = page.getByRole('region', { name: 'Confirm it’s you', exact: true });
  await reauth.waitFor();
  assert.equal(await terminal.count(), 0, 'no dead terminal while a fresh sign-in is required');
  assert.equal(await page.getByText(/Close this terminal and try Login again/).count(), 0);
  await reauth.screenshot({ path: path.join(screenshots, 'reauth-prompt.png') });
  await page.reload();
  await reauth.waitFor();
  assert.equal(await page.getByText(/You’re signed in again/).count(), 0, 'navigation alone does not prove fresh authentication');
  await page.goto(`${base}/?login=google_denied`);
  await reauth.getByText('Sign-in did not complete. Try again to continue.', { exact: true }).waitFor();
  assert.equal(await page.getByText(/You’re signed in again/).count(), 0, 'provider denial does not become a success notice');
  await page.goto(`${base}/?openrouter=openrouter_denied#settings/keys`);
  await reauth.getByText('Sign-in did not complete. Try again to continue.', { exact: true }).waitFor();
  assert.equal(await page.getByText(/You’re signed in again/).count(), 0, 'OpenRouter denial resumes a retry, not the keys page or a success notice');
  assert.equal(await reauth.getByLabel('Dev sign-in email', { exact: true }).inputValue(), 'cli-login-ui@example.test');
  await reauth.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await page.getByText(/You’re signed in again\. Choose Login to continue connecting ChatGPT via Codex/).waitFor();
  assert.equal(await reauth.count(), 0);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  assert.equal(await page.getByText(/signed in again/).count(), 0, 'the notice clears once a login starts');
  await terminal.getByRole('button', { name: 'Cancel login and close terminal', exact: true }).click();
  assert.equal(await terminal.count(), 0);

  // Provider sign-ins leave the page; a planned resume reopens Subscriptions on the same tab.
  await resumeAt('claude');
  await page.goto(`${base}/`);
  await page.getByText(/You’re signed in again\. Choose Login to continue connecting Claude via Claude Code/).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Claude Code', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('swarm.resume')), null, 'a resume target is consumed once');

  // Use the exact successful OpenRouter callback URL, which supplies its own keys deep link.
  await resumeAt('codex');
  await page.goto(`${base}/?openrouter=connected#settings/keys`);
  await page.getByText(/You’re signed in again\. Choose Login to continue connecting ChatGPT via Codex/).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Codex', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('swarm.resume')), null, 'the callback consumes its resume target once');

  // An ordinary keys deep link still wins over a pending resume, and a callback without a resume stays on keys.
  await resumeAt('claude');
  await page.goto(`${base}/#settings/keys`);
  await page.getByRole('heading', { name: 'API keys', exact: true, level: 1 }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Claude Code', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('swarm.resume')), null);
  await page.goto(`${base}/?openrouter=connected#settings/keys`);
  await page.getByRole('heading', { name: 'API keys', exact: true, level: 1 }).waitFor();
  assert.equal(await page.getByText(/signed in again/).count(), 0, 'a callback without a resume does not invent a reauthentication notice');
  await page.goto(`${base}/#settings/subscriptions`);
  await page.reload();
  await page.getByRole('tab', { name: 'Claude Code', exact: true }).waitFor();
  assert.equal(await page.getByText(/signed in again/).count(), 0, 'a later visit does not repeat the notice');

  // Reset starts over for both providers and leaves the page ready to log in again.
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByText(/removes the saved Claude Code and Codex logins/).waitFor();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await page.getByText(/Connection reset\. Both CLIs are signed out/).waitFor();
  const afterReset = await (await context.request.get(`${base}/api/cli`)).json();
  assert.equal(afterReset.selected, 'codex', 'reset keeps the selection blocked rather than enabling API billing');
  assert.equal(afterReset.providers.claude.authenticated, false);
  assert.equal(afterReset.providers.codex.authenticated, false);
  await page.screenshot({ path: path.join(screenshots, 'after-reset.png'), fullPage: false });
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  assert.equal(await page.getByText(/Connection reset/).count(), 0, 'the reset notice clears once a login starts');
  await terminal.getByRole('button', { name: 'Cancel login and close terminal', exact: true }).click();
  // A denied reset leaves the active terminal and its unsent authorization code intact.
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await until(() => terminal.getByLabel('Authorization code', { exact: true }).isEnabled());
  await terminal.getByLabel('Authorization code', { exact: true }).fill('unsent-code');
  const age = new Database(path.join(temp, 'app.db'));
  age.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now() - 11 * 60_000, accountId);
  const deletesBefore = deletes.length;
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await reauth.waitFor();
  assert.equal(await terminal.count(), 1);
  assert.equal(await terminal.getByLabel('Authorization code', { exact: true }).inputValue(), 'unsent-code');
  assert.equal(deletes.length, deletesBefore, 'step-up rejection must not issue terminal DELETE');
  assert.equal(await page.getByRole('button', { name: 'Reset connection', exact: true }).isDisabled(), true, 'credential actions are gated during reauthentication');
  await reauth.getByText(/choose Reset connection again/).waitFor();
  await reauth.getByRole('button', { name: 'Not now', exact: true }).click();
  age.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now(), accountId);
  age.close();
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await page.getByText(/Connection reset\. Both CLIs are signed out/).waitFor();
  assert.equal(await terminal.count(), 0, 'successful reset closes the active terminal');

  // A terminal-triggered status read begun before reset must not overwrite its result.
  // Use a fresh fixture identity to retain the real per-account login rate limit.
  await context.request.post(`${base}/api/auth/dev`, { data: { email: 'cli-login-stale@example.test' } });
  accountId = (await (await context.request.get(`${base}/api/auth/me`)).json()).user.id;
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
  await page.route(`${base}/api/cli`, async route => {
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
  await page.unroute(`${base}/api/cli`);

  // The cookie can change in another tab while this view still displays the initiating account.
  await context.request.post(`${base}/api/auth/dev`, { data: { email: 'cli-login-other@example.test' } });
  const resetResponse = page.waitForResponse(response => response.url() === `${base}/api/cli/reset` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Reset connection', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  assert.equal((await resetResponse).status(), 409);
  assert.equal(resetBodies.at(-1).expectedUserId, accountId, 'confirmation is bound to the displayed account');
  await page.getByText(/Your account changed\. Reload this page/).waitFor();
  await resumeAt('codex');
  const botsBefore = botLoads.length;
  await page.goto(`${base}/?fixture=other-account`);
  await page.getByText(/belongs to another account/).waitFor();
  assert.equal(await page.getByText(/You’re signed in again/).count(), 0);
  assert.ok(botLoads.length > botsBefore, 'a new account loads its own shell state');
  const otherId = (await (await context.request.get(`${base}/api/auth/me`)).json()).user.id;
  const otherDb = new Database(path.join(temp, 'app.db'));
  otherDb.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE user_id=?').run(Date.now() - 11 * 60_000, otherId);
  otherDb.close();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await reauth.waitFor();
  await reauth.getByLabel('Dev sign-in email', { exact: true }).fill('cli-login-stale@example.test');
  const beforeDevReload = botLoads.length;
  await reauth.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await page.getByText(/belongs to another account/).waitFor();
  assert.equal(await page.getByText(/You’re signed in again/).count(), 0, 'switching accounts is not same-account reauthentication');
  assert.ok(botLoads.length > beforeDevReload, 'dev reauthentication reloads the account-scoped shell');
  await resumeAt('codex', 'login', Date.now() - 1);
  await page.goto(`${base}/?fixture=expired-resume`);
  assert.equal(await page.getByRole('heading', { name: 'Subscriptions', exact: true, level: 1 }).count(), 0, 'expired resume targets are discarded');
  assert.deepEqual(errors, []);
  console.log('CLI login UI passed: real clipboard paste, show/hide code, button/Enter submission, real PTY with echo disabled, verified success/Done, desktop/mobile, rejection of unverified login, in-place re-sign-in, resume after a sign-in round trip, and reset of both providers.');
} catch (error) {
  console.error(logs.slice(-4000));
  if (page) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }); }
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const force = setTimeout(() => server.kill('SIGKILL'), 5000);
      server.once('exit', () => { clearTimeout(force); resolve(); });
    });
  }
  await fs.rm(temp, { recursive: true, force: true });
}
