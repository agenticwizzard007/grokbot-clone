// Full app fixtures, including the actual DetailsPanel mount. No live login or data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.env.UI_WEB_ROOT || new URL('../web', import.meta.url), stdio: 'ignore' });
const now = Date.now();
const bot = { id: 'readiness-bot', name: 'Summary Bot', description: 'Summarize Slack channels', instructions: 'Post daily summaries to Slack', label: '', mode: 'personal', pinned: true, isPrimary: true, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: '', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' }, avatarColor: 'blue', avatarShape: 'blob' };
const bots = [bot, ...Array.from({ length: 18 }, (_, i) => ({ ...bot, id: `fixture-${i}`, name: `Fixture Bot ${String(i + 1).padStart(2, '0')}`, isPrimary: false, pinned: false, lastActivityAt: now - i - 1 }))];
const paragraph = 'Here is the summary of your project. The team completed the review and recorded the next steps. You can use this report to decide what to work on next. ';
const rows = ['user', 'assistant'].map((role, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1, createdAt: now, kind: 'message', body: { type: 'message', role, text: paragraph.repeat(4) } }));
let browser;
try {
  await mkdir('.context/readiness-m', { recursive: true });
  for (let i = 0; i < 200; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390, timezoneId: 'Asia/Dubai', reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], writes = [], suggestionRequests = [];
    let user = { id: 'readiness-account', name: 'Test account', email: 'fixture@example.test', timezone: null };
    let suggestionMode = 'hang';
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ id, theme }) => {
      localStorage.setItem('swarm.selectedBot', id);
      localStorage.setItem('swarm.theme', theme);
      window.EventSource = class { static CLOSED = 2; constructor() { window.fixtureEvent = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); } close() {} };
    }, { id: bot.id, theme });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (path.endsWith('/suggested-apps')) {
        suggestionRequests.push(request.postDataJSON());
        if (suggestionMode === 'hang') return;
        if (suggestionMode === 'reject') return route.abort('failed');
        if (suggestionMode === 'blank-error') return send({ error: '' }, 503);
        if (suggestionMode === 'empty') return send({ filterVersion: 'purpose-2', suggestions: [], hasContext: true });
        return send({ filterVersion: 'purpose-2', suggestions: [{ slug: 'slack', name: 'Slack', reason: 'Slack is named in this Bot\'s work.', categories: [], noAuth: true }] });
      }
      if (path === '/api/auth/me') {
        if (request.method() === 'PATCH') { writes.push(request.postDataJSON()); user = { ...user, ...request.postDataJSON() }; }
        return send({ user });
      }
      if (request.method() !== 'GET') return send({ ok: true });
      if (path === '/api/auth/sessions') return send({ sessions: [] });
      if (path === '/api/bots') return send({ bots, live: [] });
      if (path.endsWith('/rows')) return send({ generation: 1, rows });
      if (path.endsWith('/routines')) return send({ routines: [] });
      if (path.endsWith('/tasks')) return send({ tasks: [] });
      if (path.endsWith('/coworker-setups')) return send({ setups: [] });
      if (path === '/api/team/exchanges') return send({ exchanges: [], nextBefore: null });
      if (path === '/api/needs-you') return send({ items: [] });
      if (path === '/api/computer') return send({ computer: { provider: 'local', status: 'absent', screens: [], error: null } });
      if (path === '/api/models' || path === '/api/settings/models') return send({ provider: 'codex-cli', billing: 'plan', models: [{ id: 'codex/default', name: 'Codex CLI default', short: 'Codex CLI default', author: 'openai', efforts: [], defaultEffort: null, billing: 'plan', vision: true }], defaultModel: 'codex/default', favourites: ['codex/default'], canFast: false });
      if (path === '/api/settings') return send({ settings: {}, computer: { provider: 'local' } });
      if (path === '/api/voice/options') return send({ voices: [], languages: [], speeds: [], configured: false });
      if (path === '/api/apps') return send({ apps: [], connected: [], categories: [], total: 0 });
      if (path === '/api/messaging') return send({ enabled: true, links: [], line: { number: '+15550101234', channels: ['sms'] }, preferences: { voiceReplies: 'off' }, speech: {}, invites: { allowance: 0 }, whatsapp: null, phoneAuth: { available: false } });
      if (path === '/api/cli') return send({ runtime: 'server', selected: 'codex', connected: true, providers: { codex: { installed: true, authenticated: true }, claude: {} } });
      return send({});
    });
    const fits = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow`);
    await page.goto(`${origin}/#bot/${bot.id}`);
    await page.locator('.bubble.is-agent').waitFor();
    await page.locator('.model-pill').filter({ hasText: 'Codex' }).waitFor();
    const geometry = await page.locator('.bubble.is-agent').evaluate(el => ({ bubble: el.getBoundingClientRect().width, content: el.closest('.transcript__col').getBoundingClientRect().width }));
    console.log(`${width} ${theme} bubble geometry`, geometry);
    if (width === 390) {
      assert.ok(geometry.bubble >= geometry.content * .75, 'long assistant bubble uses at least 75% of content width');
      const userWidth = await page.locator('.bubble.is-user').evaluate(el => el.getBoundingClientRect().width);
      assert.ok(userWidth <= geometry.content * .85 + 1 && userWidth >= geometry.content * .75);
      assert.equal(await page.locator('.model-pill__name').innerText(), 'Codex · ChatGPT plan');
      assert.ok(await page.locator('.model-pill__name').evaluate(el => el.scrollWidth <= el.clientWidth), 'compact label is not truncated');
    } else assert.ok(geometry.bubble <= Math.min(560, geometry.content * .8) + 1, 'desktop bubble cap unchanged');
    assert.match(await page.locator('.model-pill').getAttribute('aria-label'), /Codex CLI default, Uses your ChatGPT plan/);
    await fits('chat');
    await page.screenshot({ path: `.context/readiness-m/chat-${width}-${theme}.png` });
    await page.evaluate(({ botId, now }) => window.fixtureEvent({ type: 'rows', botId, generation: 1, rows: [{ botId, generation: 1, seq: 3, updatedSeq: 3, createdAt: now, kind: 'card', body: { type: 'card', card: 'approval', approvalId: 'zone-confirmation', tool: 'update_profile:timezone', title: 'Change your account time zone to Asia/Dubai?', args: { timezone: 'Asia/Dubai' }, status: 'pending' } }] }), { botId: bot.id, now });
    const confirmation = page.locator('.approval-card');
    await confirmation.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    assert.equal(await confirmation.getByRole('button', { name: 'Always allow', exact: true }).count(), 0, 'account time zone confirmation is for one change only');

    await page.locator('.model-pill').click();
    await page.getByText('Codex picks the model for each request. Uses your ChatGPT plan. Check plan limits in your ChatGPT account.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'View ChatGPT plan usage' }).getAttribute('href'), 'https://chatgpt.com/codex/settings/usage');
    await page.getByRole('button', { name: 'Models & access', exact: true }).click();
    assert.equal(new URL(page.url()).hash, '#settings/subscriptions');
    await page.goto(`${origin}/#bot/${bot.id}`);
    await page.locator('.chat__bot-details').click();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const suggestions = details.getByRole('region', { name: 'Suggested integrations' });
    await suggestions.getByText('Finding relevant apps…').waitFor();
    const started = Date.now();
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 5500 });
    assert.ok(Date.now() - started < 5500, 'actual DetailsPanel reaches a final timeout state');
    assert.equal(await suggestions.getAttribute('aria-busy'), 'false');
    assert.deepEqual(suggestionRequests.at(-1), { description: bot.description, instructions: bot.instructions });
    suggestionMode = 'reject';
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).click();
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    suggestionMode = 'blank-error';
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).click();
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    suggestionMode = 'empty';
    await suggestions.getByRole('button', { name: 'Retry', exact: true }).click();
    await suggestions.getByText('No matching additional apps for this Bot right now.', { exact: true }).waitFor();
    suggestionMode = 'results';
    await page.evaluate(() => window.fixtureEvent({ type: 'connections' }));
    await suggestions.getByText('Slack', { exact: true }).waitFor();
    assert.equal(await suggestions.getByText('Updating saved suggestions...').count(), 0);
    await fits('Details');
    await page.screenshot({ path: `.context/readiness-m/details-${width}-${theme}.png` });
    await page.goto(`${origin}/#settings/account`);
    const zone = page.getByRole('button', { name: 'Time zone', exact: true });
    await zone.waitFor();
    assert.equal(await zone.innerText(), 'Not set (using UTC)');
    assert.equal(writes.length, 0, 'opening the app and Account must not silently save the browser zone');
    await page.getByRole('button', { name: 'Use (UTC+04:00) Dubai', exact: true }).click();
    await zone.filter({ hasText: '(UTC+04:00) Dubai' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.settings-timezone__trigger')?.disabled);
    assert.deepEqual(writes.at(-1), { timezone: 'Asia/Dubai' });
    await zone.click();
    const search = page.getByRole('combobox', { name: 'Search time zones', exact: true });
    await search.fill('Kathmandu');
    await page.getByRole('option', { name: '(UTC+05:45) Kathmandu', exact: true }).waitFor();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await zone.filter({ hasText: 'Kathmandu' }).waitFor();
    assert.deepEqual(writes.at(-1), { timezone: 'Asia/Kathmandu' });
    await page.waitForFunction(() => !document.querySelector('.settings-timezone__trigger')?.disabled);
    await zone.click(); await search.fill('no such zone');
    await page.getByText('No time zones match. Try a city or IANA time zone.', { exact: true }).waitFor();
    await search.fill('Dubai');
    await page.screenshot({ path: `.context/readiness-m/timezone-${width}-${theme}.png` });
    await page.keyboard.press('Escape');
    assert.equal(await zone.evaluate(el => el === document.activeElement), true);
    assert.deepEqual(writes.at(-1), { timezone: 'Asia/Kathmandu' }, 'search does not save a partial value');
    await fits('Account');
    await page.evaluate(() => window.fixtureEvent({ type: 'synopses', timezone: 'Europe/London' }));
    await zone.filter({ hasText: 'London' }).waitFor();
    await page.goto(`${origin}/#settings/messaging`);
    await page.getByText('Enter your number to connect with your Bots. We\'ll text you a code.', { exact: true }).waitFor();
    await page.getByText('Bot number', { exact: true }).waitFor();
    assert.ok(!(await page.locator('.cfg-row__sub').allInnerTexts()).some(text => text.includes('+1555')));
    await fits('Messaging');
    await page.goto(`${origin}/#bots`);
    const lastBot = width === 390 ? page.locator('.sidebar .bot-row').last() : page.locator('.bots-view__item').last();
    await lastBot.waitFor();
    if (width === 390) {
      const scroll = await page.locator('.sidebar').evaluate(el => { el.scrollTop = el.scrollHeight; return { height: el.clientHeight, scroll: el.scrollHeight, innerScroll: el.querySelector('.sidebar__scroll').scrollHeight, innerHeight: el.querySelector('.sidebar__scroll').clientHeight }; });
      assert.ok(scroll.scroll > scroll.height && scroll.innerScroll <= scroll.innerHeight + 1, 'one page scroll reaches Bots and footer');
    } else await lastBot.scrollIntoViewIfNeeded();
    assert.ok(await lastBot.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'last Bot is fully visible after scrolling');
    await fits('Bots');
    await page.screenshot({ path: `.context/readiness-m/bots-${width}-${theme}.png` });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS readiness M ${width} ${theme}: bubbles, model copy, Details timeout/retry, truthful searchable time zone, labelled number, last Bot and overflow`);
  }
} catch (error) { const page = browser?.contexts().at(-1)?.pages().at(-1); if (page) { await page.screenshot({ path: '.context/readiness-m/failure.png' }); console.log((await page.locator('body').innerText()).slice(-3000)); } throw error; } finally { await browser?.close(); vite.kill(); }
