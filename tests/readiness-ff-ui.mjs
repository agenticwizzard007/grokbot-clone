// Production bundle, real local API/database, synthetic providers and fresh browser contexts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium, request } from 'playwright';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
const evidence = '.context/readiness-ff'; await fs.mkdir(evidence, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'readiness-ff-'));
const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening');
const port = s.address().port; await new Promise(resolve => s.close(resolve));
const backend = `http://127.0.0.1:${port}`;
const uiSocket = http.createServer().listen(0, '127.0.0.1'); await once(uiSocket, 'listening');
const uiPort = uiSocket.address().port; await new Promise(resolve => uiSocket.close(resolve));
const origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(port), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'https://model.fixture/v1', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const server = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/readiness-ff-server.mts'], { env, stdio: 'pipe' });
let log = '', vite, browser, page;
for (const stream of [server.stdout, server.stderr]) stream.on('data', b => { log += b; });
const frames = [];
try {
  for (let n = 0; n < 250; n++) { if (await fetch(`${backend}/api/health`).then(r => r.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok((await fetch(`${backend}/api/health`)).ok, log);
  const root = path.resolve('web'), outDir = path.resolve(evidence, 'dist');
  await build({ root, build: { outDir, emptyOutDir: true } });
  vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: uiPort, strictPort: true, proxy: { '/api': { target: backend }, '/__fixture': { target: backend } } } });
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const api = async (client, route, data, method = 'post') => {
    const response = await client[method](`${origin}${route}`, { data });
    assert.equal(response.status(), 200, `${route}: ${await response.text()}`); return response.json();
  };
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const email = `fresh-${width}-${theme}@example.test`;
    const seed = await request.newContext();
    await api(seed, '/api/auth/dev', { email, name: 'Fixture account' });
    const { bot } = await api(seed, '/api/bots', { name: 'Suggestions fixture', description: 'Summarize Slack channels' });
    await api(seed, `/api/bots/${bot.id}/setup/skip`);
    const result = await api(seed, `/api/bots/${bot.id}/suggested-apps`, {});
    assert.equal(result.suggestions[0].slug, 'slack');
    const legacy = await api(seed, `/__fixture/legacy/${bot.id}`, {});
    await seed.dispose();
    // No storageState, no seeded localStorage and no prior page visit.
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.deepEqual((await context.storageState()).origins, []);
    await api(context.request, '/api/auth/dev', { email, name: 'Fixture account' });
    await context.addInitScript(() => {
      window.suggestionFrames = [];
      window.storageBeforeApp = { local: localStorage.length, session: sessionStorage.length };
      new MutationObserver(() => {
        const region = document.querySelector('.suggested-integrations');
        if (region) window.suggestionFrames.push({ at: performance.now(), text: region.textContent });
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/suggested-apps', async route => { entered = true; await gate; await route.continue(); });
    await page.goto(`${origin}/#bot/${bot.id}/settings/general`, { waitUntil: 'domcontentloaded' });
    const panel = page.getByRole('region', { name: 'Suggested integrations' });
    await panel.getByText('Slack', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.storageBeforeApp), { local: 0, session: 0 });
    await page.waitForTimeout(2800);
    assert.ok(entered);
    const samples = await page.evaluate(() => window.suggestionFrames);
    assert.ok(samples.length && samples[0].text.includes('Slack'), 'suggestion is present on the first meaningful panel paint');
    assert.ok(samples.every(frame => !frame.text.includes('Finding relevant')), 'no loading note at any observed time');
    const snapshot = JSON.parse(await page.evaluate(() => localStorage.getItem('swarm.suggestions')));
    assert.equal(snapshot.version, 1); assert.equal(snapshot.bots[0][1].suggestions[0].slug, 'slack');
    assert.doesNotMatch(JSON.stringify(snapshot), /Summarize Slack channels|Still pending|Unverified/);
    frames.push({ width, theme, samples });
    await page.screenshot({ path: `${evidence}/fresh-${width}-${theme}.png` });
    // Connection changes are read by the real suggestions endpoint and replace its durable snapshot.
    await api(context.request, `/__fixture/connect/${bot.id}`, {}); release();
    await panel.getByText('No matching additional apps for this Bot right now.').waitFor();
    await page.reload();
    await panel.getByText('No matching additional apps for this Bot right now.').waitFor();
    assert.ok((await page.evaluate(() => window.suggestionFrames)).every(frame => !frame.text.includes('Finding relevant')));
    const roster = await api(context.request, '/api/bots', undefined, 'get');
    assert.deepEqual(roster.bots.find(item => item.id === bot.id).suggestedApps.suggestions, []);
    await page.goto(`${origin}/#bot/${bot.id}`);
    const linked = page.locator(`.system-event[data-row-seq="${legacy.linked}"]`);
    await linked.waitFor(); await linked.scrollIntoViewIfNeeded();
    assert.match(await linked.innerText(), /was not allowed.*Voice R7/);
    const unlinked = page.locator(`.system-event[data-row-seq="${legacy.unlinked}"]`);
    assert.doesNotMatch(await unlinked.innerText(), /pending|Unverified/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/legacy-${width}-${theme}.png` });
    assert.deepEqual(errors, []);
    // An empty-storage account cannot obtain another account's Bot or snapshot.
    const foreign = await request.newContext();
    await api(foreign, '/api/auth/dev', { email: `other-${width}-${theme}@example.test`, name: 'Other fixture' });
    const otherBots = await api(foreign, '/api/bots', undefined, 'get');
    assert.ok(!otherBots.bots.some(item => item.id === bot.id));
    assert.equal((await foreign.post(`${origin}/api/bots/${bot.id}/suggested-apps`, { data: {} })).status(), 404);
    await foreign.dispose();
    await context.close();
    console.log(`PASS ${width} ${theme}: fresh first paint, 2.8s quiet refresh, connection replacement, reload, account isolation, linked and unlinked legacy pills`);
  }
  await fs.writeFile(`${evidence}/first-paint.json`, JSON.stringify(frames, null, 2));
} catch (error) { console.error(log.slice(-5000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: `${evidence}/failure.png` }); } throw error; }
finally { await browser?.close(); if (vite) await new Promise(resolve => vite.httpServer.close(resolve)); server.kill(); if (server.exitCode === null && server.signalCode === null) await once(server, 'exit'); await fs.rm(tmp, { recursive: true, force: true }); }
