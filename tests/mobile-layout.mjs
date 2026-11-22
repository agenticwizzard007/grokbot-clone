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
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname === '/api/checkins') body = { enabled: false, times: ['09:00'], timezone: 'UTC', timezoneSource: 'utc_fallback', quietHours: [] };
      else if (url.pathname === '/api/checkins/reports') body = { reports: [], nextCursor: 0, hasMore: false };
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
    // Phones open on the Bot list (the home screen); a chat replaces it.
    if (width < 761) {
      await page.locator('.sidebar').waitFor();
      assert.equal(await page.locator('.chat').isVisible(), false, 'phones start on the Bot list');
      await page.screenshot({ path: `.context/apple/iphone-list-${width}.png` });
      await page.locator('.pinned__tile').click();
    }
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
      assert.equal(await page.locator('.sidebar').isVisible(), false, 'a chat replaces the list');
      await page.screenshot({ path: `.context/apple/iphone-${width}.png` });
      const toList = async () => { await page.getByRole('button', { name: /^All Bots/ }).first().click(); await page.locator('.sidebar').waitFor(); };
      await toList();
      await page.getByRole('button', { name: 'Tasks', exact: true }).click();
      assert.equal(await page.locator('.sidebar').isVisible(), false);
      await page.getByText('No tasks yet', { exact: true }).waitFor();
      await toList();
      await page.locator('.pinned__tile').click();
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      await checkWidth('.details');
      await page.locator('.details .setup-paper__close').click();
      await toList();
      await page.getByRole('button', { name: 'New Bot', exact: true }).click();
      await page.getByRole('main', { name: 'Create a Bot' }).waitFor();
      await checkWidth('.setup-create');
      await page.keyboard.press('Escape');
      await page.locator('.account__btn').click();
      await page.getByRole('menuitem', { name: /Settings/ }).click();
      await checkWidth('.app-settings');
      await checkWidth('.app-settings__main');
      assert.ok(await page.locator('.app-settings__main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'settings content fits horizontally');
      await page.screenshot({ path: `.context/apple/settings-${width}.png` });
      // Phones drill in: the list opens a section, and "Settings" goes back to the list.
      await page.locator('.settings-nav__item', { hasText: 'General' }).click();
      await page.getByRole('heading', { name: 'General', level: 1 }).waitFor();
      await page.getByRole('radio', { name: 'Dark' }).waitFor();
      await checkWidth('.app-settings__page');
      assert.ok(await page.locator('.app-settings__main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'settings section fits horizontally');
      await page.getByRole('button', { name: 'Back to Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Back to Bots', exact: true }).first().click();
      // The system back gesture also leaves a chat for the list.
      await page.locator('.pinned__tile').click();
      await page.locator('.composer__input').waitFor();
      await page.goBack();
      await page.locator('.sidebar').waitFor();
      await page.locator('.pinned__tile').click();
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
  // R2F-007: Back on a phone always shows the Bot list, including after Goals and a desktop-to-phone resize.
  {
    const fixture = async (page) => page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 'user-a', name: 'Alex', email: 'alex@example.com' }, devLogin: false, googleLogin: true };
      else if (url.pathname === '/api/bots') body = { bots: [bot], live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows };
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (url.pathname === '/api/events') { await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' }); return; }
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (url.pathname === '/api/voice/options') body = { voices: [], defaultVoice: 'ara', defaultSpeed: 1, languages: [], speeds: [], configured: false };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const goals = (page) => page.getByRole('tab', { name: 'Goals', exact: true }).or(page.getByRole('button', { name: 'Goals', exact: true })).first();
    const listShown = async (page, label) => {
      await page.locator('.sidebar').waitFor();
      assert.equal(await page.locator('.app.is-mobile.pane-list').count(), 1, `${label}: the Bot list is the visible pane`);
      assert.equal(await page.locator('.tasks-view').isVisible().catch(() => false), false, `${label}: Tasks and Goals are not on screen`);
    };
    // Desktop first: Tasks > Goals, then a chat, then the window becomes a phone.
    const page = await browser.newPage({ viewport: { width: 1280, height: 852 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await fixture(page);
    await page.goto(origin);
    await page.locator('.composer__input').waitFor();
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await goals(page).click();
    await page.locator('.pinned__tile').click();
    await page.locator('.composer__input').waitFor();
    await page.setViewportSize({ width: 393, height: 852 });
    await page.locator('.app.is-mobile').waitFor();
    if (await page.locator('.app.pane-list').count()) await page.locator('.pinned__tile').click();
    await page.getByRole('button', { name: /^All Bots/ }).click();
    await listShown(page, '393 after desktop Goals');
    // Phone: list > Tasks > Goals > back; list > chat > back; list > chat > browser Back.
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await goals(page).click();
    await page.getByRole('button', { name: 'Bot list', exact: true }).click();
    await listShown(page, '393 Goals back');
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await goals(page).click();
    await page.locator('.tasks-view').waitFor();
    await page.goBack();
    await listShown(page, '393 Goals browser Back');
    await page.locator('.pinned__tile').click();
    await page.getByRole('button', { name: /^All Bots/ }).click();
    await listShown(page, '393 chat back');
    await page.locator('.pinned__tile').click();
    await page.locator('.composer__input').waitFor();
    await page.goBack();
    await listShown(page, '393 chat browser Back');
    // Resize back to desktop and to a phone again: the layout follows the window.
    await page.setViewportSize({ width: 1280, height: 852 });
    await page.locator('.app:not(.is-mobile)').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.app.is-mobile').waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    console.log('PASS phone Back: Bot list after desktop Goals, phone Goals, chat, and browser Back');
  }
  // R2F-023: small laptop windows (1024x768 and about 1014x759), with Settings open and closed. A long draft
  // never crowds out the conversation and the layout stays inside the window.
  for (const [w, h] of [[1024, 768], [1014, 759]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 'user-a', name: 'Alex', email: 'alex@example.com' }, devLogin: false, googleLogin: true };
      else if (url.pathname === '/api/bots') body = { bots: [bot], live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows };
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (url.pathname === '/api/events') { await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' }); return; }
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (url.pathname === '/api/voice/options') body = { voices: [], defaultVoice: 'ara', defaultSpeed: 1, languages: [], speeds: [], configured: false };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    const input = page.locator('.composer__input');
    await input.waitFor();
    const layout = async (label) => {
      const m = await page.evaluate(() => {
        const box = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, height: r.height, right: r.right }; };
        const el = document.querySelector('.composer__input');
        return { composer: box('.composer'), transcript: box('.transcript'), chat: box('.chat'), clipped: el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'auto' };
      });
      assert.ok(m.composer.bottom <= h + 1 && m.chat.right <= w + 1, `${w}x${h} ${label}: composer inside the window ${JSON.stringify(m)}`);
      assert.ok(m.composer.height <= h * 0.32, `${w}x${h} ${label}: composer stays under a third of the window (${Math.round(m.composer.height)}px)`);
      assert.ok(m.transcript.height >= h * 0.4, `${w}x${h} ${label}: the conversation keeps most of the space (${Math.round(m.transcript.height)}px)`);
      assert.equal(m.clipped, false, `${w}x${h} ${label}: a long draft scrolls instead of being clipped`);
    };
    await layout('empty');
    await input.fill(Array.from({ length: 20 }, (_, i) => `Draft line ${i + 1}`).join('\n'));
    await layout('long draft');
    await page.screenshot({ path: `.context/apple/r2f023-${w}x${h}-chat.png` });
    await page.keyboard.press('Control+,');
    await page.locator('.app.is-app-settings').waitFor();
    await page.screenshot({ path: `.context/apple/r2f023-${w}x${h}-settings.png` });
    assert.ok(await page.locator('.app-settings').evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1), `${w}x${h}: settings fit`);
    await page.getByRole('button', { name: 'Back to chat' }).first().click();
    await page.locator('.app:not(.is-app-settings)').waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.querySelector('.sidebar__scroll')?.getBoundingClientRect().height > 100);
    await layout('after Settings');
    await page.screenshot({ path: `.context/apple/r2f023-${w}x${h}-after-settings.png` });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${w}x${h}: composer height, conversation space, Settings open and closed`);
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
