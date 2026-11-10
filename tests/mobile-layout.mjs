// Deterministic checks of the built frontend with an isolated preview server and mocked API responses.
// No provider calls, shared database, or live account changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

await fs.access(new URL('../web/dist/index.html', import.meta.url)).catch(() => { throw new Error('Run npm run build before test:mobile'); });
const port = await new Promise((resolve) => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
// Use the web workspace’s Vite installation.
vite.on('error', () => {});
let logs = '';
vite.stdout.on('data', (s) => { logs += s; });
vite.stderr.on('data', (s) => { logs += s; });
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let n = 0; n < 100; n++) {
    if (await fetch(origin).then((r) => r.ok, () => false)) break;
    if (vite.exitCode !== null) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const bot = { id: 'bot-quinn', name: 'Quinn', label: 'Your primary bot', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', isPrimary: true, pinned: true, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: 'Your team is ready.', lastActivityAt: Date.now(), createdAt: Date.now() };
  const rows = [
    { role: 'user', text: 'Help me plan the week with my team.' },
    { role: 'assistant', text: 'Let’s make this a good week. I can pull together your priorities, review your calendar, and help your team move work forward.\n\nWhat would you like to tackle first?' },
  ].map((body, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1, kind: 'message', body: { type: 'message', ...body }, createdAt: Date.now() - (2 - i) * 60000 }));
  await fs.mkdir(new URL('../.context/apple', import.meta.url), { recursive: true });
  for (const width of [390, 320, 844, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 844 ? 390 : 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce', userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 SwarmNative/1.0' });
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.error(e.message); });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 'user-a', name: 'Alex', email: 'alex@example.com' }, devLogin: false, googleLogin: true };
      else if (url.pathname === '/api/bots') body = { bots: [bot], live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (url.pathname === '/api/events') { await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' }); return; }
      else if (url.pathname === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (url.pathname === '/api/voice/options') body = { voices: [], defaultVoice: 'ara', defaultSpeed: 1, languages: [], speeds: [], configured: false };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    await page.locator('.composer__input').waitFor();
    await page.getByText('Help me plan the week with my team.').waitFor();
    const checkWidth = async (selector) => {
      await page.locator(selector).evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.width > 100 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${width}: ${selector} fits the viewport: ${JSON.stringify(bounds)}`);
    };
    await checkWidth('.chat');
    await checkWidth('.composer');
    assert.equal(await page.locator('.traffic-lights:visible').count(), 0, 'native apps use real window chrome');
    if (width < 761) {
      assert.equal(await page.locator('.sidebar').count(), 0);
      await page.screenshot({ path: `.context/apple/iphone-${width}.png` });
      await page.getByRole('button', { name: 'Open bots', exact: true }).click();
      await page.getByRole('dialog', { name: 'Your bots' }).waitFor();
      await page.getByRole('button', { name: 'Tasks', exact: true }).click();
      assert.equal(await page.locator('.sidebar').count(), 0);
      await page.getByText('No tasks yet', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Open bots', exact: true }).click();
      await page.locator('.pinned__tile').click();
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      await checkWidth('.details');
      await page.getByRole('button', { name: 'Close details', exact: true }).click();
      await page.getByRole('button', { name: 'Open bots', exact: true }).click();
      await page.getByRole('button', { name: 'New Bot', exact: true }).click();
      await page.getByRole('dialog', { name: 'Create New Bot' }).waitFor();
      await checkWidth('.create-modal');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open bots', exact: true }).click();
      await page.locator('.account__btn').click();
      await page.getByRole('menuitem', { name: /Settings/ }).click();
      await checkWidth('.app-settings');
      await checkWidth('.app-settings__main');
      assert.ok(await page.locator('.app-settings__main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'settings content fits horizontally');
      await page.screenshot({ path: `.context/apple/settings-${width}.png` });
      await page.getByRole('button', { name: 'Close settings' }).click();
    } else {
      await page.screenshot({ path: `.context/apple/desktop-${width}.png` });
    }
    await page.locator('.composer__input').fill('A draft that survives returning to the app');
    const before = requests.filter((p) => p.endsWith('/rows')).length;
    await page.evaluate(() => window.dispatchEvent(new Event('swarm:resume')));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.composer__input').inputValue(), 'A draft that survives returning to the app');
    assert.ok(requests.filter((p) => p.endsWith('/rows')).length > before, 'returning to app resyncs messages');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px: navigation, layout, native chrome, and resume`);
  }
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, userAgent: 'Mozilla/5.0 SwarmNative/1.0 (iOS)' });
    let configured = true;
    await page.route('**/api/auth/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: null, devLogin: false, googleLogin: true, appleLogin: configured }) }));
    await page.goto(origin);
    await page.getByRole('link', { name: 'Sign in with Apple' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Sign in with Apple' }).getAttribute('href'), '/api/auth/apple/start');
    assert.equal(await page.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href'), '/api/auth/google/start');
    assert.ok(await page.getByRole('button', { name: 'Continue with phone' }).isVisible());
    assert.equal(await page.getByText('Dev sign-in', { exact: true }).count(), 0);
    await page.screenshot({ path: `.context/apple/signin-all-${width}.png` });
    configured = false;
    await page.reload();
    await page.getByRole('link', { name: 'Sign in with Google' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Sign in with Apple' }).count(), 0, 'unconfigured Apple sign-in is not offered');
    assert.ok(await page.getByRole('button', { name: 'Continue with phone' }).isVisible());
    await page.close();
    console.log(`PASS ${width}px: Apple, Google, and phone options, with configuration gating`);
  }

} finally { await browser?.close(); vite.kill(); }
