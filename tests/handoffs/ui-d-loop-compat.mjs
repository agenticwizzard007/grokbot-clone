import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, checkAccessibility, checkLayout } from './ui-d-fixture.mjs';

// Runs both before and after HO-E merges, without importing its absent module.
const available = fs.existsSync('web/src/handoffs/loops/LoopSheet.tsx');
const f = await fixture();
let passed = 0;
try {
  for (const width of [390, 1280]) {
    const page = await f.page({ width, loops: true });
    try {
      await page.getByRole('button', { name: 'Send to agent', exact: true }).click();
      await page.getByRole('button', { name: /^Checker/ }).click();
      const toggle = page.getByLabel('Keep improving', { exact: true });
      if (!available) assert.equal(await toggle.count(), 0);
      else {
        await toggle.check();
        await page.getByLabel('Up to passes', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Up to passes', { exact: true }).inputValue(), '4');
        assert.equal(await page.getByLabel('Checker agent', { exact: true }).inputValue(), 'bot_maker');
        await page.getByRole('button', { name: 'More passes', exact: true }).click();
        await checkLayout(page); await checkAccessibility(page);
        await page.getByRole('button', { name: 'Start loop', exact: true }).evaluate(button => { button.click(); button.click(); });
        await page.waitForFunction(() => window.startedLoop === 'lp_fixture');
        const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.path === '/api/loops'));
        assert.equal(calls.length, 1); assert.equal(calls[0].body.spec.limits.maxIterations, 5);
        assert.equal(calls[0].body.spec.seed.outputRef, 'swarm://output/out_fixture');
        assert.equal(calls[0].body.spec.steps[0].botId, 'bot_checker');
        assert.equal(calls[0].body.spec.steps[1].botId, 'bot_maker');
        assert.equal(await page.getByRole('dialog').count(), 0);
      }
      assert.deepEqual(page.fixtureErrors, []); passed++;
      console.log(`PASS Keep improving ${available ? 'HO-E integration' : 'feature check'} ${width}`);
    } finally { await page.close(); }
  }
} finally { await f.close(); }
console.log(`PASS ${passed}/${passed} Keep improving checks`);
