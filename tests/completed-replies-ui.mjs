// QA PR P-16: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'completed-replies-'));
const evidence = path.join(root, '.context/completed-replies');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Do not inherit provider credentials or database settings from the caller.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'completed-replies-fixture',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${modelBase}/v1`,
  OPENROUTER_BASE_URL: `${modelBase}/v1`, COMPOSIO_API_KEY: 'fixture-only',
};
const preload = path.join(temp, 'mock-backends.mjs');
await fs.writeFile(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected external request: ' + url.origin + url.pathname);
};
`);
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(child.exitCode, null, logs.join(''));
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${logs.join('')}`);
}

const bot = { id: 'reply-qa', name: 'Reply QA Bot' };
const other = { id: 'other-reply-qa', name: 'Other QA Bot' };
function seed(owner) {
  const db = new Database(env.DB_PATH);
  try {
    db.transaction(() => {
      const now = Date.now() - 1_000_000;
      const insert = db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,?,?,?)');
      for (const fixture of [bot, other]) {
        db.prepare('INSERT INTO bots(id,user_id,name,next_seq,rev,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(fixture.id, owner, fixture.name, 261, 260, now, now);
        for (let seq = 1; seq <= 260; seq++) insert.run(fixture.id, seq, seq, 'message', JSON.stringify({
          type: 'message', role: 'assistant', text: `History fixture ${seq}`, streaming: seq === 260,
        }), now + seq * 1000);
      }
    })();
  } finally { db.close(); }
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'reply-qa@example.test', name: 'QA account' } });
  assert.equal(login.status(), 200);
  const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
  seed(user.id);
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(id => localStorage.setItem('swarm.selectedBot', id), bot.id);
  await page.goto(base);
  await page.locator('.transcript [data-row-seq="260"]').waitFor();
  const status = page.getByRole('status', { name: 'Completed replies', exact: true });
  await status.waitFor({ state: 'attached' });
  assert.equal(await status.textContent(), '', 'initial history is silent');
  assert.equal(await status.getAttribute('aria-live'), 'polite');
  assert.equal(await status.getAttribute('aria-atomic'), 'true');
  const watch = async () => page.evaluate(() => {
    window.replyObserver?.disconnect();
    window.replyAnnouncements = [];
    const region = document.querySelector('[aria-label="Completed replies"]');
    window.replyObserver = new MutationObserver(() => window.replyAnnouncements.push(region.textContent.trim()));
    window.replyObserver.observe(region, { subtree: true, childList: true, characterData: true });
  });
  await watch();
  const announcements = () => page.evaluate(() => window.replyAnnouncements);
  // Flush React effects and MutationObserver callbacks after each fixture event.
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let revision = 1000;
  const message = (seq, text, extra = {}) => ({
    botId: bot.id, generation: 1, seq, updatedSeq: ++revision, kind: 'message', createdAt: Date.now(),
    body: { type: 'message', role: 'assistant', text, ...extra },
  });
  const emit = async (rows, generation = 1) => {
    await page.evaluate(async ({ botId, rows, generation }) => {
      const { useStore } = await import('/src/store.ts');
      useStore.getState().handleEvent({ type: 'rows', botId, generation, rows });
    }, { botId: bot.id, rows, generation });
    await settle();
  };
  const composer = page.getByRole('textbox', { name: `Message ${bot.name}`, exact: true });
  // Reach the composer with the keyboard and keep a draft there through completion.
  for (let step = 0; step < 80 && !await composer.evaluate(el => el === document.activeElement); step++) await page.keyboard.press('Tab');
  assert.ok(await composer.evaluate(el => el === document.activeElement), 'composer is reachable by keyboard');
  await page.keyboard.type('Unsent draft');
  await emit([message(260, 'Still streaming', { streaming: true })]);
  assert.deepEqual(await announcements(), [], 'no token announcements');
  await emit([message(260, 'Completed fixture answer', { streaming: false })]);
  assert.deepEqual(await announcements(), ['New reply from Reply QA Bot: Completed fixture answer']);
  assert.ok(await composer.evaluate(el => el === document.activeElement), 'completion preserves composer focus');
  assert.equal(await composer.inputValue(), 'Unsent draft');

  // Verify the visually hidden region remains exposed to assistive technology.
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const axStatus = nodes.find(node => node.role?.value === 'status' && node.name?.value === 'Completed replies');
  assert.ok(axStatus && !axStatus.ignored, 'announcer is present in the accessibility tree');
  assert.equal(axStatus.properties.find(prop => prop.name === 'live')?.value.value, 'polite');
  assert.equal(axStatus.properties.find(prop => prop.name === 'atomic')?.value.value, true);
  await fs.writeFile(path.join(evidence, 'accessibility.json'), JSON.stringify({ status: axStatus, announcements: await announcements() }, null, 2));

  await emit([message(260, 'Completed fixture answer', { streaming: false })]);
  await emit([message(260, 'Edited completed reply', { streaming: false })]);
  assert.equal((await announcements()).length, 1, 'duplicate events and edits do not replay a completion');
  await emit([message(261, '', { streaming: true })]);
  await emit([message(261, 'Token one', { streaming: true })]);
  await emit([message(261, 'Token one two', { streaming: true })]);
  assert.equal((await announcements()).length, 1, 'all streaming deltas stay silent');
  await emit([message(261, 'Completed fixture answer', { streaming: false })]);
  assert.deepEqual(await announcements(), Array(2).fill('New reply from Reply QA Bot: Completed fixture answer'), 'identical consecutive replies each produce an update');
  await emit([message(262, 'Instant answer')]);
  assert.equal((await announcements()).at(-1), 'New reply from Reply QA Bot: Instant answer', 'non-streamed answers announce');
  await emit([message(263, 'User fixture', { role: 'user' }), message(264, 'Internal fixture', { audience: 'internal' }),
    message(265, 'Interrupted fixture', { interrupted: true }), message(266, '   ')]);
  assert.equal((await announcements()).length, 3, 'user, internal, interrupted and empty rows stay silent');

  await page.getByRole('button', { name: 'Earlier messages', exact: true }).click();
  await page.locator('.transcript [data-row-seq="1"]').waitFor({ state: 'attached' });
  await settle();
  assert.equal((await announcements()).length, 3, 'paging history does not announce old replies');
  await emit([message(1, 'Edited historical fixture')]);
  assert.equal((await announcements()).length, 3, 'updating history stays silent');
  await emit([message(267, 'Batch reply one'), message(268, 'Batch reply two')]);
  assert.equal((await announcements()).at(-1), 'New reply from Reply QA Bot: Batch reply one New reply from Reply QA Bot: Batch reply two', 'batched completions are both included');
  assert.equal((await announcements()).length, 4);

  await page.locator('.sidebar .bot-row').filter({ hasText: other.name }).click();
  await page.locator(`.transcript[data-bot-id="${other.id}"] [data-row-seq="260"]`).waitFor();
  assert.equal(await status.textContent(), '', 'switching conversations resets the announcer');
  await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
  await page.locator(`.transcript[data-bot-id="${bot.id}"] [data-row-seq="268"]`).waitFor();
  assert.equal(await status.textContent(), '', 'cached history is not replayed on return');
  await watch();
  await emit([message(269, 'Reply after returning')]);
  assert.deepEqual(await announcements(), ['New reply from Reply QA Bot: Reply after returning']);
  await page.evaluate(async botId => {
    const { useStore } = await import('/src/store.ts');
    useStore.getState().handleEvent({ type: 'cleared', botId, generation: 2 });
  }, bot.id);
  await page.locator('.transcript[data-generation="2"]').waitFor();
  await settle();
  assert.equal(await status.textContent(), '', 'new generation clears the old announcement');
  await watch();
  await emit([{ ...message(1, 'First reply in new conversation'), generation: 2 }], 2);
  assert.deepEqual(await announcements(), ['New reply from Reply QA Bot: First reply in new conversation'], 'sequence numbers can restart in a new generation');
  assert.deepEqual(errors, [], 'no browser errors or external requests');
  console.log('PASS P-16: polite accessible completions, keyboard focus, streaming silence, deduplication, history paging, conversation switches and generation reset');
  await context.close();
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join(''));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}
