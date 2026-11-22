// Local synthetic browser checks. All API traffic is intercepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/r3-chat/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server, origin = process.env.UI_ORIGIN;
if (!origin) {
  const port = await new Promise(resolve => {
    const socket = http.createServer().listen(0, '127.0.0.1', () => {
      const port = socket.address().port; socket.close(() => resolve(port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'ignore' });
}
const wait = async (fn, label) => {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
const now = Date.now();
const bot = { id: 'bot_AbCdEf123456', name: 'Research', description: '', instructions: '', label: '', mode: 'personal', pinned: true, isPrimary: true, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: '', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' }, avatarColor: 'blue', avatarShape: 'blob' };
const ids = ['ca', 'req', 'apr', 'cli', 'call', 'job', 'room', 'connect', 'rt'].map(prefix => `${prefix}_AbCdEf123456`).join(' ');
const internal = /\b(?:ca|req|apr|cli|call|job|room|connect|bot|rt)_[A-Za-z0-9_-]{6,}/;
const row = (seq, body) => ({ botId: bot.id, generation: 1, seq, updatedSeq: seq, createdAt: now + seq, kind: body.type, body });
const rows = [
  row(1, { type: 'message', role: 'assistant', text: `Ask ${bot.id}. ${ids}` }),
  row(2, { type: 'notice', text: `Notice: ${ids}` }),
  row(3, { type: 'event', event: 'routine-created', text: `Routine: ${ids}` }),
  row(4, { type: 'card', card: 'approval', approvalId: 'apr_AbCdEf123456', tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', toolkitName: `Gmail ${ids}`, title: `Approve ${ids}`, detail: `Account: ca_AbCdEf123456\nRoutine: rt_AbCdEf123456\n${ids}`, args: { account: 'ca_AbCdEf123456' }, status: 'pending' }),
  row(5, { type: 'card', card: 'draft', channel: 'email', to: `Recipient ${ids}`, text: `Draft ${ids}`, approvalId: '', status: 'pending' }),
  row(6, { type: 'card', card: 'question', question: `Choose ${ids}`, options: [`Answer ${ids}`], status: 'pending' }),
];
const live = running => ({ botId: bot.id, isRunning: running, startedAt: now, activity: running ? { kind: 'thinking', since: now } : undefined });
let browser, page;
try {
  await wait(() => fetch(origin).then(r => r.ok, () => false), 'preview');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(id => {
    localStorage.setItem('swarm.selectedBot', id);
    window.EventSource = class {
      static CLOSED = 2;
      constructor() { window.__emit = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
  }, bot.id);
  let releaseStop, delayStop = false, failStop = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ path, body: request.postDataJSON() });
      if (path.endsWith('/interrupt') && failStop) return route.fulfill({ status: 500, json: { error: `Could not stop req_AbCdEf123456` } });
      if (path.endsWith('/interrupt') && delayStop) await new Promise(resolve => { releaseStop = resolve; });
      return route.fulfill({ json: { ok: true } });
    }
    let body = {};
    if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' } };
    else if (path === '/api/bots') body = { bots: [bot], live: [live(true)] };
    else if (path.endsWith('/rows')) body = { generation: 1, rows };
    else if (path.endsWith('/routines')) body = { routines: [] };
    else if (path.endsWith('/coworker-setups')) body = { setups: [] };
    else if (path.endsWith('/tasks')) body = { tasks: [] };
    else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
    else if (path === '/api/needs-you') body = { items: [] };
    else if (path === '/api/computer') body = { computer: { provider: 'local', status: 'absent', screens: [], error: null } };
    else if (path === '/api/models') body = { provider: 'direct', billing: 'api', models: [{ id: 'test/model', name: 'Test model', short: 'Test', author: 'test', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', billing: 'api' }], defaultModel: 'test/model', favourites: [], canFast: false };
    else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
    else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
    else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
    return route.fulfill({ json: body });
  });
  await page.goto(origin);
  const composer = page.locator('.composer__input');
  await composer.waitFor();
  await page.locator('.approval-card').waitFor();
  assert.doesNotMatch(await page.locator('.transcript').innerText(), internal);
  assert.match(await page.locator('.bubble.is-agent').innerText(), /Ask Research/);
  await page.locator('.draft-card').getByRole('button', { name: 'Copy draft', exact: true }).click();
  await page.locator('.draft-card').getByRole('button', { name: 'Copied', exact: true }).waitFor();
  assert.doesNotMatch(await page.evaluate(() => navigator.clipboard.readText()), internal, 'subjectless draft copy is also clean');
  await page.locator('.approval-card').getByRole('button', { name: 'Allow', exact: true }).click();
  await wait(() => writes.some(write => write.path === '/api/approvals/apr_AbCdEf123456'), 'original approval ID');
  await page.locator('.question-option').click();
  await wait(() => writes.some(write => write.body?.answer === `Answer ${ids}`), 'original question answer');
  console.log('PASS R2F-002 rendered assistant, notice, event and card fields; action identifiers preserved');

  const long = Array.from({ length: 30 }, (_, i) => `Draft line ${i + 1}`).join('\n');
  await composer.fill(long);
  for (const viewport of [{ width: 830, height: 480 }, { width: 1280, height: 900 }, { width: 830, height: 480 }]) {
    await page.setViewportSize(viewport);
    await wait(async () => {
      const box = await page.locator('.composer').boundingBox();
      return !!box && box.height <= viewport.height * 0.18 + 0.5;
    }, `whole composer height at ${viewport.width}x${viewport.height}`);
    const field = await composer.evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    assert.ok(field.scroll > field.height && field.overflow === 'auto', 'long draft scrolls inside');
    assert.equal(await composer.inputValue(), long, 'resize preserves the draft');
    const overflow = await page.locator('.composer').evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.composer__input, .composer__bar, button')].filter(child => {
        const r = child.getBoundingClientRect();
        return r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1;
      }).map(child => child.className);
    });
    assert.deepEqual(overflow, [], 'textarea and controls stay inside the composer');
  }
  await page.screenshot({ path: new URL('composer-830x480.png', evidence).pathname });
  // A long provider label must not push controls outside a capped composer.
  await page.locator('.model-pill__name').evaluate(el => { el.textContent = 'A very long model label with an extended reasoning name'; });
  for (const viewport of [{ width: 830, height: 480 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 760 && await page.locator('.app.pane-list').count()) await page.locator('.pinned__tile').click();
    await composer.waitFor({ state: 'visible' });
    await page.waitForTimeout(100);
    const box = await page.locator('.composer').boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'visible composer has measurable bounds');
    const overflow = await page.locator('.composer').evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.composer__input, .composer__bar, button')].filter(child => {
        const r = child.getBoundingClientRect(); return r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1;
      }).map(child => child.className);
    });
    assert.deepEqual(overflow, [], `long label controls fit ${viewport.width}x${viewport.height}`);
  }
  await page.setViewportSize({ width: 830, height: 480 });
  console.log('PASS R3-093 whole composer stays within 18 percent and remeasures on resize');

  await composer.fill('');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(() => composer.evaluate(el => el === document.activeElement), 'focus after Stop');
  await page.keyboard.type('Ready');
  assert.equal(await composer.inputValue(), 'Ready');
  await composer.fill('');
  delayStop = true;
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(() => !!releaseStop, 'delayed Stop request');
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'another-input'; input.setAttribute('aria-label', 'Another input');
    document.body.append(input); input.focus();
  });
  releaseStop();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('textbox', { name: 'Another input' }).evaluate(el => document.activeElement === el), true, 'Stop does not steal moved focus');
  console.log('PASS R3-115 Stop restores focus and respects a later focus choice');
  delayStop = false; failStop = true;
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.composer__error').waitFor();
  assert.doesNotMatch(await page.locator('.composer__error').innerText(), internal, 'composer failure notices hide internal identifiers');
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) { await fs.writeFile(new URL('failure.html', evidence), await page.content()); await page.screenshot({ path: new URL('failure.png', evidence).pathname }); }
  throw error;
} finally { await browser?.close(); server?.kill(); }
