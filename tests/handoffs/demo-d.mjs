import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, checkLayout } from './ui-d-fixture.mjs';

const out = path.resolve('.context/ho-d/demo'); fs.mkdirSync(out, { recursive: true });
const report = { mode: 'Seeded local fixture with fetch stubbed; placeholder data only', views: [], journeys: [] };
const f = await fixture();
try {
  for (const width of [390, 1280]) {
    for (const view of ['card', 'sheet', 'row', 'detail', 'viewer', 'list', 'settings']) {
      for (const state of view === 'row' ? ['ready', 'error'] : ['ready', 'loading', 'empty', 'error']) {
        const page = await f.page({ width, view, state });
        try {
          await checkLayout(page);
          const screenshot = path.join(out, `${view}-${state}-${width}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          report.views.push({ width, view, state, screenshot });
          console.log(`PASS demo ${view} ${state} ${width}`);
        } finally { await page.close(); }
      }
    }
    const page = await f.page({ width });
    try {
      await page.getByRole('button', { name: 'Send to agent', exact: true }).click();
      await page.getByRole('button', { name: /^Checker/ }).click();
      await page.screenshot({ path: path.join(out, `send-selected-${width}.png`) });
      await page.evaluate(() => { window.fixture.failOnce = true; });
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('alert').waitFor();
      await page.screenshot({ path: path.join(out, `send-refused-${width}.png`) });
      await page.getByRole('button', { name: 'Send', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.getByText('Sent to Checker', { exact: true }).waitFor();
      assert.equal(await page.locator('dialog[open]').count(), 0);
      const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'POST'));
      assert.equal(calls.length, 2); assert.equal(calls[0].body.idempotencyKey, calls[1].body.idempotencyKey);
      assert.equal(await page.evaluate(() => window.fixture.sent.length), 1);
      await page.screenshot({ path: path.join(out, `receipt-${width}.png`), fullPage: true });
      report.journeys.push({ width, sends: 1, retries: 1, idempotent: true, receipt: 'Sent to Checker, Working', requests: calls });
      console.log(`PASS demo send refusal, retry, double tap, receipt ${width}: 1 handoff`);
    } finally { await page.close(); }
  }
} finally { await f.close(); fs.writeFileSync(path.join(out, 'demo-d.json'), JSON.stringify(report, null, 2)); }
console.log(`PASS ${report.views.length + report.journeys.length}/${report.views.length + report.journeys.length} demo checks; output ${out}/demo-d.json`);
