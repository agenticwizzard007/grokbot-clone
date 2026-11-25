// Actual Usage, BotSettingsModal General and Details Activity mounts. Local fixtures only.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { zeroDayUsage } from './fixtures/usage-zero-days.mjs';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
process.env.UI_ORIGIN = origin;
const { fixturePage } = await import('./qa-r3-work-fixture.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.env.UI_WEB_ROOT || new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', chunk => logs += chunk); vite.stderr.on('data', chunk => logs += chunk);
after(async () => { await browser?.close(); vite.kill(); });
for (let i = 0; i < 200; i++) {
  if (await fetch(origin).then(r => r.ok, () => false)) break;
  if (i === 199) throw new Error(logs);
  await new Promise(resolve => setTimeout(resolve, 100));
}
browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = process.env.UI_EVIDENCE || '.context/readiness-s';
await mkdir(evidence, { recursive: true });

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`R3 S chart and suggestion mounts at ${width} ${theme}`, async t => {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0];
    bot.description = 'Summarize Slack messages';
    bot.instructions = 'Read Slack and return summaries here. Existing user text: ACTIVE.';
    let mode = 'success', sequence = 0;
    const requests = [];
    fixture.respond = ({ path, request }) => {
      if (path === '/api/usage') return { json: zeroDayUsage };
      if (path.endsWith('/setup')) return { status: 404, json: { error: 'No saved setup' } };
      if (path.endsWith('/files')) return { json: { status: 'ok', path: '', files: [] } };
      if (path.endsWith('/suggested-apps')) {
        requests.push(request.postDataJSON());
        if (mode === 'error') return { status: 503, json: { error: 'Suggestions unavailable. Please retry.' } };
        return { json: { filterVersion: 'purpose-2', hasContext: true, suggestions: [{ slug: 'slack', name: 'Slack', categories: [], noAuth: true, reason: `Fresh Slack result ${++sequence}` }] } };
      }
      return null;
    };
    const fits = async () => assert.deepEqual(await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.bot-settings-page, .bot-detail-section, .usage-page')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className)), [], 'no horizontal overflow');
    const shot = label => page.screenshot({ path: `${evidence}/${width}-${theme}-${label}.png` });
    const general = page.locator('.bot-settings-page').getByRole('region', { name: 'Suggested integrations' });
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    const activity = details.getByRole('region', { name: 'Suggested integrations' });
    const openGeneral = () => page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().openBotSettings('coordinator', 'general'));
    const tab = name => page.getByRole('navigation', { name: 'Bot settings sections' }).getByRole('button', { name, exact: true }).click();
    const fresh = async region => {
      await region.getByText(/^Fresh Slack result \d+$/).waitFor();
      await page.waitForFunction(() => ![...document.querySelectorAll('.suggested-integrations')].some(el => el.textContent.includes('Updating saved suggestions...')));
      assert.doesNotMatch(await region.innerText(), /unavailable|Please retry|Showing saved|Couldn't refresh/);
      await fits();
    };
    const check = (name, work) => t.test(name, async () => {
      try { await work(); } catch (error) {
        console.log(name, error.message, (await page.locator('body').innerText()).slice(-3500));
        await shot('failure'); throw error;
      }
    });
    try {
      await page.goto(`${origin}/#bot/${bot.id}`);
      await page.locator('.chat__bot-details').waitFor();
      await check('zero-cent days and segments have no painted element', async () => {
        await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings('usage'));
        await page.locator('.usage-chart').waitFor();
        await page.locator('.usage-chart').scrollIntoViewIfNeeded();
        const geometry = await page.locator('.usage-chart__plot').evaluate(plot => {
          const baseline = plot.getBoundingClientRect().bottom;
          const paint = el => {
            const s = getComputedStyle(el), r = el.getBoundingClientRect();
            return { height: r.height, bottom: r.bottom, background: s.backgroundColor, border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], shadow: s.boxShadow, outline: s.outlineStyle, before: getComputedStyle(el, '::before').content, after: getComputedStyle(el, '::after').content };
          };
          return { baseline, slots: [...plot.querySelectorAll('.usage-chart__slot')].map(slot => ({ slot: paint(slot), bars: [...slot.querySelectorAll('.usage-chart__col, .usage-chart__seg')].map(paint), ai: slot.querySelectorAll('.is-ai').length, vm: slot.querySelectorAll('.is-vm').length })) };
        });
        await import('node:fs/promises').then(fs => fs.writeFile(`${evidence}/${width}-${theme}-geometry.json`, JSON.stringify(geometry, null, 2)));
        await shot('chart');
        for (const [i, day] of zeroDayUsage.days.entries()) {
          const ai = Number(day.costUsd.toFixed(2)) > 0, vm = Number(day.computerUsd.toFixed(2)) > 0;
          const actual = geometry.slots[i];
          assert.equal(actual.ai, Number(ai), `${day.day} AI segment`);
          assert.equal(actual.vm, Number(vm), `${day.day} computer segment`);
          if (!ai && !vm) {
            assert.deepEqual(actual.bars, [], `${day.day} has no bar or segment box`);
            assert.equal(actual.slot.background, 'rgba(0, 0, 0, 0)');
            assert.deepEqual(actual.slot.border, ['0px', '0px', '0px', '0px']);
            assert.equal(actual.slot.shadow, 'none'); assert.equal(actual.slot.outline, 'none');
            assert.equal(actual.slot.before, 'none'); assert.equal(actual.slot.after, 'none');
          } else {
            assert.ok(actual.bars.every(bar => bar.height > 0 && bar.bottom <= geometry.baseline + 0.1));
          }
        }
        // Real mixed spend keeps its previous size: 2.5 / axis top 3 times the plot height.
        const plotHeight = await page.locator('.usage-chart__cols').evaluate(el => el.getBoundingClientRect().height);
        assert.ok(Math.abs(geometry.slots[0].bars[0].height - plotHeight * 2.5 / 3) < 0.1);
        await fits();
      });
      await page.goto(`${origin}/#bot/${bot.id}`);
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await check('General refreshes a warm cache after an abandoned mount', async () => {
        await openGeneral();
        await general.getByText('Finding relevant apps…').waitFor();
        await tab('Skills'); // Unmount before the debounce, leaving the old loading deadline.
        await page.clock.runFor(6000);
        await page.goto(`${origin}/#bot/${bot.id}`);
        await page.locator('.chat__bot-details').click();
        await activity.waitFor();
        await page.clock.runFor(500);
        await activity.getByText('Slack', { exact: true }).waitFor();
        const before = requests.length;
        const response = page.waitForResponse(response => response.url().endsWith('/suggested-apps'));
        await details.getByRole('button', { name: 'Bot settings', exact: true }).click();
        await general.getByText('Slack', { exact: true }).waitFor();
        await page.clock.runFor(500);
        await response;
        assert.equal(requests.length, before + 1, 'General must issue a fresh request, not immediately reject the expired deadline');
        await fresh(general); await shot('general-fresh');
        assert.equal(await page.getByLabel('Instructions', { exact: true }).inputValue(), bot.instructions, 'saved user text stays unchanged');
      });
      await check('General warm refresh failure is quiet, retries, and survives reload', async () => {
        // A real reload clears the memory cache. The server fixture remains warm.
        await page.reload();
        await general.waitFor(); await page.clock.runFor(500);
        await general.getByText('Slack', { exact: true }).waitFor(); await fresh(general);
        mode = 'error'; await tab('Skills'); await tab('General'); await page.clock.runFor(500);
        await general.getByText("Couldn't refresh.", { exact: false }).waitFor();
        assert.equal(await general.getByText('Slack', { exact: true }).count(), 1);
        assert.doesNotMatch(await general.innerText(), /Suggestions unavailable|Please retry|Showing saved suggestions/);
        assert.equal(await general.locator('[role="alert"], [role="status"]').count(), 0);
        await fits(); await shot('general-cached');
        mode = 'success'; await general.getByRole('button', { name: 'Retry', exact: true }).click(); await page.clock.runFor(500);
        await fresh(general);
      });
      await check('Details uses the same context and keeps valid results on refresh failure', async () => {
        await page.goto(`${origin}/#bot/${bot.id}`);
        if (!await activity.isVisible()) await page.locator('.chat__bot-details').click();
        await activity.waitFor(); await page.clock.runFor(500);
        await activity.getByText('Slack', { exact: true }).waitFor(); await fresh(activity);
        mode = 'error';
        const nav = details.getByRole('navigation', { name: 'Conversation details sections' });
        await nav.getByRole('button', { name: 'Files', exact: true }).click();
        await nav.getByRole('button', { name: 'Activity', exact: true }).click();
        await page.clock.runFor(500);
        await activity.getByText("Couldn't refresh.", { exact: false }).waitFor();
        assert.doesNotMatch(await activity.innerText(), /Suggestions unavailable|Please retry|Showing saved suggestions/);
        assert.equal(await activity.getByText('Slack', { exact: true }).count(), 1);
        await fits(); await shot('activity-cached');
        mode = 'success'; await activity.getByRole('button', { name: 'Retry', exact: true }).click(); await page.clock.runFor(500);
        await fresh(activity);
        assert.ok(requests.every(body => body.description === bot.description && body.instructions === bot.instructions), 'both mounts send identical saved context');
      });
      await check('General draft changes do not show stale results and errors require no results', async () => {
        await openGeneral(); await page.clock.runFor(500);
        await general.getByText('Slack', { exact: true }).waitFor();
        mode = 'error'; await page.getByLabel('About', { exact: true }).fill('Summarize calendar appointments'); await page.clock.runFor(500);
        await general.getByText('Suggestions unavailable. Please retry.', { exact: false }).waitFor();
        assert.equal(await general.locator('.suggested-integration').count(), 0);
        mode = 'success'; await general.getByRole('button', { name: 'Retry', exact: true }).click(); await page.clock.runFor(500);
        await fresh(general);
      });
      assert.deepEqual(errors, []);
      assert.ok(writes.every(write => write.path.endsWith('/suggested-apps')), 'only read-only suggestion POSTs');
    } finally { await page.close(); }
  });
}
