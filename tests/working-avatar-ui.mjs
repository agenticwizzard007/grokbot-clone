import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const origin = new URL(process.env.UI_ORIGIN || 'http://127.0.0.1:5189');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Use a dedicated local Vite server');
const evidence = process.env.AVATAR_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

const bots = [
  { id: 'nia', name: 'Nia', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob' },
  { id: 'ellis', name: 'Ellis', isPrimary: false, avatarColor: 'violet', avatarShape: 'clover' },
].map(bot => ({
  kind: 'agent', mode: 'personal', generation: 1, unread: 0, lastActivityAt: 0, createdAt: 0,
  description: '', label: '', instructions: '', model: null, effort: 'medium', ...bot,
}));

const at = Date.now() - 60_000;
const senderRow = {
  botId: 'nia', generation: 1, seq: 1, updatedSeq: 1, kind: 'message', audience: 'user', createdAt: at,
  body: { type: 'message', role: 'user', text: 'Research notes for Nia.', from: { kind: 'bot', id: 'ellis', name: 'Ellis' } },
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
      localStorage.setItem('swarm.selectedBot', 'nia');
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
      if (url.pathname === '/api/auth/me') body = { user: { id: 'owner', name: 'Alex', email: 'alex@example.test' } };
      else if (url.pathname === '/api/bots') body = { bots, live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows: url.pathname === '/api/bots/nia/rows' ? [senderRow] : [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname === '/api/team/exchanges') body = { exchanges: url.searchParams.get('botId') === 'nia' ? [exchange] : [], nextBefore: null };
      else if (url.pathname === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (url.pathname === '/api/bots/nia/settings') body = {
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
    const secondary = page.locator('.bot-row').filter({ hasText: 'Ellis' });
    const railSecondary = page.locator('.bot-rail-item[title="Ellis"]');
    const avatar = (host, name) => host.locator(`.bot-avatar[role="img"][aria-label="${name}"]`);
    const moving = locator => locator.locator(`img[src$="flock-working-${theme === 'dark' ? 'night' : 'light'}.svg"]`);
    const idleFlock = locator => locator.locator(`img[src$="${theme === 'dark' ? 'flock-night.svg' : 'flock.svg'}"]`);
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
      await page.waitForFunction(element => element.complete && element.naturalWidth > 0, await moving(locator).elementHandle());
      assert.equal(await locator.locator('.flock-mark__moving:visible').count(), 1);
    };
    const assertMovingPixels = async locator => {
      const first = await moving(locator).screenshot();
      for (let attempt = 0; attempt < 8; attempt++) {
        const later = await moving(locator).screenshot();
        if (!first.equals(later)) return;
      }
      assert.fail(`${theme} working flock stayed on the same frame`);
    };

    await idleFlock(avatar(header, 'Nia')).waitFor();
    await capture('idle');
    await idleShape(avatar(secondary, 'Ellis')).waitFor();
    const ellisIdle = await idleShape(avatar(secondary, 'Ellis')).innerHTML();
    await emit('nia');
    await runningDot(primary).waitFor();
    await capture('nia-working');
    await assertWorking(avatar(primary, 'Nia'));
    await assertWorking(avatar(header, 'Nia'));
    await assertMovingPixels(avatar(header, 'Nia'));
    await emit('nia', { awaiting: { reason: 'Confirm the plan', since: 2 } });
    await runningDot(primary).waitFor({ state: 'hidden' });
    await idleFlock(avatar(primary, 'Nia')).waitFor();
    await idleFlock(avatar(header, 'Nia')).waitFor();
    await emit('nia', { audience: 'internal' });
    assert.equal(await moving(avatar(header, 'Nia')).count(), 0);
    assert.equal(await moving(avatar(primary, 'Nia')).count(), 0);

    await secondary.click();
    await idleShape(avatar(header, 'Ellis')).waitFor();
    await emit('ellis');
    await assertWorking(avatar(secondary, 'Ellis'));
    await assertWorking(avatar(header, 'Ellis'));
    await assertMovingPixels(avatar(header, 'Ellis'));
    await capture('ellis-working');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await assertWorking(avatar(railSecondary, 'Ellis'));
    await emit('nia');
    await assertWorking(avatar(primary, 'Nia'));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idleShape(avatar(railSecondary, 'Ellis')).waitFor();
    await idleShape(avatar(header, 'Ellis')).waitFor();
    await idleFlock(avatar(primary, 'Nia')).waitFor();
    assert.equal(await page.locator('.bot-avatar .flock-mark__moving:visible').count(), 0);
    assert.equal(await idleShape(avatar(railSecondary, 'Ellis')).innerHTML(), ellisIdle);
    await capture('reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await assertWorking(avatar(railSecondary, 'Ellis'));
    await emit('ellis', { awaiting: { reason: '', since: 2 } });
    await idleShape(avatar(railSecondary, 'Ellis')).waitFor();
    await idleShape(avatar(header, 'Ellis')).waitFor();
    await emit('ellis', { audience: 'internal' });
    assert.equal(await moving(avatar(railSecondary, 'Ellis')).count(), 0);
    assert.equal(await moving(avatar(header, 'Ellis')).count(), 0);
    await emit('ellis', { isRunning: false, startedAt: null });
    assert.equal(await idleShape(avatar(railSecondary, 'Ellis')).innerHTML(), ellisIdle);

    // Search and the directory have no working prop. They must follow the Bot in each row,
    // including live updates while the row is already mounted and another Bot is selected.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('dialog', { name: 'Search', exact: true });
    const searchNia = avatar(search, 'Nia');
    const searchEllis = avatar(search, 'Ellis');
    await assertWorking(searchNia);
    await idleShape(searchEllis).waitFor();
    await emit('ellis');
    await assertWorking(searchEllis);
    await emit('nia', { audience: 'internal' });
    await idleFlock(searchNia).waitFor();
    assert.equal(await moving(searchNia).count(), 0);
    await assertWorking(searchEllis);
    await capture('search-working');
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Your Bots', exact: true }).click();
    const directory = page.locator('.bots-view__list');
    const directoryNia = avatar(directory, 'Nia');
    const directoryEllis = avatar(directory, 'Ellis');
    await idleFlock(directoryNia).waitFor();
    await assertWorking(directoryEllis);
    await emit('ellis', { awaiting: { reason: 'Waiting for confirmation', since: 2 } });
    await idleShape(directoryEllis).waitFor();
    assert.equal(await moving(directoryEllis).count(), 0);
    await emit('nia');
    await assertWorking(directoryNia);
    await capture('directory-working');

    // Historical participant shapes remain the static identity, independent of an unrelated live event.
    await directory.getByRole('button', { name: /Nia/ }).click();
    const senderEllis = avatar(page.locator('.sender-label'), 'Ellis');
    const participants = page.locator('.agent-exchange__avatars');
    const exchangeEllis = avatar(participants, 'Ellis');
    const exchangeNia = avatar(participants, 'Nia');
    await idleShape(senderEllis).waitFor();
    await idleShape(exchangeEllis).waitFor();
    assert.equal(await moving(senderEllis).count(), 0);
    assert.equal(await moving(exchangeEllis).count(), 0);
    await assertWorking(exchangeNia);
    await emit('ellis');
    await assertWorking(senderEllis);
    await assertWorking(exchangeEllis);
    await capture('transcript-working');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idleShape(senderEllis).waitFor();
    await idleShape(exchangeEllis).waitFor();
    assert.equal(await senderEllis.locator('.flock-mark__moving:visible').count(), 0);
    assert.equal(await exchangeEllis.locator('.flock-mark__moving:visible').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await emit('ellis', { audience: 'internal' });
    await idleShape(senderEllis).waitFor();
    await idleShape(exchangeEllis).waitFor();
    assert.equal(await moving(senderEllis).count(), 0);
    assert.equal(await moving(exchangeEllis).count(), 0);

    // A shape preview edits an appearance, not a live identity.
    await header.getByRole('button', { name: 'Nia', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
    await page.getByRole('button', { name: 'Change look', exact: true }).click();
    const shapes = page.getByRole('radiogroup', { name: 'Character shape' });
    const draftAvatar = page.locator('.cfg-look .bot-avatar');
    await idleShape(draftAvatar).waitFor();
    assert.ok(await shapes.locator('.bot-avatar > svg:visible').count() > 1);
    await emit('nia', { isRunning: false, startedAt: null });
    await emit('nia');
    assert.equal(await shapes.locator('.flock-mark__moving').count(), 0);
    assert.equal(await draftAvatar.locator('.flock-mark__moving').count(), 0);
    await capture('static-shapes');
    assert.deepEqual(unexpected, [], `${theme} has no page errors, external requests, or API writes`);
    await page.close();
    console.log(`${theme}: primary and secondary avatars, pixel motion, awaiting/internal exclusions, collapsed rail, reduced motion, search/directory/transcript, static shape picker`);
  }
} finally {
  await browser.close();
}
