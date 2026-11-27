import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { clientFixture, signedInPage, patch } from './client-fixture.mjs';

const output = path.resolve('.context/ui-custom/composer');
fs.mkdirSync(output, { recursive: true });
const server = await clientFixture();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
try {
  for (const width of [390, 1280]) {
    const { context, page } = await signedInPage(browser, server, width);
    await patch(page, [{ op: 'replace', path: '/theme/font/scale', value: 'default' }]);
    await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);
    const input = page.locator('.composer__input:not([disabled])');
    await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const draft = 'First line\nSecond line';
    await input.fill(draft);
    // Save the element identity so a reload or remount cannot hide stale measurement.
    await input.evaluate(el => { window.fixtureComposer = el; });
    const inspect = async (lineHeight, lines, overflow) => {
      await page.waitForFunction(({ lineHeight, lines, overflow }) => {
        const el = document.querySelector('.composer__input:not([disabled])');
        const style = el && getComputedStyle(el);
        return el === window.fixtureComposer && Number.parseFloat(style.lineHeight) === lineHeight
          && Math.abs(el.getBoundingClientRect().height - lineHeight * lines) < 1
          && style.overflowY === overflow;
      }, { lineHeight, lines, overflow });
    };
    for (const [scale, lineHeight] of [['large', 27], ['xlarge', 30], ['default', 24]]) {
      await patch(page, [{ op: 'replace', path: '/theme/font/scale', value: scale }]);
      await inspect(lineHeight, 2, 'hidden');
      assert.equal(await input.inputValue(), draft);
      report.push({ width, check: `Live ${scale} preserves and resizes a two-line draft` });
    }
    const longDraft = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join('\n');
    await input.fill(longDraft);
    await inspect(24, 6, 'auto');
    await patch(page, [{ op: 'replace', path: '/theme/font/scale', value: 'xlarge' }]);
    await inspect(30, 6, 'auto');
    assert.equal(await input.inputValue(), longDraft);
    report.push({ width, check: 'Six-line cap and scrolling scale with an existing draft' });
    await page.screenshot({ path: path.join(output, `xlarge-${width}.png`) });
    await input.fill('Short draft');
    await inspect(30, 1, 'hidden');
    report.push({ width, check: 'Deleting text shrinks the composer and removes scrolling' });
    // Font family changes can reflow an existing paragraph without changing its width.
    await input.fill('A sample paragraph with several words to wrap across the available composer width.');
    for (const font of ['mono', 'serif']) {
      await patch(page, [{ op: 'replace', path: '/theme/font/ui', value: font }]);
      await page.waitForFunction(() => {
        const el = window.fixtureComposer;
        const probe = el.cloneNode();
        probe.value = el.value;
        const style = getComputedStyle(el);
        Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', font: style.font,
          letterSpacing: style.letterSpacing, padding: style.padding, border: '0', boxSizing: 'border-box',
          width: `${el.getBoundingClientRect().width}px`, height: '0', minHeight: '0', maxHeight: 'none' });
        document.body.append(probe);
        const expected = Math.min(180, Math.ceil(probe.scrollHeight / 30) * 30);
        probe.remove();
        return Math.abs(el.getBoundingClientRect().height - expected) < 1;
      });
    }
    report.push({ width, check: 'Live font family changes remeasure wrapped text' });
    await patch(page, [{ op: 'replace', path: '/theme/font/ui', value: 'inter' }]);
    await context.close();
  }
  for (const result of report) console.log(`PASS composer ${result.width}: ${result.check}`);
  console.log(`Live composer: ${report.length}/12 passed`);
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
