// QA SO L-03: real local API, SQLite, composer and SSE with held model replies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'loading-avatar-'));
const evidence = join(root, '.context/loading-avatar');
await mkdir(evidence, { recursive: true });
const children = [], errors = [];
let browser, gate, releaseReply;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function until(check, label) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const apiPort = await port(), uiPort = await port(), modelPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
// An allowlist keeps workspace credentials and database settings out of the fixture.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
  SWARM_ROLE: 'standalone', DB_PATH: join(temp, 'app.db'), FILES_DIR: join(temp, 'files'),
  DEV_LOGIN: '1', SESSION_SECRET: 'loading-avatar-test-only', PORT: String(apiPort),
  APP_URL: origin, SERVER_URL: origin, COMPUTER_PROVIDER: 'local',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'mock-key', COMPOSIO_API_KEY: 'mock-key',
  SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
};
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  // Only synthetic test data can reach these logs.
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => errors.push(String(data)));
  return child;
}

try {
  // Empty toolkit backend, plus a server-side network guard for all fetch calls.
  const preload = join(temp, 'offline.mjs');
  await writeFile(preload, `
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname === 'backend.composio.dev') return Promise.resolve(Response.json({ items: [], next_cursor: null, total_pages: 1 }));
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Unexpected external fetch: ' + url.origin);
      return original(input, init);
    };
  `);
  start(['tests/mock-provider.mjs', String(modelPort)]);
  await until(() => fetch(`http://127.0.0.1:${modelPort}/v1/models`).then(r => r.ok, () => false), 'mock provider');
  // Hold the real model request until both avatar assertions and screenshots finish.
  gate = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === '/v1/responses') await new Promise(resolve => { releaseReply = resolve; });
      const upstream = await fetch(`http://127.0.0.1:${modelPort}${request.url}`, {
        method: request.method, headers: { 'content-type': 'application/json' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve));
  start(['--import', preload, '--import', 'tsx', 'server/src/index.ts'], root, {
    DIRECT_BASE_URL: `http://127.0.0.1:${gate.address().port}/v1`,
  });
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'local API');
  await until(() => fetch(origin).then(r => r.ok, () => false), 'local UI');
  const login = await fetch(`${apiBase}/api/auth/dev`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'avatar-test@example.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(path, method = 'GET', body) {
    const response = await fetch(`${apiBase}/api${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const primaryId = (await api('/bots')).bots.find(bot => bot.isPrimary).id;
  const secondaryId = (await api('/bots', 'POST', { name: 'Research Bot', avatarShape: 'bird-pair', avatarColor: 'violet' })).bot.id;
  await api(`/bots/${primaryId}`, 'PATCH', { name: 'Primary Bot', avatarShape: 'bird-soar', avatarColor: 'orange' });
  await api(`/bots/${secondaryId}/setup/skip`, 'POST', {});
  const bots = (await api('/bots')).bots.filter(bot => [primaryId, secondaryId].includes(bot.id));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) for (const theme of ['light', 'dark']) for (const bot of bots) {
    await api(`/bots/${bot.id}/fresh`, 'POST', {});
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
    await context.addCookies([{ name: 'swarm_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await context.addInitScript(({ botId, theme }) => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', theme);
    }, { botId: bot.id, theme });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push(route.request().url());
      return route.abort();
    });
    await page.goto(origin);
    if (width < 761) await page.locator(bot.isPrimary ? '.pinned__tile' : '.bot-row').filter({ hasText: bot.name }).click();
    const header = page.locator('.chat__header .bot-avatar');
    const bird = header.locator(':scope > svg[data-bird]');
    await bird.waitFor();
    assert.equal(await bird.getAttribute('data-bird'), bot.avatarShape);
    const identity = await bird.innerHTML();
    const fill = await bird.evaluate(el => getComputedStyle(el).color);
    assert.equal(await bird.evaluate(el => el.style.getPropertyValue('--bird-fill')), bot.isPrimary ? '#FD690F' : '#8F59F9');
    await page.getByRole('textbox', { name: `Message ${bot.name}` }).fill('mock: say Local avatar check complete.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await until(() => Boolean(releaseReply), 'held model request');
    const mark = page.getByRole('status', { name: 'Working', exact: true });
    await mark.waitFor();
    const loader = mark.locator('.bot-avatar > svg');
    assert.equal(await loader.getAttribute('data-bird'), bot.avatarShape);
    assert.equal(await loader.innerHTML(), identity, 'loader preserves the exact chosen formation');
    assert.equal(await bird.innerHTML(), identity, 'working header preserves the exact chosen formation');
    for (const svg of [bird, loader]) {
      assert.equal(await svg.evaluate(el => getComputedStyle(el).color), fill, 'working retains the theme-adjusted Bot color');
      assert.equal(await svg.evaluate(el => el.getAnimations().length), 1, 'only the existing gentle pulse indicates work');
    }
    assert.equal(await page.locator('.bot-avatar .flock-mark, .bot-avatar__working').count(), 0, 'no replacement or extra flock badge');
    const box = await mark.boundingBox();
    assert.equal(box.width, 72); assert.equal(box.height, 72);
    const label = `${width}-${theme}-${bot.isPrimary ? 'primary' : 'secondary'}`;
    await page.screenshot({ path: join(evidence, `${label}-working.png`) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const svg of [bird, loader]) assert.equal(await svg.evaluate(el => el.getAnimations().length), 0);
    assert.equal(await loader.innerHTML(), identity, 'reduced motion preserves identity');
    releaseReply(); releaseReply = undefined;
    await page.locator('.bubble.is-agent').getByText('Local avatar check complete.', { exact: true }).waitFor();
    await mark.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.chat__header .bot-avatar--working'));
    assert.equal(await bird.innerHTML(), identity, 'completed reply preserves identity');
    assert.deepEqual(unexpected, []);
    await context.close();
    console.log(`PASS ${label}: chosen bird and color before, during and after reply; reduced motion; 72 px slot`);
  }
} catch (error) {
  console.error(errors.join('').slice(-6000));
  throw error;
} finally {
  releaseReply?.();
  await browser?.close();
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  gate?.closeAllConnections();
  if (gate) await new Promise(resolve => gate.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
