// DEV_LOGIN, temporary SQLite, a local slow Responses API and blocked vendor traffic only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-credits-ui-'));
const evidence = path.join(root, '.context/api-credits'); await fs.mkdir(evidence, { recursive: true });
async function freePort() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SESSION_SECRET: 'stop-voice-fixture', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'fixture', OPENROUTER_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, COMPOSIO_API_KEY: 'fixture',
};
const children = [], logs = []; let browser;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); return child; }
async function until(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timed out: ${label}`); }
try {
  start(['tests/fixtures/credits-provider.mjs', String(modelPort)]);
  start(['--import', 'tsx', 'tests/fixtures/stop-voice-server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API');
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite');
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `credits-${width}@example.test`, name: 'QA account' } }); assert.equal(login.status(), 200);
    const { bot } = await (await context.request.post(`${base}/api/bots`, { data: { name: 'Credits fixture Bot' } })).json();
    const db = new Database(env.DB_PATH);
    db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id); db.close();
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(20000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { errors.push('Unexpected external browser request'); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(id => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', 'light'); }, bot.id);
    await page.goto(base);
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    const composer = page.locator('.composer__input'); await composer.waitFor();
    const before = (await (await fetch(`http://127.0.0.1:${modelPort}/runs`)).json()).length;
    await composer.fill(`recover-${width}`); await composer.press('Enter');
    await page.locator('.bubble.is-agent').getByText('Normal reply after credit recovery.', { exact: true }).waitFor();
    const recovered = (await (await fetch(`http://127.0.0.1:${modelPort}/runs`)).json()).slice(before);
    assert.deepEqual(recovered.map(r => r.cap), [4096, 1800]);
    assert.equal(await page.getByText('Out of API credits', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidence, `recovered-${width}.png`) });
    await composer.fill(`exhausted-${width}`); await composer.press('Enter');
    const notice = page.locator('.notice').filter({ hasText: 'Out of API credits' }); await notice.waitFor();
    const link = notice.getByRole('link', { name: 'Manage OpenRouter credits' });
    assert.equal(await link.getAttribute('href'), 'https://openrouter.ai/settings/credits');
    assert.equal(await page.getByText('You stopped this request.', { exact: true }).count(), 0);
    const detail = notice.locator('details'); assert.equal(await detail.getAttribute('open'), null);
    await detail.locator('summary').click();
    await detail.getByText('This request would exceed your available credits given your current in-flight requests.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    const box = await notice.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.screenshot({ path: path.join(evidence, `exhausted-${width}.png`), fullPage: true });
    await page.reload();
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    await page.getByText('Out of API credits', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Manage OpenRouter credits' }).getAttribute('href'), 'https://openrouter.ai/settings/credits');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: HTTP 402 retry gives normal reply; exhaustion has billing link, details, no Stop, persists after reload`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-12000)); throw e; }
finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  await fs.rm(temp, { recursive: true, force: true });
}
