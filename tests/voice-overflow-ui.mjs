// Run: node tests/voice-overflow-ui.mjs
// Local Vite app with seeded call state and intercepted APIs. No microphone or audio service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/voice-overflow-ui/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
});
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const waitFor = async predicate => {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the local voice fixture');
};
const bot = {
  id: 'voice-fixture', name: 'Voice fixture', isPrimary: true, kind: 'agent', label: '', description: '', instructions: '',
  avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', pinned: true, effort: 'medium', model: null,
  generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1, onboarding: { status: 'active' },
};
const caption = `Reference copied: ${'R'.repeat(102)}`;
assert.equal(caption.length, 120);
const captions = ['user', 'assistant'].map((role, index) => ({ id: `caption-${index}`, role, text: caption, final: true }));
const approval = { botId: bot.id, seq: 1, body: {
  type: 'card', card: 'approval', approvalId: 'fixture-approval', title: 'Send the test report?',
  detail: 'Send the synthetic report to the test inbox.', tool: 'SEND_REPORT', status: 'pending', args: {},
} };

async function assertInViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, `${selector} has visible bounds`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `${selector} stays inside ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`);
}

async function assertCaptionWidth(page) {
  const dimensions = await page.locator('.vcall__line, .vcall__log').evaluateAll(elements => elements.map(element => ({
    selector: element.className, client: element.clientWidth, scroll: element.scrollWidth,
  })));
  assert.ok(dimensions.length >= 3, 'both caption roles and the transcript are measured');
  for (const dimension of dimensions) {
    assert.ok(dimension.client > 0 && dimension.scroll <= dimension.client, `caption text wraps within its box: ${JSON.stringify(dimension)}`);
  }
  for (const text of await page.locator('.vcall__line').allTextContents()) {
    assert.ok(text.endsWith(caption), 'the complete reference is preserved');
  }
}

let browser;
try {
  await waitFor(async () => {
    if (vite.exitCode !== null) throw new Error(logs);
    return fetch(origin).then(response => response.ok, () => false);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], forbiddenRequests = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(id => {
      localStorage.setItem('swarm.selectedBot', id);
      localStorage.setItem('swarm.detailsOpen', '0');
      window.__audioAttempts = 0;
      const forbidAudio = () => { window.__audioAttempts++; throw new Error('Audio is forbidden in the layout fixture'); };
      navigator.mediaDevices.getUserMedia = forbidAudio;
      window.AudioContext = class { constructor() { forbidAudio(); } };
      window.webkitAudioContext = window.AudioContext;
      window.EventSource = class { close() {} };
    }, bot.id);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin || path.startsWith('/api/voice/') || request.method() !== 'GET') {
        forbiddenRequests.push(`${request.method()} ${url.origin}${path}`);
        return route.abort();
      }
      if (!path.startsWith('/api/')) return route.continue();
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'fixture-user', name: 'Fixture user', email: 'fixture@example.test' } };
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path.endsWith('/suggested-apps')) body = { suggestions: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/needs-you') body = { items: [] };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/models') body = {
        provider: 'direct', billing: 'api', defaultModel: 'test/model', favourites: [], canFast: false,
        models: [{ id: 'test/model', name: 'Test model', short: 'Test', author: 'test', billing: 'api', efforts: ['medium'], defaultEffort: 'medium' }],
      };
      await route.fulfill({ json: body });
    });
    await page.routeWebSocket('**/*', socket => {
      if (new URL(socket.url()).hostname === '127.0.0.1') socket.connectToServer();
      else { forbiddenRequests.push(socket.url()); socket.close(); }
    });
    await page.goto(origin);
    await page.waitForFunction(async () => (await import('/src/store.ts')).useStore.getState().bots.length > 0);
    await page.evaluate(async ({ botId }) => {
      const { useStore } = await import('/src/store.ts');
      useStore.getState().selectBot(botId);
      useStore.setState({ detailsOpen: false });
    }, { botId: bot.id, captions });
    await page.locator('.chat:not([aria-busy]) .composer__input').waitFor();
    await page.evaluate(() => document.fonts.ready);
    // Navigation mounts the call bar with an unmount cleanup. Seed only once the
    // selected chat has mounted, so that cleanup cannot cancel the fixture call.
    await page.evaluate(async ({ botId, captions }) => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { useVoice } = await import('/src/voice/call.ts');
      useVoice.setState({ status: 'live', botId, callId: 'simulated-call', startedAt: Date.now(), muted: true, captions });
    }, { botId: bot.id, captions });
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await assertCaptionWidth(page);
    await assertInViewport(page, '.composer');
    await assertInViewport(page, '.vcall__toggle');
    await page.screenshot({ path: new URL(`captions-${width}.png`, evidence).pathname });
    console.log(`PASS I13: user and assistant references wrap at ${width}x900`);

    if (width === 390) {
      await page.evaluate(async approval => {
        (await import('/src/store.ts')).useStore.getState().upsertRows(approval.botId, 1, [{ ...approval, generation: 1, kind: 'card', audience: 'user', createdAt: Date.now() }]);
      }, approval);
      await page.locator('.transcript .approval-card').waitFor();
      assert.equal(await page.locator('.vcall .card').count(), 0);
      // Resize the same expanded call, matching the reported short-viewport transition.
      for (const height of [460, 900]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(height => innerHeight === height, height);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertInViewport(page, '.composer');
        await assertInViewport(page, '.vcall__toggle');
        await assertInViewport(page, '.vcall__main');
        await assertCaptionWidth(page);
        // Check real hit testing without approving the synthetic request or starting audio.
        await page.getByRole('button', { name: 'Hide transcript', exact: true }).click({ trial: true });
        assert.equal(await page.locator('.vcall .card').count(), 0);
        await assertInViewport(page, '.composer');
        await assertInViewport(page, '.vcall__toggle');
        await page.locator('.composer__input').fill('Keep the synthetic draft');
        await page.screenshot({ path: new URL(`approval-390x${height}.png`, evidence).pathname });
        await page.getByRole('button', { name: 'Hide transcript', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Show transcript', exact: true }).focus();
        await page.keyboard.press('Enter');
        await assertInViewport(page, '.composer');
        await assertInViewport(page, '.vcall__toggle');
        assert.equal(await page.locator('.composer__input').inputValue(), 'Keep the synthetic draft');
        console.log(`PASS I14: chat-only approval, Hide transcript, and composer reachable at 390x${height}`);
      }
      await page.setViewportSize({ width, height: 460 });
      await page.waitForFunction(() => innerHeight === 460);
      await page.locator('.composer__input').fill('Synthetic draft\nSecond line\nThird line');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(async captions => {
        (await import('/src/voice/call.ts')).useVoice.setState({
          captions: Array.from({ length: 8 }, (_, index) => ({ ...captions[index % 2], id: `updated-${index}` })),
        });
      }, captions);
      await page.waitForFunction(() => document.querySelectorAll('.vcall__line').length === 8);
      await assertInViewport(page, '.composer');
      await assertInViewport(page, '.vcall__toggle');
      await assertCaptionWidth(page);
      const scroll = await page.locator('.vcall__log').evaluate(log => ({ top: log.scrollTop, height: log.clientHeight, total: log.scrollHeight }));
      assert.ok(scroll.height > 20 && scroll.total > scroll.height, 'the expanded transcript has usable scroll space');
      assert.ok(Math.abs(scroll.top + scroll.height - scroll.total) <= 1, `new captions scroll the log to the latest text: ${JSON.stringify(scroll)}`);
      await page.locator('.vcall__log').hover();
      await page.mouse.wheel(0, -10000);
      await waitFor(() => page.locator('.vcall__log').evaluate(log => log.scrollTop === 0));
      await page.getByRole('button', { name: 'Hide transcript', exact: true }).click({ trial: true });
      await assertInViewport(page, '.composer');
      await page.evaluate(async approval => (await import('/src/store.ts')).useStore.getState().upsertRows(approval.botId, 1, [{ ...approval, generation: 1, kind: 'card', audience: 'user', createdAt: Date.now(), body: { ...approval.body, status: 'denied' } }]), approval);
      await page.locator('.vcall__requests').waitFor({ state: 'detached' });
      await assertInViewport(page, '.composer');
      await assertInViewport(page, '.vcall__toggle');
      console.log('PASS I14: caption updates, transcript scrolling, multiline draft, and chat approval resolution at 390x460');
    }
    assert.equal(await page.evaluate(() => window.__audioAttempts), 0, 'no microphone or audio context used');
    assert.deepEqual(forbiddenRequests, [], 'no writes, voice services, or external requests');
    assert.deepEqual(errors, [], 'no browser errors');
    await page.close();
  }
} finally {
  await browser?.close();
  vite.kill();
}
