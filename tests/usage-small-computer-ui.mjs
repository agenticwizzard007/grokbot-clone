import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { smallComputerUsage } from './fixtures/usage-small-computer.mjs';

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
browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const evidence = process.env.UI_EVIDENCE || '.context/usage-small-computer';
await mkdir(evidence, { recursive: true });

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`small computer estimates stay above the axis at ${width} ${theme}`, async () => {
    const { page, fixture, errors } = await fixturePage(browser, { width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    fixture.respond = ({ path }) => path === '/api/usage' ? { json: smallComputerUsage } : null;
    const fits = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    try {
      await page.goto(`${origin}/#settings/usage`);
      const plot = page.locator('.usage-chart__plot');
      await plot.scrollIntoViewIfNeeded();
      const geometry = await plot.evaluate(plot => {
        const axis = [...plot.querySelectorAll('.usage-chart__grid')].find(el => el.style.bottom === '0%').getBoundingClientRect();
        const box = el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return { top: r.top, bottom: r.bottom, height: r.height, shadow: s.boxShadow, border: s.borderBottomWidth, outline: s.outlineStyle };
        };
        return { baseline: axis.top, slots: [...plot.querySelectorAll('.usage-chart__slot')].map(slot => ({
          segments: [...slot.querySelectorAll('.usage-chart__seg')].map(box),
          bars: slot.querySelectorAll('.usage-chart__col').length,
        })) };
      });
      await writeFile(`${evidence}/${width}-${theme}.json`, JSON.stringify(geometry, null, 2));
      await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
      await fits();
      for (const [i, day] of smallComputerUsage.days.entries()) {
        const slot = geometry.slots[i];
        const count = Number(Number(day.costUsd.toFixed(2)) > 0) + Number(Number(day.computerUsd.toFixed(2)) > 0);
        assert.equal(slot.segments.length, count, day.day);
        assert.equal(slot.bars, Number(count > 0), `${day.day}: zero-cent days draw nothing`);
        for (const segment of slot.segments) {
          assert.ok(segment.bottom <= geometry.baseline + 0.02, `${day.day}: segment bottom ${segment.bottom} must be above axis ${geometry.baseline}`);
          assert.ok(segment.height >= 1, `${day.day}: visible positive segments are at least 1px`);
          assert.equal(segment.shadow, 'none'); assert.equal(segment.border, '0px'); assert.equal(segment.outline, 'none');
          if (i > 0) assert.ok(segment.height <= 2, `${day.day}: subpixel values use at most 2px`);
        }
      }
      await page.locator('.usage-chart__slot').nth(1).focus();
      assert.match(await page.locator(width === 390 ? '.usage-readout' : '.usage-tip').innerText(), /Only estimated computer cost/);
      await fits();
      await page.getByRole('radio', { name: 'Table', exact: true }).click();
      const table = page.getByRole('region', { name: 'Daily usage table' });
      for (const day of smallComputerUsage.days.slice(1, 6)) {
        const row = table.getByRole('row').filter({ hasText: `Nov ${Number(day.day.slice(-2))}` });
        assert.match(await row.innerText(), new RegExp(`\\$${day.computerUsd.toFixed(2).replace('.', '\\.')}`));
      }
      await fits();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
