// I16: run against a local Vite dev server with UI_ORIGIN=http://127.0.0.1:5198.
// All API responses are synthetic, and the shared fixture blocks external traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { fixturePage, origin } from './qa-r3-work-fixture.mjs';

const evidence = new URL('../.context/saved-report-width/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const filename = `Synthetic quarterly research report ${'longunbrokenidentifier'.repeat(5)}.md`;
const report = {
  id: 'synthetic-report', botId: 'research-bot', runId: null, jobId: null,
  filename, mimeType: 'text/markdown', size: 4200, sha256: 'a'.repeat(64),
  createdAt: Date.now(), libraryPath: `/${filename}`,
  downloadUrl: '/api/deliverables/artifacts/synthetic-report/download', deliveries: [],
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1280, 1024, 768, 390]) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    fixture.respond = ({ path, method }) => {
      if (method !== 'GET') return;
      if (path === '/api/deliverables/bots/research-bot') return { json: { artifacts: [report] } };
      if (path.endsWith('/files')) return { json: { status: 'ok', path: '', files: [] } };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
    };
    await page.goto(origin);
    await page.locator('.sidebar .bot-row').filter({ hasText: 'Research Bot' }).click();
    await page.getByRole('button', { name: 'Open Research Bot details', exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Files', exact: true }).click();
    await details.getByRole('button', { name: 'View saved reports', exact: true }).click();
    const row = details.getByRole('region', { name: 'Saved reports', exact: true }).getByRole('article');
    const heading = row.getByRole('heading', { name: filename, exact: true });
    await heading.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await row.scrollIntoViewIfNeeded();
    if (width === 1280) {
      assert.ok(await page.locator('.composer__input').isVisible(), '1280: Details remains beside chat');
      const panel = await details.boundingBox();
      assert.ok(panel.width < 400 && panel.x > 0, '1280: exercise the narrow desktop Details panel');
    }
    const metrics = await row.evaluate(element => {
      const body = element.querySelector('.work-row__body');
      const title = body.querySelector('h3');
      const text = title.parentElement;
      const action = body.querySelector('a');
      const box = node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      };
      const range = document.createRange();
      range.selectNodeContents(title);
      return {
        text: box(text), action: box(action), body: box(body),
        lines: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right })),
        fits: [element, body, text, title, action].every(node => node.scrollWidth <= node.clientWidth + 1),
      };
    });
    await page.screenshot({ path: new URL(`saved-report-${width}.png`, evidence).pathname });
    assert.ok(metrics.text.width > metrics.action.width, `${width}: filename track must be wider than action: ${JSON.stringify(metrics)}`);
    // The 390px local baseline includes a 10px scrollbar gutter.
    const previousTextWidth = { 1024: 294, 768: 220, 390: 188 }[width];
    if (previousTextWidth) assert.ok(metrics.text.width >= previousTextWidth - 1, `${width}: preserve the existing filename space: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.lines.length > 1, `${width}: long filename wraps`);
    assert.ok(metrics.lines.every(line => line.left >= metrics.text.left - 1 && line.right <= metrics.text.right + 1), `${width}: every filename line stays inside its text column`);
    assert.ok(metrics.fits, `${width}: row, text and action have no horizontal overflow`);
    assert.ok(metrics.text.right < metrics.action.left && metrics.action.right <= metrics.body.right + 1, `${width}: filename and action stay in separate columns inside the row`);
    assert.ok(metrics.action.height >= 44, `${width}: download keeps its touch target`);
    const download = row.getByRole('link', { name: 'Download report', exact: true });
    assert.equal(await download.getAttribute('href'), report.downloadUrl);
    assert.equal(await download.getAttribute('download'), filename);
    assert.deepEqual(errors, [], `${width}: no browser errors or external requests`);
    assert.deepEqual(writes, [], `${width}: no data changes`);
    console.log(`PASS ${width}px: filename ${metrics.text.width.toFixed(1)}px, action ${metrics.action.width.toFixed(1)}px, wrapped filename stays inside its column`);
    await page.close();
  }
} finally { await browser.close(); }
