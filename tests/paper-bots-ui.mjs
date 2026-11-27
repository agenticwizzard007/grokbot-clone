// Paper v3 Bot pages. Only the disposable local server and local fixtures are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
import { inspectAlignment, ROUTES } from './layout-alignment-ui.mjs';

function labelsAndLogos() {
  const roots = [...document.querySelectorAll('.pb-bots:not(.pb-create-backdrop *), .pb-create-panel, .pb-details, .pb-bot-settings, .pb-group-page, .pb-room-members')];
  const issues = [];
  const visible = el => el.checkVisibility() && !el.closest('[inert]') && el.getBoundingClientRect().width > 0;
  for (const root of roots.filter(visible)) {
    for (const el of root.querySelectorAll('button, label, h1, h2, h3, p, span, strong, small, summary, a')) {
      if (!visible(el) || el.closest('pre, .md, textarea, svg')) continue;
      if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) issues.push(`Label overflow: ${el.textContent.trim().slice(0, 70)}`);
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const match of node.textContent.matchAll(/\S+/g)) {
          const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const lines = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top));
          if (new Set(lines).size > 1) issues.push(`Split word: ${match[0]}`);
        }
      }
    }
    for (const logo of root.querySelectorAll('.provider-icon')) {
      if (!visible(logo)) continue;
      const r = logo.getBoundingClientRect(), p = logo.parentElement.getBoundingClientRect();
      if (Math.abs(r.width - 16) > .1 || Math.abs(r.height - 16) > .1 || r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1) issues.push('Provider logo must fit at 16 x 16');
    }
  }
  return [...new Set(issues)];
}
const server = await layoutServer();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = 'docs/design/paper/build/pb-d'; fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync('.context/pb-d', { recursive: true });
const report = [];
const captureNames = { bots: 'bots', 'create-bot': 'create-bot', 'bot-activity': 'bot-activity', 'bot-settings-general': 'bs-general', room: 'room' };
const wordBudgets = { bots: [40, 41], 'create-bot': [67, 49], room: [72, 66], 'bot-activity': [55, 51], 'bot-tasks': [44, 40], 'bot-files': [41, 38], 'bot-setup': [36, 32], 'bot-settings-general': [46, 42], 'bot-settings-skills': [37, 33], 'bot-settings-memories': [45, 41], 'bot-settings-routines': [39, 35], 'bot-settings-analytics': [24, 17], 'bot-settings-learning': [64, 57] };

try {
  for (const width of (process.env.BOT_SIZES || '320,390,500,768,1280').split(',').map(Number)) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(theme => { if (location.origin === 'null') return; localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    for (const route of ROUTES.filter(route => route.owner === 'PB-D')) {
      const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
      await page.goto('about:blank'); await page.goto(server.base + '/' + hash); await page.locator('.shell-header').waitFor(); await page.waitForTimeout(350);
      const issues = await page.evaluate(labelsAndLogos);
      const words = await page.locator('.shell-content').evaluate(el => [...el.children].filter(child => !child.matches('.phone-tabs') && child.checkVisibility()).map(child => child.innerText).join(' ').trim().split(/\s+/).filter(Boolean).length);
      if ([390, 1280].includes(width) && wordBudgets[route.name] && words > wordBudgets[route.name][width === 390 ? 1 : 0]) issues.push(`Copy budget: ${words} words`);
      if ([390, 1280].includes(width)) issues.push(...await page.evaluate(inspectAlignment, {}));
      if (width <= 760 && route.name !== 'bots') {
        const backs = await page.getByRole('button', { name: /^Back(?: |$)/ }).all();
        assert.equal((await Promise.all(backs.map(b => b.isVisible()))).filter(Boolean).length, 1, `${route.name}: exactly one phone Back`);
      }
      if (route.name === 'bots') {
        assert.equal(await page.locator('.pb-bots__grid > [data-layout="card"]').count(), 2);
        assert.ok(await page.getByRole('heading', { name: 'Rooms', exact: true }).isVisible());
        const cards = await page.locator('.pb-bots__grid > [data-layout="card"]').evaluateAll(cards => cards.map(card => ({ width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height })));
        assert.ok(Math.abs(cards[0].width - cards[1].width) <= 1, 'Equal Bot card widths');
        if (width > 760) assert.ok(Math.abs(cards[0].height - cards[1].height) <= 1, 'Equal Bot card heights per row');
      }
      if (route.name === 'create-bot') {
        assert.ok(await page.getByRole('button', { name: 'Start a room instead', exact: true }).isVisible());
        assert.ok(await page.getByRole('button', { name: 'Bot model', exact: true }).isVisible());
      }
      if (route.name === 'bot-files') assert.ok(await page.getByText('Saved reports', { exact: true }).isVisible());
      if (route.name === 'bot-activity') {
        const tabs = await page.locator('.pb-bot-tabs button').evaluateAll(items => items.filter(el => el.checkVisibility()).map(el => el.innerText));
        assert.deepEqual(tabs, width <= 760 ? ['Chat', 'Activity', 'Tasks', 'Files', 'Setup'] : ['Chat', 'Activity', 'Tasks', 'Files', 'Setup', 'Settings']);
      }
      if (captureNames[route.name] && ([390, 1280].includes(width) || width === 320 && theme === 'light')) {
        await page.screenshot({ path: `${evidence}/${captureNames[route.name]}-${width}-${theme}.png` });
      }
      report.push({ name: route.name, width, theme, words, issues }); console.log(`${issues.length ? 'FAIL' : 'PASS'} ${route.name} ${width} ${theme}: ${JSON.stringify(issues)}`);
    }
    assert.deepEqual(errors, [], 'No page errors'); await context.close();
  }
} finally { await browser.close(); await server.close(); fs.writeFileSync('.context/pb-d/report.json', JSON.stringify(report, null, 2)); }
assert.equal(report.filter(row => row.issues.length).length, 0, 'Labels, marks, navigation and alignment follow Paper');
console.log(`PASS ${report.length} Bot route views`);
