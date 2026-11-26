// Local app and HTTP fixtures. No live account or provider access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/model-picker-size';
await mkdir(evidence, { recursive: true });
const vite = await createServer({ root, cacheDir: path.resolve(evidence, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let lastPage;
const inside = (inner, outer, label) => {
  assert.ok(inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1,
    `${label}: ${JSON.stringify({ inner, outer })}`);
};
async function geometry(page) {
  return page.evaluate(() => {
    const box = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    const menu = document.querySelector('.model-menu'), list = menu.querySelector('.mm-list');
    const textBoxes = el => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].map(b => ({ x: b.x, y: b.y, right: b.right, bottom: b.bottom })); };
    return { menu: box(menu), list: box(list), clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
      rows: [...list.querySelectorAll('.mm-row')].map(box), composer: box(document.querySelector('.composer')),
      chip: box(document.querySelector('.model-pill')), chipName: document.querySelector('.model-pill__name').textContent,
      labels: [...document.querySelectorAll('.model-pill__name, .mm-row__name, .mm-row__resolved')].map(el => ({ box: box(el), text: el.textContent, rects: textBoxes(el), overflow: getComputedStyle(el).textOverflow })),
      marks: [...document.querySelectorAll('.model-pill .provider-icon, .mm-row .provider-icon')].map(el => ({ box: box(el), parent: box(el.closest('.model-pill, .mm-row')), width: el.getAttribute('width'), height: el.getAttribute('height') })),
      viewport: { x: 0, y: 0, right: innerWidth, bottom: innerHeight }, pageWidth: document.documentElement.scrollWidth,
    };
  });
}
try {
  for (const width of [320, 390, 500, 768, 1280, 1920]) for (const theme of ['light', 'dark']) for (const mode of ['plan', 'api']) {
    const height = width === 1920 ? 1072 : 900;
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height });
    lastPage = page;
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const names = mode === 'plan'
      ? [['claude/claude-fable-5-2', 'Claude Fable 5 2'], ['claude/claude-opus-5-5', 'Claude Opus 5 5'], ['claude/claude-sonnet-4-6', 'Claude Sonnet 4 6']]
      : [['anthropic/claude-fable-5-2', 'Claude Fable 5 2'], ['google/gemini-2-5-pro', 'Gemini 2 5 Pro'], ['openai/gpt-5-2', 'GPT 5 2']];
    const models = names.map(([id, name]) => ({ id, name, short: name, author: id.startsWith('openai') ? 'openai' : id.startsWith('google') ? 'google' : 'anthropic',
      resolvedModel: id.split('/').pop(), efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', reasoning: true, vision: true, context: 128000, billing: mode }));
    // Six plan rows reproduce the wide-screen cutoff caused by the former 560px cap.
    if (width >= 1280) models.push(...models.map(m => ({ ...m, id: `${m.id}-preview`, name: `${m.name} Preview`, short: `${m.short} Preview` })));
    const bot = fixture.bots[0]; bot.onboarding = { status: 'active', revision: 1 }; bot.model = models[0].id;
    fixture.respond = ({ path: pathname }) => {
      if (pathname === '/api/models') return { json: { provider: mode === 'plan' ? 'claude-cli' : 'openrouter', billing: mode,
        plan: mode === 'plan' ? 'max' : null, canFast: mode === 'api', models, favourites: models.map(m => m.id), defaultModel: models[0].id } };
      if (pathname.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      return null;
    };
    await page.goto(`${origin}/#bot/${bot.id}`);
    const chip = page.locator('.model-pill[aria-busy="false"]'); await chip.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.match(await chip.getAttribute('aria-label'), /Claude Fable 5\.2/);
    assert.match(await chip.getAttribute('title'), /Claude Fable 5\.2/);
    await chip.click(); await page.locator('.mm-row').first().waitFor();
    const label = `${width}-${theme}-${mode}`;
    const g = await geometry(page);
    assert.equal(g.rows.length, models.length);
    inside(g.menu, g.viewport, `${label} menu in viewport`);
    assert.ok(g.menu.bottom <= g.composer.y - 9, `${label} picker clears composer input`);
    assert.ok(g.menu.x <= g.chip.right && g.menu.right >= g.chip.x, `${label} picker anchored to chip`);
    assert.equal(g.scrollHeight, g.clientHeight, `${label} no scroll when content fits`);
    for (const row of g.rows) inside(row, g.list, `${label} complete row`);
    const contentHeight = g.rows.at(-1).bottom - g.rows[0].y + 12;
    assert.ok(Math.abs(g.list.height - contentHeight) <= 1, `${label} list fits its content`);
    assert.ok(g.labels.some(l => l.text.startsWith('Claude Fable 5.2')));
    for (const l of g.labels) {
      assert.notEqual(l.overflow, 'ellipsis');
      for (const rect of l.rects) inside(rect, l.box, `${label} full label ${l.text}`);
    }
    assert.ok(g.marks.length >= models.length + 1, `${label} all provider marks present`);
    for (const mark of g.marks) {
      inside(mark.box, mark.parent, `${label} full logo`);
      assert.ok(mark.box.width >= Number(mark.width) && mark.box.height >= Number(mark.height), `${label} logo not shrunk`);
    }
    assert.ok(g.pageWidth <= width, `${label} page fits viewport`);
    await page.screenshot({ path: `${evidence}/${label}.png` });
    // Search uses the display spelling, including the decimal point.
    await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('Fable 5.2');
    assert.ok(await page.locator('.mm-row').count() >= 1);
    await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('');
    await page.getByRole('button', { name: 'Effort for Claude Fable 5.2', exact: true }).click();
    await page.getByRole('listbox', { name: 'Effort', exact: true }).waitFor();
    assert.match(await page.locator('.mm-back, .mm-effort-model').last().innerText(), /Claude Fable 5\.2/);
    if (width === 1280) {
      // A genuinely short viewport needs scrolling. Every row can still be
      // brought fully into view, and growing the viewport removes the scrollbar.
      await page.keyboard.press('Escape');
      if (await chip.getAttribute('aria-expanded') === 'false') await chip.click();
      await page.setViewportSize({ width, height: 650 });
      await page.waitForFunction(() => {
        const menu = document.querySelector('.model-menu');
        return menu && menu.getBoundingClientRect().bottom <= document.querySelector('.composer').getBoundingClientRect().top - 9;
      });
      const short = await geometry(page);
      inside(short.menu, short.viewport, `${label} short viewport`);
      assert.ok(short.scrollHeight > short.clientHeight, `${label} scroll only when needed`);
      for (const row of await page.locator('.mm-row').all()) {
        await row.scrollIntoViewIfNeeded();
        const g = await geometry(page), box = await row.boundingBox();
        inside({ ...box, right: box.x + box.width, bottom: box.y + box.height }, g.list, `${label} scroll to complete row`);
      }
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => { const list = document.querySelector('.mm-list'); return list.clientHeight === list.scrollHeight; });
      const restored = await geometry(page);
      for (const row of restored.rows) inside(row, restored.list, `${label} restored full row`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    results.push({ label, geometry: g });
    await page.context().close();
    console.log(`PASS model names, complete logos and content-sized picker ${label}`);
  }
  await writeFile(`${evidence}/geometry.json`, JSON.stringify(results, null, 2));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally { await browser.close(); await vite.close(); }
