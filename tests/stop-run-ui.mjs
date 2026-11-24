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
const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-run-ui-'));
const evidence = path.join(root, '.context/stop-run'); await fs.mkdir(evidence, { recursive: true });
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
  start(['tests/fixtures/stop-run-provider.mjs', String(modelPort)]);
  start(['--import', 'tsx', 'tests/fixtures/stop-voice-server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API');
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite');
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 1280]) for (const active of [true, false]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `fixture-${width}-${active}@example.test`, name: 'QA account' } }); assert.equal(login.status(), 200);
    const { bot } = await (await context.request.post(`${base}/api/bots`, { data: { name: 'Fixture Bot' } })).json();
    const db = new Database(env.DB_PATH);
    if (active) db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id);

    db.close();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.setDefaultTimeout(20000);
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== base) { errors.push('Unexpected external browser request'); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(id => {
      localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', 'light');
    }, bot.id);
    await page.goto(base);
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    const composer = page.locator('.composer__input'); await composer.waitFor();
    const previousRuns = (await (await fetch(`http://127.0.0.1:${modelPort}/runs`)).json()).length;
    await composer.fill('Write a detailed essay about the history of bees.'); await composer.press('Enter');
    await until(async () => (await (await fetch(`http://127.0.0.1:${modelPort}/runs`)).json()).length > previousRuns, 'model starts');
    if (!active) await page.locator('.bubble.is-agent').getByText('Bees have a long history.', { exact: true }).waitFor();
    const before = Date.now();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('You stopped this request.', { exact: true }).waitFor();
    await composer.fill('Write 40 words about tea.'); await composer.press('Enter');
    await page.locator('.bubble.is-agent').getByText('Tea is a warm drink made from leaves.', { exact: true }).waitFor();
    assert.ok(Date.now() - before < 5000, 'replacement must not wait for the 30 second model');
    await until(async () => (await (await fetch(`http://127.0.0.1:${modelPort}/runs`)).json()).slice(previousRuns).some(r => r.bees && r.closed), 'provider stream aborted');
    const allBubbles = await page.locator('.bubble.is-agent').allTextContents();
    const bubbles = allBubbles.filter(text => /Bees have a long history|Tea is a warm drink/.test(text));
    assert.equal(bubbles.length, active ? 1 : 2);
    if (!active) assert.match(bubbles[0], /Bees have a long history/);
    assert.match(bubbles.at(-1), /Tea is a warm drink/); assert.doesNotMatch(bubbles.at(-1), /bee/i);
    assert.equal(await page.getByText('THE STOPPED BEES ESSAY', { exact: false }).count(), 0);
    // Replay delayed SSE data from the stopped run while the new run is current.
    await page.evaluate(async botId => {
      const store = (await import('/src/store.ts')).useStore;
      const rows = Object.values(store.getState().transcripts[botId].bySeq);
      const old = rows.find(r => r.body.type === 'notice' && r.body.text === 'You stopped this request.');
      store.getState().handleEvent({ type: 'rows', botId, generation: old.generation, runId: old.body.jobId, runBotId: botId,
        rows: [{ ...old, updatedSeq: 999999, body: { ...old.body, text: 'THE STOPPED BEES ESSAY' } }] });
    }, bot.id);
    assert.deepEqual(await page.locator('.bubble.is-agent').allTextContents(), allBubbles);
    const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
    if (await jump.count()) await jump.click();
    await page.screenshot({ path: path.join(evidence, `stop-then-send-${active ? 'active' : 'partial'}-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS stop-then-send ${width}px ${active ? 'active' : 'partial'}: isolated replies, aborted HTTP stream, prompt replacement, stale SSE discarded`);
    await context.close();
  }
} catch (e) { console.error(logs.join('').slice(-12000)); throw e; }
finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  await fs.rm(temp, { recursive: true, force: true });
}
