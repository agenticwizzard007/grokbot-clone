// P-05: Vite UI, DEV_LOGIN, temporary SQLite and mocked model/toolkit backends only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-recovery-ui-'));
const evidence = path.join(root, '.context/chat-recovery');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
const apiPort = await freePort(), uiPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
// Allowlist environment variables so no credentials or live database settings are inherited.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SESSION_SECRET: 'chat-recovery-fixture', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${apiBase}/mock`,
  COMPOSIO_API_KEY: 'fixture-only', RECOVERY_CALLS: path.join(temp, 'calls.txt'),
};
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}\n${logs.join('')}`);
}
async function ready(url, child) {
  await until(async () => {
    assert.equal(child.exitCode, null, logs.join(''));
    return fetch(url).then(response => response.ok, () => false);
  }, url);
}
async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}
async function startApi() {
  const child = start(['--import', 'tsx', 'tests/fixtures/chat-recovery-server.mts']);
  await ready(`${apiBase}/api/health`, child); return child;
}
async function rows(context, botId) {
  const response = await context.request.get(`${base}/api/bots/${botId}/rows`);
  assert.equal(response.status(), 200); return (await response.json()).rows;
}
const calls = () => fs.readFile(env.RECOVERY_CALLS, 'utf8').catch(() => '');

try {
  let server = await startApi();
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const scenario of ['stream', 'tool']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `${scenario}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const response = await context.request.post(`${base}/api/bots`, { data: { name: 'Recovery QA Bot' } });
    assert.equal(response.status(), 200); const { bot } = await response.json();
    if (scenario === 'tool') {
      const db = new Database(env.DB_PATH);
      db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id);
      db.close();
    }
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { errors.push('Unexpected external browser request'); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(botId => { localStorage.setItem('swarm.selectedBot', botId); localStorage.setItem('swarm.theme', 'light'); }, bot.id);
    await page.goto(base);
    const send = await context.request.post(`${base}/api/bots/${bot.id}/messages`, { data: { text: `${scenario}-fixture`, submissionId: `${scenario}-request` } });
    assert.equal(send.status(), 200);
    const { jobIds: [jobId] } = await send.json();
    await until(async () => (await rows(context, bot.id)).some(row => scenario === 'stream'
      ? row.body.type === 'message' && row.body.streaming
      : row.body.type === 'tool-call' && row.body.callId === 'fixture-uncertain' && row.body.status === 'running'), 'crash boundary');
    if (scenario === 'stream') await page.locator('.bubble.is-streaming').waitFor();
    else await page.locator('.step.is-running').waitFor();
    const before = await calls();
    // Hard termination skips graceful finally blocks and leaves real in-flight rows on disk.
    await stop(server, 'SIGKILL');
    server = await startApi();
    const notice = page.locator(`[data-recovery-job="${jobId}"]`);
    const recovered = await rows(context, bot.id);
    const jobNotice = recovered.filter(row => row.body.recovery?.jobId === jobId);
    assert.equal(jobNotice.length, 1);
    // Vite can retain a severed SSE proxy connection until the 45 second watchdog fires.
    await notice.waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.bubble.is-streaming, .step.is-running, .step.is-queued').count(), 0);
    assert.ok(recovered.every(row => !row.body.streaming));
    if (scenario === 'tool') assert.deepEqual(recovered.filter(row => row.body.type === 'tool-call').map(row => row.body.status), ['done', 'uncertain', 'interrupted']);
    else assert.equal(recovered.find(row => row.body.interrupted)?.body.jobId, jobId);
    assert.equal(await calls(), before, 'restart must not invoke a model or tool for uncertain work');

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      if (width <= 760) await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
      await notice.waitFor();
      await notice.getByText('Review activity', { exact: true }).click();
      assert.match(await notice.innerText(), /Nothing was automatically retried/);
      if (scenario === 'stream') {
        await page.getByText('Interrupted reply', { exact: true }).waitFor();
        assert.match(await notice.innerText(), /No tool actions were recorded/);
      } else {
        const activity = await notice.locator('li').allTextContents();
        assert.match(activity[0], /Completed/);
        assert.match(activity[1], /Result unknown/);
        assert.match(activity[2], /Interrupted before dispatch/);
        assert.match(await notice.innerText(), /check the affected app before retrying/);
      }
      await notice.scrollIntoViewIfNeeded();
      const bounds = await notice.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: path.join(evidence, `${scenario}-${width}.png`) });
    }
    // A second restart is idempotent, then an explicitly new request can complete.
    await stop(server, 'SIGKILL'); server = await startApi();
    assert.equal((await rows(context, bot.id)).filter(row => row.body.recovery?.jobId === jobId).length, 1);
    assert.equal(await calls(), before);
    const retry = await context.request.post(`${base}/api/bots/${bot.id}/messages`, { data: { text: 'new-request-fixture', submissionId: 'explicit-new-request' } });
    assert.equal(retry.status(), 200);
    await until(async () => (await rows(context, bot.id)).some(row => row.body.text === 'New request completed.'), 'new request completes');
    assert.equal((await calls()).split('\n').filter(line => line === 'tool').length, before.split('\n').filter(line => line === 'tool').length);
    assert.deepEqual(errors, []);
    console.log(`PASS P-05 ${scenario}: hard restart, SSE, reload, activity, no replay, second restart and explicit new request at 1280px and 390px`);
    await context.close();
  }
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join('')); throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) await stop(child);
  await fs.rm(temp, { recursive: true, force: true });
}
