// Local production app with synthetic approvals. No live sign-in or tool execution.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { boxFullyVisible } from './ui-box-assertions.mjs';

const evidence = '.context/approval-icons';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: path.resolve('web'), build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const tools = ['propose_skill', 'manage_skill', 'remember', 'create_task', 'create_routine', 'save_file', 'session_search', 'open_browser', 'computer_click', 'future_builtin_action'];
try {
  for (const width of [320, 390, 500, 768, 1280]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    fixture.bots[0].onboarding = { status: 'active', revision: 1 };
    const approval = (tool, extra = {}) => ({ type: 'card', card: 'approval', approvalId: tool, title: `Allow Fixture Bot to ${tool.replaceAll('_', ' ')}?`, detail: '', tool, args: {}, status: 'pending', ...extra });
    const bodies = [
      ...tools.map(tool => approval(tool)),
      approval('GMAIL_SEND_EMAIL', { toolkit: 'gmail', toolkitName: 'Gmail' }),
      approval('FIXTUREAPP_CREATE_TASK', { toolkit: 'fixtureapp', toolkitName: 'Fixture App', logo: 'https://artwork.example.test/fixture.svg' }),
      approval('UNLISTEDAPP_CREATE_TASK', { toolkit: 'unlistedapp', toolkitName: 'Unlisted App' }),
      approval('mcp_fixture_create_task', { toolkitName: 'Connected server' }),
      { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'Read fixture messages', status: 'pending' },
      { type: 'card', card: 'draft', channel: 'email', to: 'Fixture recipient', text: 'Local draft text', status: 'pending' },
    ];
    fixture.respond = async ({ path }) => {
      if (path.endsWith('/rows')) return { json: { generation: 1, rows: bodies.map((body, index) => ({ botId: 'coordinator', generation: 1, seq: index + 1, updatedSeq: index + 1, kind: 'card', audience: 'user', createdAt: Date.now(), body })) } };
      if (path === '/api/toolkits/icon/fixtureapp') return { contentType: 'image/svg+xml', body: await readFile('web/public/assets/toolkits/github.svg', 'utf8') };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      return null;
    };
    try {
      await page.goto(`${origin}/#bot/coordinator`);
      await page.locator('.draft-card').waitFor();
      const approvals = page.locator('.approval-card');
      assert.equal(await approvals.count(), tools.length + 4);
      for (let index = 0; index < tools.length; index++) {
        const card = approvals.nth(index), tile = card.locator('.card__head > .toolkit-logo');
        assert.equal(await tile.locator('svg').count(), 1, `${tools[index]} has an SVG icon`);
        assert.equal(await tile.locator('.toolkit-logo__letter').count(), 0);
        assert.equal((await tile.innerText()).trim(), '', 'no single-letter fallback');
        assert.equal(await tile.getAttribute('aria-hidden'), 'true');
        assert.equal(await tile.locator('svg').getAttribute('aria-hidden'), 'true');
        assert.equal(await tile.evaluate(el => getComputedStyle(el).borderRadius), '8.8px');
        await boxFullyVisible(tile, { width: 44, height: 44 });
        assert.equal(await card.locator('.card__title').innerText(), bodies[index].title, 'title remains the action name');
        assert.ok((await card.locator('.card__sub').innerText()).length > 0);
        if (index === 0) await card.screenshot({ path: `${evidence}/skill-${width}-${theme}.png` });
      }
      for (const card of [approvals.nth(tools.length), approvals.nth(tools.length + 1), page.locator('.connect-card')]) {
        const tile = card.locator('.card__head > .toolkit-logo');
        await boxFullyVisible(tile, { width: 44, height: 44 });
        assert.equal(await tile.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true, 'connected apps keep their artwork');
        assert.equal(await tile.locator('svg').count(), 0);
      }
      assert.equal(await approvals.nth(tools.length + 2).locator('.toolkit-logo__letter').innerText(), 'U', 'real app names keep their fallback');
      assert.equal(await approvals.nth(tools.length + 3).locator('.toolkit-logo__letter').innerText(), 'C', 'named MCP servers keep their identity');
      assert.equal(await page.locator('.draft-card__head .toolkit-logo__letter').count(), 0, 'draft headers already use an icon');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(writes.filter(write => !write.path.endsWith('/suggested-apps')), []);
      console.log(`PASS approval icons ${width} ${theme}: internal actions, connected app artwork, app fallback and draft header`);
    } finally { await page.context().close(); }
  }
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
