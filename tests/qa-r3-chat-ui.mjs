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
  let releaseStop, delayStop = false, failStop = false, planModel = false;
  const longModelName = 'A very long model label with an extended reasoning name';
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
    else if (path === '/api/models') body = planModel
      ? { provider: 'claude-cli', billing: 'plan', models: [{ id: 'claude/test', name: longModelName, short: longModelName, author: 'anthropic', efforts: ['none', 'medium'], defaultEffort: 'none', billing: 'plan', reasoning: true }], defaultModel: 'claude/test', favourites: [], canFast: false }
      : { provider: 'direct', billing: 'api', models: [{ id: 'test/model', name: 'Test model', short: 'Test', author: 'test', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', billing: 'api' }], defaultModel: 'test/model', favourites: [], canFast: false };
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
    // CSS clamps the outer box before resize/ResizeObserver remeasures the textarea.
    await wait(() => page.locator('.composer').evaluate((el, maxHeight) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.height <= maxHeight
        && [...el.querySelectorAll('.composer__input, .composer__bar, button')].every(child => {
          const r = child.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
            && r.left >= box.left - 1 && r.right <= box.right + 1;
        });
    }, viewport.height * 0.18 + 0.5), `whole composer and controls after resize to ${viewport.width}x${viewport.height}`);
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
  // Use a real plan catalog with a long model name and the longest current effort label.
  planModel = true;
  await page.locator('.model-pill').click();
  await page.locator('.model-pill__name').getByText(longModelName, { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const assertPill = async () => {
    const parts = await page.locator('.model-pill').evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.model-pill__name, .model-billing, .model-pill__effort')].map(part => {
        const r = part.getBoundingClientRect();
        return { name: part.className, width: r.width, height: r.height, clipped: part.scrollWidth > part.clientWidth + 1,
          inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 };
      });
    });
    assert.equal(parts.length, 3, 'model, billing and effort all remain displayed');
    for (const part of parts) {
      assert.ok(part.width >= 24 && part.height > 0 && part.inside, `${part.name} has readable bounds inside the model pill`);
      if (part.name !== 'model-pill__name') assert.equal(part.clipped, false, `${part.name} stays fully readable`);
    }
    assert.equal(await page.locator('.model-pill__effort').innerText(), 'No thinking', 'exercise the longest current effort label');
    assert.match(await page.locator('.model-pill').getAttribute('aria-label'), /A very long model label with an extended reasoning name, Plan connection, No thinking effort/);
  };
  for (const viewport of [{ width: 830, height: 480 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const enteringPhone = page.viewportSize().width > 760 && viewport.width <= 760;
    await page.setViewportSize(viewport);
    if (enteringPhone) {
      // Resize returns before the media-query listener updates the phone navigation.
      await page.locator('.app.is-mobile.pane-list').waitFor({ state: 'visible' });
      await page.locator('.pinned__tile').click();
    }
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
    await assertPill();
  }
  // Idle, Send and Stop keep the same toolbar space even with a populated plan pill.
  const toolbarGeometry = () => page.evaluate(() => Object.fromEntries(['.composer__bar', '.composer__right', '.model-pill'].map(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return [selector, { x: box.x, width: box.width, height: box.height }];
  })));
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const sendBox = await toolbarGeometry();
  await composer.fill('');
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await assertPill();
  const stopBox = await toolbarGeometry();
  await page.evaluate(botId => window.__emit({ type: 'live', state: { botId, isRunning: false } }), bot.id);
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  await assertPill();
  const idleBox = await toolbarGeometry();
  for (const box of [sendBox, stopBox]) {
    for (const selector of Object.keys(idleBox)) for (const key of ['x', 'width', 'height']) {
      assert.ok(Math.abs(box[selector][key] - idleBox[selector][key]) < 1, `idle reserves Send/Stop space: ${selector} ${key}`);
    }
  }
  assert.equal(await page.locator('.composer__voice > [aria-hidden]').isVisible(), true, 'compact voice keeps its microphone icon');
  await page.screenshot({ path: new URL('composer-plan-320.png', evidence).pathname });
  await page.evaluate(state => window.__emit({ type: 'live', state }), live(true));
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
