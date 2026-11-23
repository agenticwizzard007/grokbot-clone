// QA PR L-03: real local API, SQLite, composer and SSE with held model replies.
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
let browser, gate, releaseReply, replyStage;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const holdReply = stage => new Promise(resolve => {
  replyStage = stage;
  releaseReply = () => { releaseReply = undefined; resolve(); };
});
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
  // Hold model output before text, after blank text, and after the first nonblank delta.
  gate = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const streaming = request.url === '/v1/responses' && JSON.parse(Buffer.concat(chunks).toString()).stream;
      if (streaming) await holdReply('before-text');
      const upstream = await fetch(`http://127.0.0.1:${modelPort}${request.url}`, {
        method: request.method, headers: { 'content-type': 'application/json' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
      const body = await upstream.text();
      if (streaming) {
        const events = body.trim().split('\n\n');
        const firstText = events.findIndex(event => event.startsWith('event: response.output_text.delta'));
        assert.ok(firstText > 0, 'mock reply has text');
        const delta = JSON.parse(events[firstText].split('\ndata: ')[1]);
        response.write(events.slice(0, firstText).join('\n\n') + '\n\n');
        response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ ...delta, delta: ' \n\t' })}\n\n`);
        await holdReply('blank-text');
        response.write(events[firstText] + '\n\n');
        await holdReply('buffered-text');
        response.end(events.slice(firstText + 1).join('\n\n') + '\n\n');
      } else response.end(body);
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
  for (const width of [1440, 1280, 1024, 768, 390]) for (const theme of ['light', 'dark']) for (const bot of bots) {
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
    const mark = page.getByRole('status', { name: 'Working', exact: true });
    const flock = mark.locator('.flock-mark.is-working');
    const moving = flock.locator('.flock-mark__moving:visible');
    const assertFlock = async () => {
      await moving.waitFor();
      assert.equal(await moving.getAttribute('src'), `/assets/swarms/flock-working-${theme === 'dark' ? 'night' : 'light'}.svg`);
      assert.ok(await moving.evaluate(el => el.complete && el.naturalWidth > 0), 'the animated asset is loaded');
      for (const element of [mark, flock, moving]) {
        const box = await element.boundingBox();
        assert.equal(box.width, 32, 'the mark, flock and visible image each use 32px width');
        assert.equal(box.height, 32, 'the mark, flock and visible image each use 32px height');
      }
      const box = await moving.boundingBox(), clip = await page.locator('.transcript').boundingBox();
      assert.ok(box.x >= clip.x && box.x + box.width <= clip.x + clip.width);
      assert.ok(box.y >= clip.y && box.y + box.height <= clip.y + clip.height, 'all 32px remain visible');
      assert.equal(await mark.locator('.bot-avatar').count(), 0, 'processing uses the flock');
      assert.equal(await page.locator('.bubble.is-streaming').count(), 0, 'no empty streaming bubble or trailing dot');
      assert.ok((await page.locator('.bubble.is-agent .md').allTextContents()).every(text => text.trim()), 'no blank assistant bubble');
    };
    const label = `${width}-${theme}-${bot.isPrimary ? 'primary' : 'secondary'}`;
    for (const turn of ['first', 'later']) {
      await page.getByRole('textbox', { name: `Message ${bot.name}` }).fill(`mock: say Local avatar check complete for ${turn} reply.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await until(() => replyStage === 'before-text' && Boolean(releaseReply), 'held model request');
      await assertFlock();
      assert.equal(await bird.innerHTML(), identity, 'working header preserves the exact chosen formation');
      assert.equal(await bird.evaluate(el => getComputedStyle(el).color), fill, 'header retains the Bot color');
      const frame = await moving.screenshot();
      let animated = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(110);
        if (!frame.equals(await moving.screenshot())) { animated = true; break; }
      }
      assert.ok(animated, 'the 32px flock has visible pixel motion');
      await page.screenshot({ path: join(evidence, `${label}-${turn}-working.png`) });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const still = flock.locator('.flock-mark__static:visible');
      await still.waitFor();
      assert.equal(await moving.count(), 0, 'reduced motion hides the animation');
      assert.equal((await still.boundingBox()).width, 32);
      const staticFrame = await still.screenshot();
      await sleep(250);
      assert.ok(staticFrame.equals(await still.screenshot()), 'reduced motion artwork stays still');
      assert.equal(await bird.evaluate(el => el.getAnimations().length), 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      releaseReply();
      // Configured Bots buffer deltas until the full reply passes validation.
      // Synchronize with the mock stream, not a blank SQLite or store row.
      await until(() => replyStage === 'blank-text' && Boolean(releaseReply), 'held blank text');
      await page.waitForFunction(async botId => {
        const { useStore } = await import('/src/store.ts');
        return useStore.getState().live[botId]?.activity?.kind === 'working';
      }, bot.id);
      await assertFlock();
      assert.equal(await bird.innerHTML(), identity, 'blank stream preserves the Bot bird');
      assert.equal(await bird.evaluate(el => getComputedStyle(el).color), fill, 'blank stream preserves the Bot color');
      releaseReply();
      await until(() => replyStage === 'buffered-text' && Boolean(releaseReply), 'held buffered text');
      await assertFlock();
      releaseReply();
      await page.locator('.bubble.is-agent').getByText(`Local avatar check complete for ${turn} reply.`, { exact: true }).waitFor();
      await mark.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.first-response').count(), 0, 'the validated reply replaces the loader');
      await page.waitForFunction(() => !document.querySelector('.chat__header .bot-avatar--working'));
      assert.equal(await bird.innerHTML(), identity, 'completed reply preserves header identity');
      assert.deepEqual(unexpected, []);
      console.log(`PASS ${label}-${turn}: animated 32px flock, blank stream, validated reply handoff, reduced motion, header identity`);
    }
    await context.close();
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
