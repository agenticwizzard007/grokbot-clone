// Production chat, 240 messages including long markdown. Render counters exist only in this local test build.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { composerGeometry, assertComposerSlots } from './composer-layout-helpers.mjs';

const root = path.resolve(process.env.UI_WEB_ROOT || 'web');
const evidence = process.env.UI_EVIDENCE || '.context/composer-performance';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true }, plugins: [{
  name: 'test-render-counts', enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/components/Transcript.tsx')) return;
    const marker = 'export const Transcript = memo(function Transcript({ bot, generation, rows, live, loaded }: Props) {';
    assert.ok(code.includes(marker), 'instrument the real transcript render');
    return code.replace(marker, `${marker}\nwindow.__transcriptRenders = (window.__transcriptRenders || 0) + 1;`);
  },
}] });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
try {
  for (const width of [320, 390, 480, 500, 768, 1280]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    page.setDefaultTimeout(30000);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0];
    bot.onboarding = { status: 'active', revision: 1 };
    const rows = Array.from({ length: 240 }, (_, i) => ({ botId: bot.id, generation: 1, seq: i + 1, updatedSeq: i + 1,
      kind: 'message', createdAt: 1790000000000 + i * 1000,
      body: { type: 'message', role: i % 2 ? 'assistant' : 'user', text: i % 2
        ? `## Report ${i}\n\n${'- **Finding:** local synthetic markdown with a [reference](https://example.test).\n'.repeat(30)}\n| Source | Result |\n| --- | --- |\n| Local | Ready |\n\n\`\`\`js\nconst ready = true;\n\`\`\``
        : `Review fixture report ${i}.` },
    }));
    fixture.respond = ({ path }) => {
      if (path.endsWith('/rows')) return { json: { generation: 1, rows, olderCursor: null } };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      if (path === '/api/models') return { json: { provider: 'codex-cli', billing: 'plan', models: [], favourites: [], canFast: false } };
      return null;
    };
    await page.goto(`${origin}/#bot/${bot.id}`);
    const input = page.locator('.composer__input');
    await input.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-row-seq]').length >= 240);
    await page.locator('.model-pill[title^="Codex · ChatGPT plan"]').waitFor();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await input.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => window.__transcriptRenders);
    await page.evaluate(() => {
      window.__typing = [];
      const input = document.querySelector('.composer__input');
      let start;
      input.addEventListener('keydown', () => { start = performance.now(); }, true);
      window.addEventListener('input', event => {
        if (event.target !== input) return;
        const value = input.value;
        // Run after React's discrete event commit, including layout effects.
        queueMicrotask(() => window.__typing.push({ ms: performance.now() - start, value: input.value, expected: value, sendReady: !!document.querySelector('.composer button[aria-label="Send"]:enabled') }));
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
    const text = 'A local typing performance check keeps the composer responsive while a long conversation stays ready. '.slice(0, 100);
    assert.equal(text.length, 100);
    await input.pressSequentially(text, { timeout: 60000 });
    assert.equal(await input.inputValue(), text, 'all 100 characters appear without waiting for a debounce');
    // Include deferred sizing and its paint in the browser work totals.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
    const { samples, renders } = await page.evaluate(() => ({ samples: window.__typing, renders: window.__transcriptRenders }));
    assert.equal(samples.length, 100);
    assert.ok(samples.every((s, i) => s.value === text.slice(0, i + 1) && s.value === s.expected && s.sendReady), 'each committed value is immediately current');
    const times = samples.map(s => s.ms).sort((a, b) => a - b);
    const result = { width, theme, messages: rows.length, characters: text.length, transcriptRenders: renders - before,
      medianMs: times[50], p95Ms: times[94], maxMs: times[99], metrics: Object.fromEntries(metricsAfter.filter(m => /Duration|LayoutCount|RecalcStyleCount/.test(m.name)).map(m => [m.name, m.value - metricsBefore.find(b => b.name === m.name).value])) };
    results.push(result);
    await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(result));
    assert.ok(renders - before <= 2, '100 edits must not re-render the message list per key; only the wrap transition may update its scroll control');
    await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
    await input.fill('Short');
    const short = await composerGeometry(page);
    await input.fill('A long pasted line. '.repeat(100));
    const long = await composerGeometry(page);
    assertComposerSlots(long, short, 'long pasted draft');
    assert.ok(long.composer.height > short.composer.height, 'wrapped drafts grow');
    assert.ok(long.scrollHeight > long.clientHeight && long.overflow === 'auto', 'long pasted drafts scroll internally');
    await input.fill('');
    const empty = await composerGeometry(page);
    assertComposerSlots(empty, short, 'cleared draft');
    assert.equal(empty.composer.height, short.composer.height);
    await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 900 });
    const resized = await composerGeometry(page);
    await input.fill('First line\nSecond line');
    const newline = await composerGeometry(page);
    assertComposerSlots(newline, resized, 'newline after resize');
    assert.ok(newline.composer.height > resized.composer.height, 'newline grows the same field');
    assert.equal(await input.inputValue(), 'First line\nSecond line', 'resizing preserves the draft');
    await input.fill('Short');
    const restored = await composerGeometry(page);
    assertComposerSlots(restored, resized, 'short after resize');
    assert.equal(restored.composer.height, resized.composer.height);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    await page.context().close();
    console.log(`MEASURE composer typing and growth ${width} ${theme}`);
  }
  for (const result of results) {
    assert.ok(result.p95Ms < 16, `${result.width} ${result.theme}: 95% of keystrokes commit within 16 ms: ${result.p95Ms}`);
    assert.ok(result.maxMs < 100, `${result.width} ${result.theme}: no keystroke stalls: ${result.maxMs}`);
  }
  console.log('PASS composer typing and growth in all viewport/theme combinations');
} finally { await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
