// Full app, local fixtures only. Run with FFF_CASE=jump or status to isolate a finding.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/readiness-fff';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true } });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin, gate } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const connected = { installed: true, authenticated: true, subscription: true };
const status = { runtime: 'server', serverLoginAvailable: true, selected: 'codex', connected: true, device: 'Fixture', providers: { codex: connected, claude: connected } };
const noConnect = async page => assert.equal(await page.getByRole('button', { name: /^Connect (ChatGPT plan|Claude plan|plan)$/ }).count(), 0, 'no unconfirmed Connect action');
const bottom = page => page.waitForFunction(() => { const el = document.querySelector('.transcript'); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
const noJump = async page => { await bottom(page); assert.equal(await page.locator('.jump-btn').count(), 0, 'bottom has no jump bar'); };
const widths = process.env.FFF_WIDTH ? [Number(process.env.FFF_WIDTH)] : [320, 390, 500, 748, 768, 1280];
try {
  for (const width of widths) for (const theme of ['light', 'dark']) {
    if (process.env.FFF_CASE !== 'jump') {
      const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
      await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
      let delay = null, response = status, reads = 0;
      fixture.respond = async ({ path }) => {
        if (path === '/api/cli' || path === '/api/cli/refresh') { reads++; if (delay) await delay.wait; return { json: response }; }
        if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', models: [], favourites: [] } };
        return null;
      };
      await page.goto(`${origin}/#settings/subscriptions`);
      const card = page.getByRole('region', { name: 'Plan connection', exact: true });
      await card.getByText('Connected · Currently in use', { exact: true }).waitFor();
      await page.waitForFunction(() => !!localStorage.getItem('swarm.plan-status.fixture-owner'));
      delay = gate();
      await page.reload();
      await card.getByText('Connected · Currently in use', { exact: true }).waitFor();
      await card.locator('.plan-check-hint').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await noConnect(page);
      const before = await card.boundingBox();
      await page.waitForTimeout(500);
      await noConnect(page);
      await page.screenshot({ path: `${evidence}/status-${width}-${theme}-checking.png` });
      delay.release(); delay = null;
      await page.waitForFunction(() => { const hint = document.querySelector('.plan-check-hint'); return hint && getComputedStyle(hint).visibility === 'hidden'; });
      await frame(page);
      const after = await card.boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) <= 1, `${width} ${theme}: card ${key} stable on completion`);
      await noConnect(page);
      // Check the same cached state through the actual composer chip and plan rows.
      delay = gate();
      await page.goto(`${origin}/#bot/coordinator`);
      await page.reload();
      await page.locator('.model-pill').click();
      await page.getByRole('button', { name: 'Manage plans', exact: true }).click();
      const plans = page.getByRole('region', { name: 'Connect a plan', exact: true });
      await plans.waitFor();
      await noConnect(page);
      assert.equal(await plans.getByText('Connected', { exact: true }).count(), 2);
      const planBox = await plans.boundingBox();
      delay.release(); delay = null;
      await plans.locator('.plan-connections__hint').first().waitFor({ state: 'hidden' });
      assert.deepEqual(await plans.boundingBox(), planBox, 'plan rows reserve their Checking hint');
      // Unknown accounts and failed checks stay neutral and offer Retry.
      await page.evaluate(() => localStorage.removeItem('swarm.plan-status.fixture-owner'));
      delay = gate();
      await page.goto(`${origin}/#settings/subscriptions`);
      await page.reload();
      await card.getByRole('status').getByText('Checking', { exact: true }).waitFor();
      await noConnect(page);
      response = { ...status, statusUnavailable: true };
      delay.release(); delay = null;
      await card.getByRole('button', { name: 'Retry status', exact: true }).waitFor();
      await noConnect(page);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS status ${width} ${theme}: persisted connection, delayed response, stable card, picker, unknown and failed`);
    }
    if (process.env.FFF_CASE !== 'status') for (const length of [2, 80]) {
      const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
      await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
      const bot = fixture.bots[1];
      let rows = Array.from({ length }, (_, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1, kind: 'message', createdAt: Date.now() - 100000 + i * 1000,
        body: { type: 'message', role: i % 2 ? 'assistant' : 'user', text: length < 3 ? 'Short reply.' : `Message ${i + 1}.\n\n${'A local transcript fixture with readable text. '.repeat(7)}` } }));
      let delayed = false;
      fixture.respond = async ({ path }) => {
        if (path.endsWith('/rows')) { if (delayed) await new Promise(resolve => setTimeout(resolve, 500)); return { json: { generation: 1, rows, olderCursor: null } }; }
        if (path === '/api/cli') return { json: status };
        if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', models: [], favourites: [] } };
        return null;
      };
      await page.goto(`${origin}/#bot/${bot.id}`);
      await page.locator(`[data-row-seq="${length}"]`).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await noJump(page);
      delayed = true;
      await page.reload();
      await page.locator(`[data-row-seq="${length}"]`).waitFor();
      await noJump(page);
      if (length > 2) {
        // Reproduce a queued scroll event arriving after content layout grows.
        await page.locator('.transcript').evaluate(el => {
          const extra = document.createElement('div'); extra.style.height = '200px'; extra.style.flexShrink = '0';
          el.firstElementChild.append(extra);
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await frame(page);
        await noJump(page);
        const pane = page.locator('.transcript');
        await pane.hover();
        await page.mouse.wheel(0, -650);
        const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
        await jump.waitFor(); await frame(page);
        const overlap = await page.evaluate(() => {
          const jump = document.querySelector('.jump-btn').getBoundingClientRect(), pane = document.querySelector('.transcript').getBoundingClientRect();
          const intersects = r => jump.left < r.right && jump.right > r.left && jump.top < r.bottom && jump.bottom > r.top;
          const visible = [...document.querySelectorAll('.bubble-wrap')].map(el => el.getBoundingClientRect()).filter(r => r.bottom > pane.top && r.top < pane.bottom);
          const last = visible.at(-1);
          return { composer: intersects(document.querySelector('.composer-area').getBoundingClientRect()), pane: intersects(pane), last: last ? intersects({ left: last.left, right: last.right, top: Math.max(last.top, pane.top), bottom: Math.min(last.bottom, pane.bottom) }) : false };
        });
        assert.deepEqual(overlap, { composer: false, pane: false, last: false });
        await page.screenshot({ path: `${evidence}/jump-${width}-${theme}.png` });
        await jump.click(); await noJump(page);
        await pane.hover(); await page.mouse.wheel(0, -650); await jump.waitFor();
        await page.mouse.wheel(0, 10000); await noJump(page);
        // New messages follow at the bottom, and preserve the reading position above it.
        const append = () => page.evaluate(({ botId, seq }) => window.__emitFixture({ type: 'rows', botId, generation: 1, rows: [{ botId, generation: 1, seq, updatedSeq: seq, kind: 'message', createdAt: Date.now(), body: { type: 'message', role: 'assistant', text: 'New message. '.repeat(30) } }] }), { botId: bot.id, seq: ++rows.length });
        await append(); await page.locator(`[data-row-seq="${rows.length}"]`).waitFor(); await noJump(page);
        await pane.hover(); await page.mouse.wheel(0, -650); await jump.waitFor();
        await append(); await frame(page); assert.equal(await jump.isVisible(), true);
        await jump.click(); await noJump(page);
      }
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS jump ${width} ${theme} ${length}: load, delayed reload, layout race, scrolling, non-overlap and new messages`);
    }
  }
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
