import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { integrationServer } from './integration-routes-ui.mjs';
import { inspectQuality } from './ui-quality.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';

// Audit the mounted Activity surface with the same guards as HO-P.
const out = path.resolve('.context/fix-5/activity');
fs.mkdirSync(out, { recursive: true });
const server = await integrationServer(out), report = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [320, 390, 500, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    try {
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      await context.addInitScript(() => { localStorage.setItem('swarm.theme', 'system'); localStorage.setItem('swarm.sidebarCollapsed', '1'); });
      await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const page = await context.newPage();
      let malformed = false;
      await page.route(/\/api\/handoffs\?/, route => {
        if (malformed) return route.fulfill({ json: {} });
        const direction = new URL(route.request().url()).searchParams.get('direction');
        const handoffs = [
          { id: 'ho_activity_sent', fromBotId: server.fixture.bot.id, toBotId: server.fixture.checker, instruction: 'Review the release draft.', status: 'completed' },
          { id: 'ho_activity_received', fromBotId: server.fixture.checker, toBotId: server.fixture.bot.id, instruction: 'Apply the review feedback.', status: 'completed' },
        ].filter(handoff => !direction || (direction === 'sent' ? handoff.fromBotId : handoff.toBotId) === server.fixture.bot.id);
        return route.fulfill({ json: { handoffs, next: null } });
      });
      await page.goto(`${server.base}/#bot/${server.fixture.bot.id}/details/activity`);
      const section = page.locator('.layout-section.ho').filter({ has: page.getByRole('heading', { name: 'Handoffs', exact: true }) });
      await section.locator('.ho-receipt').first().waitFor();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await page.evaluate(() => document.fonts.ready);
      for (const direction of ['All', 'Sent', 'Received']) {
        const response = direction === 'All' ? null : page.waitForResponse(r => r.url().includes('/api/handoffs?') && r.url().includes(`direction=${direction.toLowerCase()}`));
        await section.getByRole('button', { name: direction, exact: true }).click();
        if (response) await (await response).finished();
        await page.waitForTimeout(200);
        const text = await section.innerText();
        assert.equal(await section.locator('.ho-receipt').count(), direction === 'All' ? 2 : 1);
        assert.equal(await section.getByRole('button', { name: direction, exact: true }).getAttribute('aria-pressed'), 'true');
        if (direction === 'Sent') assert.doesNotMatch(text, /Handed off from/);
        if (direction === 'Received') assert.doesNotMatch(text, /Sent to/);
        const quality = await page.evaluate(inspectQuality, { selector: '.layout-section.ho' });
        const alignment = await page.evaluate(inspectAlignment);
        assert.deepEqual(quality.issues, [], `${width} ${theme} ${direction} quality`);
        assert.deepEqual(alignment, [], `${width} ${theme} ${direction} alignment`);
        if (width <= 760) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
        report.push({ width, theme, direction, ...quality, alignment });
        console.log(`PASS Activity ${width} ${theme} ${direction}`);
      }
      await section.getByRole('button', { name: 'All', exact: true }).click();
      await section.locator('.ho-receipt').first().waitFor();
      await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
      await page.screenshot({ path: path.join(out, `activity-after-${width}-${theme}.png`), fullPage: true });
      const words = await page.locator('.layout-page').last().innerText();
      report.at(-1).words = words.trim().split(/\s+/).length;
      malformed = true;
      await page.reload();
      await section.getByRole('alert').waitFor();
      assert.equal(await section.getByRole('alert').innerText(), 'Could not load handoffs. Try again.');
      const quality = await page.evaluate(inspectQuality, { selector: '.layout-section.ho' });
      const alignment = await page.evaluate(inspectAlignment);
      assert.deepEqual(quality.issues, []);
      assert.deepEqual(alignment, []);
      if (width <= 760) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      malformed = false;
      await section.getByRole('button', { name: 'Retry', exact: true }).click();
      await section.locator('.ho-receipt').first().waitFor();
      assert.equal(await section.locator('.ho-receipt').count(), 2);
      report.push({ width, theme, state: 'malformed response and retry', ...quality, alignment });
      console.log(`PASS Activity ${width} ${theme} malformed response and retry`);
    } finally { await context.close(); }
  }
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
console.log(`Activity quality: ${report.length}/32 passed`);
