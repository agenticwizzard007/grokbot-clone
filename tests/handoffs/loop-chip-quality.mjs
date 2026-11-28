import assert from 'node:assert/strict';
import { inspectQuality } from './ui-quality.mjs';
import { polishFixture } from './polish-fixture.mjs';

// Exercise the real receipt and browser guard, including the singular summary
// produced when a user stops a loop during its first pass.
const fixture = await polishFixture();
let state;
let passed = 0;
try {
  state = await fixture.open('receipt', 390, 'light');
  const row = state.page.locator('.ho-receipt--loop');
  assert.equal(await row.locator('.ho-chip').count(), 1);
  assert.equal(await row.locator('.ho-receipt-meta .ho-chip').count(), 1);
  const chip = row.locator('.ho-receipt-meta .ho-chip');
  for (const [label, valid] of [
    ['1 pass', true], ['3 passes', true], ['Pass 1 of 3', true],
    ['1 passe', false], ['Loop, 3 passes', false], ['Loading', false], ['', false],
  ]) {
    await chip.evaluate((el, label) => { el.textContent = label; }, label);
    const result = await state.page.evaluate(inspectQuality, { selector: state.selector, finished: true });
    assert.equal(result.issues.some(issue => issue.startsWith('k.loop-chip:')), !valid, `Loop chip ${JSON.stringify(label)}`);
    passed++;
    console.log(`PASS loop chip ${JSON.stringify(label)} is ${valid ? 'accepted' : 'rejected'}`);
  }
} finally {
  await state?.close();
  await fixture.close();
}
console.log(`Loop chip quality: ${passed} pass, 0 fail`);
