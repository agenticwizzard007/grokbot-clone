// DEV_LOGIN, temporary SQLite, local model server and mocked Composio/realtime only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-voice-ui-'));
const evidence = path.join(root, '.context/stop-voice'); await fs.mkdir(evidence, { recursive: true });
async function freePort() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SESSION_SECRET: 'stop-voice-fixture', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, COMPOSIO_API_KEY: 'fixture',
};
const children = [], logs = []; let browser;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); return child; }
async function until(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timed out: ${label}`); }
try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  start(['--import', 'tsx', 'tests/fixtures/stop-voice-server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API');
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite');
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', permissions: ['microphone'], serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `fixture-${width}@example.test`, name: 'QA account' } }); assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    const { bot } = await (await context.request.post(`${base}/api/bots`, { data: { name: 'Fixture Bot' } })).json();
    const db = new Database(env.DB_PATH);
    db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id);
    db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run(user.id, 'GMAIL_FETCH_EMAILS'); db.close();
    const page = await context.newPage(), errors = [], stops = [];
    let voiceMode = 'success', voiceAttempt = 0;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().endsWith('/interrupt')) stops.push(r.url()); });
    page.setDefaultTimeout(20000);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push('Unexpected external browser request'); return route.abort(); }
      if (url.pathname === '/api/voice/session') return route.fulfill({ json: { callId: `fixture-${++voiceAttempt}`, clientSecret: 'fixture', websocketUrl: `ws://127.0.0.1:${uiPort}/mock-realtime`, sampleRate: 24000, session: {} } });
      if (url.pathname === '/api/voice/updates') return route.fulfill({ json: { cursor: 0, updates: [], tasks: [] } });
      if (url.pathname === '/api/voice/end') return route.fulfill({ json: { ok: true } });
      return route.continue();
    });
    await page.routeWebSocket('**/mock-realtime', ws => ws.onMessage(data => {
      if (voiceMode === 'success' && JSON.parse(data).type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    }));
    await page.addInitScript(id => {
      localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', 'light');
      const Original = window.EventSource; window.fixtureEvents = [];
      window.EventSource = class extends Original { constructor(...args) { super(...args); window.fixtureEvents.push(this); } };
    }, bot.id);
    await page.goto(base);
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    const composer = page.locator('.composer__input'); await composer.waitFor();
    const script = scenario => `mock: SWARM_APPS_EXECUTE ${JSON.stringify({ connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { scenario } })} | say Local fixture read completed.`;
    await composer.fill(script('slow')); await composer.press('Enter');
    await page.locator('.step.is-running').waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      const source = window.fixtureEvents.at(-1); source.close(); source.onerror?.(new Event('error'));
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await page.locator('.bubble').getByText('Local fixture read completed.', { exact: true }).waitFor();
    assert.equal(stops.length, 0); assert.equal(await page.getByText('Stopped.', { exact: true }).count(), 0);
    await composer.fill(script('failed')); await composer.press('Enter');
    const notice = page.locator('.notice.is-error').last(); await notice.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.match(await notice.innerText(), /Gmail.*failed/); assert.equal(await page.locator('.first-response').count(), 0);
    await page.screenshot({ path: path.join(evidence, `chat-error-${width}.png`), fullPage: true });
    await notice.getByRole('button', { name: 'Retry', exact: true }).click();
    await until(async () => await page.locator('.notice.is-error').count() === 2, 'retry completes with visible error');
    assert.equal(stops.length, 0);
    await page.getByRole('button', { name: 'Start live voice with Fixture Bot', exact: true }).click();
    const call = page.getByRole('region', { name: 'Voice call with Fixture Bot' });
    await call.locator('.vcall__time').waitFor(); assert.match(await call.innerText(), /Listening/);
    await page.screenshot({ path: path.join(evidence, `voice-live-${width}.png`), fullPage: true });
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    voiceMode = 'timeout';
    await page.getByRole('button', { name: 'Start live voice with Fixture Bot', exact: true }).click();
    await call.getByText('Connecting…', { exact: true }).waitFor();
    await call.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.match(await call.innerText(), /timed out.*voice connection/);
    assert.equal(await call.getByText('Connecting…', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidence, `voice-timeout-${width}.png`), fullPage: true });
    voiceMode = 'success'; await call.getByRole('button', { name: 'Retry', exact: true }).click(); await call.locator('.vcall__time').waitFor();
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(`S-01/S-02 passed at ${width}px: slow tool, hidden page, SSE reconnect, failure/retry, voice success/timeout/retry`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-12000)); throw e; }
finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  await fs.rm(temp, { recursive: true, force: true });
}
