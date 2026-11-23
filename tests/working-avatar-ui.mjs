import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = new URL(process.env.UI_ORIGIN || 'http://127.0.0.1:5189');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Use a dedicated local Vite server');
const evidence = process.env.AVATAR_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

const bots = [
  { id: 'primary', name: 'Primary Bot', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob' },
  { id: 'research', name: 'Research Bot', isPrimary: false, avatarColor: 'violet', avatarShape: 'clover' },
].map(bot => ({
  kind: 'agent', mode: 'personal', generation: 1, unread: 0, lastActivityAt: 0, createdAt: 0,
  description: '', label: '', instructions: '', model: null, effort: 'medium', ...bot,
}));

const at = Date.now() - 60_000;
const senderRow = {
  botId: 'primary', generation: 1, seq: 1, updatedSeq: 1, kind: 'message', audience: 'user', createdAt: at,
  body: { type: 'message', role: 'user', text: 'Research notes for Primary Bot.', from: { kind: 'bot', id: 'research', name: 'Research Bot' } },
};
const exchange = {
  id: 'avatar-thread', firstSeq: 2, lastSeq: 2, createdAt: at + 1000, messageCount: 1, version: 1,
  participants: bots.map(({ id, name, avatarColor, avatarShape }) => ({ id, name, avatarColor, avatarShape })),
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(7000);
    const unexpected = [];
    page.on('pageerror', error => { unexpected.push(error.message); console.error(error.message); });
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', 'primary');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() {
          window.emitAvatarEvent = state => this.onmessage?.({ data: JSON.stringify({ type: 'live', state }) });
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {}
      };
    }, theme);
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin.origin && url.pathname.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      if (url.origin !== origin.origin || request.method() !== 'GET') {
        unexpected.push(`${request.method()} ${url.href}`);
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' } };
      else if (url.pathname === '/api/bots') body = { bots, live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows: url.pathname === '/api/bots/primary/rows' ? [senderRow] : [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname === '/api/team/exchanges') body = { exchanges: url.searchParams.get('botId') === 'primary' ? [exchange] : [], nextBefore: null };
      else if (url.pathname === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (url.pathname === '/api/bots/primary/settings') body = {
        memories: [], skills: [], routines: [], tasks: [],
        memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
      };
      else if (url.pathname === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (url.pathname === '/api/checkins/reports') body = { reports: [], nextCursor: null, hasMore: false };
      else if (url.pathname === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      return route.fulfill({ json: body });
    });
    await page.goto(origin.href);
    await page.waitForFunction(() => typeof window.emitAvatarEvent === 'function');
    const header = page.locator('.chat__header');
    const primary = page.locator('.pinned__tile');
    const secondary = page.locator('.bot-row').filter({ hasText: 'Research Bot' });
    const railSecondary = page.locator('.bot-rail-item[title="Research Bot"]');
    const avatar = (host, name) => host.locator(`.bot-avatar[role="img"][aria-label="${name}"]`);
    const moving = locator => locator.locator(':scope.bot-avatar--working > svg');
    const idleShape = locator => locator.locator('svg[viewBox]');
    const runningDot = host => host.locator('.status-dot.is-working');
    const emit = async (botId, changes) => page.evaluate(async state => {
      window.emitAvatarEvent(state);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { botId, audience: 'user', isRunning: true, startedAt: Date.now() - 1200, awaiting: null, activity: null, ...changes });
    const capture = async label => {
      if (evidence) await page.screenshot({ path: join(evidence, `${theme}-${label}.png`) });
    };
    const assertWorking = async locator => {
      await moving(locator).waitFor();
      assert.equal(await locator.locator('.flock-mark, .bot-avatar__working').count(), 0);
      assert.equal(await moving(locator).evaluate(el => el.getAnimations().length), 1);
    };
    const assertMovingPixels = async locator => {
      const first = await moving(locator).screenshot();
      for (let attempt = 0; attempt < 8; attempt++) {
        const later = await moving(locator).screenshot();
        if (!first.equals(later)) return;
      }
      assert.fail(`${theme} working avatar stayed on the same frame`);
    };

    await idleShape(avatar(header, 'Primary Bot')).waitFor();
    await capture('idle');
    await idleShape(avatar(secondary, 'Research Bot')).waitFor();
    const researchIdle = await idleShape(avatar(secondary, 'Research Bot')).innerHTML();
    await emit('primary');
    await runningDot(primary).waitFor();
    await capture('primary-working');
    await assertWorking(avatar(primary, 'Primary Bot'));
    await assertWorking(avatar(header, 'Primary Bot'));
    await assertMovingPixels(avatar(header, 'Primary Bot'));
    await emit('primary', { awaiting: { reason: 'Confirm the plan', since: 2 } });
    await runningDot(primary).waitFor({ state: 'hidden' });
    await idleShape(avatar(primary, 'Primary Bot')).waitFor();
    await idleShape(avatar(header, 'Primary Bot')).waitFor();
    for (const host of [primary, header]) assert.equal(await idleShape(avatar(host, 'Primary Bot')).evaluate(el => el.getAnimations().length), 0, 'awaiting input stops the primary avatar pulse');
    await emit('primary', { audience: 'internal' });
    assert.equal(await moving(avatar(header, 'Primary Bot')).count(), 0);
    assert.equal(await moving(avatar(primary, 'Primary Bot')).count(), 0);

    await secondary.click();
    await idleShape(avatar(header, 'Research Bot')).waitFor();
    await emit('research');
    await assertWorking(avatar(secondary, 'Research Bot'));
    await assertWorking(avatar(header, 'Research Bot'));
    await assertMovingPixels(avatar(header, 'Research Bot'));
    await capture('research-working');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await assertWorking(avatar(railSecondary, 'Research Bot'));
    await emit('primary');
    await assertWorking(avatar(primary, 'Primary Bot'));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idleShape(avatar(railSecondary, 'Research Bot')).waitFor();
    await idleShape(avatar(header, 'Research Bot')).waitFor();
    await idleShape(avatar(primary, 'Primary Bot')).waitFor();
    assert.equal(await page.locator('.bot-avatar > svg').evaluateAll(elements => elements.reduce((n, el) => n + el.getAnimations().length, 0)), 0);
    assert.equal(await idleShape(avatar(railSecondary, 'Research Bot')).innerHTML(), researchIdle);
    await capture('reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await assertWorking(avatar(railSecondary, 'Research Bot'));
    await emit('research', { awaiting: { reason: '', since: 2 } });
    await idleShape(avatar(railSecondary, 'Research Bot')).waitFor();
    await idleShape(avatar(header, 'Research Bot')).waitFor();
    for (const host of [railSecondary, header]) assert.equal(await idleShape(avatar(host, 'Research Bot')).evaluate(el => el.getAnimations().length), 0, 'awaiting input stops the secondary avatar pulse');
    await emit('research', { audience: 'internal' });
    assert.equal(await moving(avatar(railSecondary, 'Research Bot')).count(), 0);
    assert.equal(await moving(avatar(header, 'Research Bot')).count(), 0);
    await emit('research', { isRunning: false, startedAt: null });
    assert.equal(await idleShape(avatar(railSecondary, 'Research Bot')).innerHTML(), researchIdle);

    // Search and the directory have no working prop. They must follow the Bot in each row,
    // including live updates while the row is already mounted and another Bot is selected.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('dialog', { name: 'Search', exact: true });
    const searchPrimary = avatar(search, 'Primary Bot');
    const searchResearch = avatar(search, 'Research Bot');
    await assertWorking(searchPrimary);
    await idleShape(searchResearch).waitFor();
    await emit('research');
    await assertWorking(searchResearch);
    await emit('primary', { audience: 'internal' });
    await idleShape(searchPrimary).waitFor();
    assert.equal(await moving(searchPrimary).count(), 0);
    await assertWorking(searchResearch);
    await capture('search-working');
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Your Bots', exact: true }).click();
    const directory = page.locator('.bots-view__list');
    const directoryPrimary = avatar(directory, 'Primary Bot');
    const directoryResearch = avatar(directory, 'Research Bot');
    await idleShape(directoryPrimary).waitFor();
    await assertWorking(directoryResearch);
    await emit('research', { awaiting: { reason: 'Waiting for confirmation', since: 2 } });
    await idleShape(directoryResearch).waitFor();
    assert.equal(await moving(directoryResearch).count(), 0);
    await emit('primary');
    await assertWorking(directoryPrimary);
    await capture('directory-working');

    // Historical participant shapes remain the static identity, independent of an unrelated live event.
    await directory.getByRole('button', { name: /Primary Bot/ }).click();
    const senderResearch = avatar(page.locator('.sender-label'), 'Research Bot');
    const participants = page.locator('.agent-exchange__avatars');
    const exchangeResearch = avatar(participants, 'Research Bot');
    const exchangePrimary = avatar(participants, 'Primary Bot');
    await idleShape(senderResearch).waitFor();
    await idleShape(exchangeResearch).waitFor();
    assert.equal(await moving(senderResearch).count(), 0);
    assert.equal(await moving(exchangeResearch).count(), 0);
    await assertWorking(exchangePrimary);
    await emit('research');
    await assertWorking(senderResearch);
    await assertWorking(exchangeResearch);
    await capture('transcript-working');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idleShape(senderResearch).waitFor();
    await idleShape(exchangeResearch).waitFor();
    assert.equal(await senderResearch.locator(':scope > svg').evaluate(el => el.getAnimations().length), 0);
    assert.equal(await exchangeResearch.locator(':scope > svg').evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await emit('research', { audience: 'internal' });
    await idleShape(senderResearch).waitFor();
    await idleShape(exchangeResearch).waitFor();
    assert.equal(await moving(senderResearch).count(), 0);
    assert.equal(await moving(exchangeResearch).count(), 0);

    // A shape preview edits an appearance, not a live identity.
    await header.getByRole('button', { name: 'Primary Bot', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
    await page.getByRole('button', { name: 'Change look', exact: true }).click();
    const shapes = page.getByRole('radiogroup', { name: 'Character shape' });
    const draftAvatar = page.locator('.cfg-look .bot-avatar');
    await idleShape(draftAvatar).waitFor();
    assert.ok(await shapes.locator('.bot-avatar > svg:visible').count() > 1);
    await emit('primary', { isRunning: false, startedAt: null });
    await emit('primary');
    assert.equal(await shapes.locator('.bot-avatar--working').count(), 0);
    assert.equal(await draftAvatar.locator(':scope.bot-avatar--working').count(), 0);
    await capture('static-shapes');
    assert.deepEqual(unexpected, [], `${theme} has no page errors, external requests, or API writes`);
    await page.close();
    console.log(`${theme}: primary and secondary avatars, pixel motion, awaiting/internal exclusions, collapsed rail, reduced motion, search/directory/transcript, static shape picker`);
  }
} finally {
  await browser.close();
}
