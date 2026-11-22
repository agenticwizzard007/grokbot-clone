// R2F-005: Create a Bot keeps exactly the typed name under load. Built frontend, mocked API, no live account.
// Types in chunks with pauses while a Bot streams, with 4x CPU throttling, clicks Create right after the last
// chunk, and checks the created name, the composer, the caret and that the name input is never remounted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/create-bot-ui/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server, origin = process.env.UI_ORIGIN, logs = '';
if (!origin) {
  const port = await new Promise(resolve => { const socket = http.createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
  server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
}
const wait = async (predicate, label = 'condition') => { for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out waiting for ${label}`); };
const now = Date.now();
const base = { description: '', instructions: '', mode: 'personal', pinned: false, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: 'Ready', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' } };
const fixtureBots = () => [
  { ...base, id: 'quinn', name: 'Quinn', label: 'Chief of Staff', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob' },
  ...Array.from({ length: 24 }, (_, n) => ({ ...base, id: `bot-${n}`, name: `Helper ${n}`, label: '', avatarColor: 'green', avatarShape: 'clover', lastActivityAt: now - n * 1000 })),
];
const rowsFor = id => Array.from({ length: 60 }, (_, n) => ({ botId: id, generation: 1, seq: n + 1, updatedSeq: n + 1, createdAt: now - (60 - n) * 60_000, kind: 'message', body: { type: 'message', role: n % 2 ? 'assistant' : 'user', text: `Message ${n + 1} with **some** markdown, a [link](https://example.test) and a list:\n\n- one\n- two\n- three` } }));

let browser;
try {
  await wait(() => fetch(origin).then(r => r.ok, () => false), 'preview');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const name = 'QA-Temp-9';
  for (const scenario of [{ throttle: 4, chunks: ['QA-', 'Temp', '-9'], gap: 200, click: 10 }, { throttle: 4, chunks: ['QA-Temp-9'], gap: 0, click: 0, enter: true }, { throttle: 1, chunks: ['QA', '-Te', 'mp-9'], gap: 120, click: 10 }, { throttle: 4, chunks: ['QA-Te', 'mp'], gap: 150, click: 0, late: '-9' }]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(20000);
    const errors = [], created = [];
    let bots = fixtureBots();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.selectedBot', 'quinn');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { window.__emit = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
      // Probe: caret position after every input event in the name field, and remounts of that field.
      window.__caret = []; window.__nameInputs = new Set(); window.__long = [];
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false });
      document.addEventListener('input', event => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement) || el.placeholder !== 'Give your Bot a name') return;
        window.__nameInputs.add(el);
        window.__caret.push({ start: el.selectionStart, length: el.value.length, value: el.value });
      }, true);
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (request.method() === 'POST' && path === '/api/bots') {
        const body = request.postDataJSON();
        created.push(body.name);
        const bot = { ...base, id: `created-${created.length}`, name: body.name, label: '', avatarColor: body.avatarColor, avatarShape: body.avatarShape, mode: body.mode, isPrimary: false, lastActivityAt: Date.now() };
        bots = [...bots, bot];
        await new Promise(r => setTimeout(r, 150));
        return route.fulfill({ json: { bot } });
      }
      if (request.method() !== 'GET') return route.fulfill({ json: { ok: true } });
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' }, devLogin: false, googleLogin: false };
      else if (path === '/api/bots') body = { bots, live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: path.includes('/created-') ? [] : rowsFor(path.split('/')[3]) };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], defaultModel: null, favourites: [], canFast: false };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      return route.fulfill({ json: body });
    });
    await page.goto(origin);
    await page.locator('.composer__input').waitFor();
    await page.getByText('Message 60 with', { exact: false }).waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.throttle });
    // A Bot is working: live, roster and row events stream while the user fills in the form.
    await page.evaluate(() => {
      let n = 0;
      window.__stream = setInterval(() => {
        n++;
        window.__emit({ type: 'live', state: { botId: 'quinn', isRunning: true, awaiting: null, activity: { kind: 'thinking', detail: `Step ${n}`, since: Date.now() }, startedAt: Date.now() - 5000 } });
        window.__emit({ type: 'live', state: { botId: `bot-${n % 24}`, isRunning: n % 2 === 0, awaiting: null, activity: null, startedAt: null } });
        window.__emit({ type: 'rows', botId: 'quinn', generation: 1, rows: [{ botId: 'quinn', generation: 1, seq: 61, updatedSeq: 61 + n, createdAt: Date.now(), kind: 'message', body: { type: 'message', role: 'assistant', text: `Streaming ${n} `.repeat(n % 50) } }] });
        if (n % 5 === 0) window.__emit({ type: 'bot', bot: { id: `bot-${n % 24}`, name: `Helper ${n % 24}`, label: '', description: '', instructions: '', mode: 'personal', pinned: false, effort: 'medium', model: null, generation: 1, unread: n % 3, lastPreview: `Update ${n}`, lastActivityAt: Date.now(), createdAt: 0, kind: 'agent', avatarColor: 'green', avatarShape: 'clover', onboarding: { status: 'active' } } });
      }, 40);
    });
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const form = page.getByRole('main', { name: 'Create a Bot', exact: true });
    const input = form.getByRole('textbox', { name: 'Bot name' });
    await input.waitFor();
    await wait(() => input.evaluate(el => document.activeElement === el), 'name field focus');
    await page.evaluate(() => { window.__long = []; });
    for (const [i, chunk] of scenario.chunks.entries()) {
      await page.keyboard.type(chunk, { delay: 15 });
      if (i < scenario.chunks.length - 1) await page.waitForTimeout(scenario.gap);
    }
    const typingLongTasks = await page.evaluate(() => window.__long.slice());
    if (scenario.enter) await page.keyboard.press('Enter');
    else { await page.waitForTimeout(scenario.click); await form.getByRole('button', { name: 'Create', exact: true }).click(); }
    // Keystrokes delivered just after the click (input lag) still belong to the name.
    if (scenario.late) await page.keyboard.type(scenario.late, { delay: 10 });
    await wait(() => created.length === 1, 'create request');
    // Keys still arriving while the new Bot opens (typing through creation) must not land in its composer.
    for (let n = 0; n < 12; n++) { await page.keyboard.press('z'); await page.waitForTimeout(40); }
    await page.locator('.chat__pill-name').filter({ hasText: name }).waitFor();
    // Once typing pauses, the new chat's composer takes focus as usual.
    await wait(() => page.locator('.composer__input').evaluate(el => document.activeElement === el), 'composer focus after typing stops');
    await page.evaluate(() => clearInterval(window.__stream));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const label = `${scenario.throttle}x ${scenario.chunks.join('|')}${scenario.late ? ` then ${scenario.late} after Create` : ''}`;
    assert.deepEqual(created, [name], `${label}: the Bot gets exactly the typed name`);
    assert.equal(await page.locator('.composer__input').inputValue(), '', `${label}: no keystroke spills into the composer`);
    const probe = await page.evaluate(() => ({ caret: window.__caret, inputs: window.__nameInputs.size }));
    assert.equal(probe.inputs, 1, `${label}: the name input is never remounted while open`);
    const jumps = probe.caret.filter(c => c.start !== c.length);
    assert.deepEqual(jumps, [], `${label}: the caret stays at the end while typing`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: new URL(`created-${scenario.throttle}x-${scenario.chunks.length}.png`, evidence).pathname });
    await page.close();
    console.log(`PASS create a Bot ${label}: exact name, empty composer, caret at end, single input (long tasks while typing: ${typingLongTasks.join(', ') || 'none'})`);
  }
} catch (error) {
  if (logs) console.error(logs);
  throw error;
} finally { await browser?.close(); server?.kill(); }
