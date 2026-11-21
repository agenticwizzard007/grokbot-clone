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
      if (url.origin !== origin.origin || request.method() !== 'GET') {
        unexpected.push(`${request.method()} ${url.href}`);
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let body = {};
      if (url.pathname === '/api/auth/me') body = { user: { id: 'owner', name: 'Alex', email: 'alex@example.test' } };
      else if (url.pathname === '/api/bots') body = { bots, live: [] };
      else if (url.pathname.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (url.pathname.endsWith('/tasks')) body = { tasks: [] };
      else if (url.pathname.endsWith('/routines')) body = { routines: [] };
      else if (url.pathname.endsWith('/coworker-setups')) body = { setups: [] };
      else if (url.pathname === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (url.pathname === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (url.pathname === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
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
    assert.deepEqual(unexpected, [], `${theme} has no page errors, external requests, or API writes`);
    await page.close();
    console.log(`${theme}: primary and secondary working avatars, idle restore, awaiting, internal, collapsed rail, reduced motion`);
  }
} finally {
  await browser.close();
}
