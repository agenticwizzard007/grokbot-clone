// Production UI, local API/database and real SSE. Only synthetic fixture data and providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
const evidence = '.context/step-approval'; await fs.mkdir(evidence, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'step-approval-ui-'));
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await port(), uiPort = await port(), backend = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'https://model.fixture/v1', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const server = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/step-approval-server.mts'], { env, stdio: 'pipe' });
let logs = '', vite, browser, page;
for (const stream of [server.stdout, server.stderr]) stream.on('data', b => logs += b);
const frames = [];
const request = async (client, route, data) => { const response = await client.post(`${origin}${route}`, { data }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
async function sampleClick(page, name) {
  await page.bringToFront();
  const button = page.getByRole('button', { name, exact: true });
  await button.evaluate(el => {
    window.decisionFrame = new Promise(resolve => el.addEventListener('click', () => {
      const clicked = performance.now();
      requestAnimationFrame(() => resolve({ delay: performance.now() - clicked, step: document.querySelector('.step__summary')?.textContent, card: document.querySelector('.card__outcome')?.textContent }));
    }, { once: true }));
  });
  await button.click();
  return page.evaluate(() => window.decisionFrame);
}
try {
  for (let i = 0; i < 250; i++) { if (await fetch(`${backend}/api/health`).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok((await fetch(`${backend}/api/health`)).ok, logs);
  const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
  await build({ root, build: { outDir, emptyOutDir: true } });
  vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: backend } } } });
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await request(context.request, '/api/auth/dev', { email: `step-${width}-${theme}@example.test`, name: 'Fixture account' });
    page = await context.newPage(); const second = await context.newPage();
    const errors = []; for (const client of [page, second]) { client.setDefaultTimeout(15000); client.on('pageerror', e => errors.push(e.message)); }
    for (const outcome of ['denied', 'allowed', 'always', 'expired']) {
      const { bot } = await request(context.request, '/api/bots', { name: 'Draft fixture' });
      await request(context.request, `/api/bots/${bot.id}/setup/skip`);
      const fixture = await request(context.request, `/api/__fixture/approval/${bot.id}`, { voice: true });
      const url = `${origin}/#bot/${bot.id}`;
      for (const client of [page, second]) { await client.goto(url); await client.locator('.step__summary').filter({ hasText: 'Waiting for approval' }).waitFor(); }
      const replies = await page.locator('.bubble.is-agent').count();
      const label = { denied: 'Not allowed', allowed: 'Allowed once', always: 'Always allowed', expired: 'Expired' }[outcome];
      if (outcome === 'denied') {
        // The first request fails after one frame: both the card and step must roll back.
        let release; const gate = new Promise(r => release = r);
        await page.route(`**/api/approvals/${fixture.approvalId}`, async route => { await gate; await route.fulfill({ status: 503, json: { error: 'Fixture request failure' } }); }, { times: 1 });
        const frame = await sampleClick(page, "Don't allow");
        assert.equal(frame.step, label); assert.equal(frame.card, label); frames.push({ width, theme, outcome: 'rollback', ...frame });
        release();
        await page.getByRole('alert').filter({ hasText: 'Could not save your decision. Please try again.' }).waitFor();
        assert.equal(await page.locator('.step__summary').innerText(), 'Waiting for approval');
        await page.getByRole('button', { name: "Don't allow", exact: true }).waitFor();
      }
      if (outcome === 'expired') await request(context.request, `/api/__fixture/expire/${bot.id}/${fixture.cardSeq}`);
      else {
        let release; const gate = new Promise(r => release = r);
        await page.route(`**/api/approvals/${fixture.approvalId}`, async route => { await gate; await route.continue(); }, { times: 1 });
        const frame = await sampleClick(page, { denied: "Don't allow", allowed: 'Allow', always: 'Always allow' }[outcome]);
        assert.equal(frame.step, label); assert.equal(frame.card, label); frames.push({ width, theme, outcome, ...frame });
        assert.equal(await second.locator('.step__summary').innerText(), 'Waiting for approval', 'other client cannot know an unsent choice');
        release();
      }
      // Second page has no click, polling, or reload: this is the real server SSE path.
      for (const client of [page, second]) {
        await client.locator('.step__summary').filter({ hasText: label }).waitFor();
        assert.equal(await client.locator('.card__outcome').innerText(), label);
        assert.equal(await client.locator('.bubble.is-agent').count(), replies, 'no Bot follow-up reply');
      }
      await request(context.request, `/api/__fixture/stale/${bot.id}/${fixture.stepSeq}`);
      await page.waitForTimeout(100);
      for (const client of [page, second]) assert.equal(await client.locator('.step__summary').innerText(), label, 'late waiting event is ignored');
      await page.reload();
      await page.locator('.step__summary').filter({ hasText: label }).waitFor();
      assert.equal(await page.locator('.card__outcome').innerText(), label);
      assert.equal(await page.locator('.bubble.is-agent').count(), replies);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (outcome === 'denied') await page.screenshot({ path: `${evidence}/denied-${width}-${theme}.png` });
      console.log(`PASS ${width} ${theme} ${outcome}: first frame, HTTP/SSE, reload, monotonic row, voice source, no reply or overflow`);
    }
    assert.deepEqual(errors, []); await context.close();
  }
  await fs.writeFile(`${evidence}/frames.json`, JSON.stringify(frames, null, 2));
} catch (error) { console.error(logs.slice(-5000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-2500)); await page.screenshot({ path: `${evidence}/failure.png` }); } throw error; }
finally { await browser?.close(); await vite?.httpServer.close(); if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }
