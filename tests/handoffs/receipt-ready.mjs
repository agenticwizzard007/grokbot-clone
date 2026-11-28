import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, browserSession, api, poll, screenshot, waitForLoopReceipts } from './e2e/fixture.mjs';
import { startLoop, sentences } from './e2e/loop-journey.mjs';
import { inspectQuality } from './ui-quality.mjs';

const evidence = path.resolve('.context/handoffs/receipt-ready');
const server = await fixture(evidence);
const view = await browserSession(server, 320, { theme: 'dark' });
const { page } = view;
let release;
let passed = 0;
const pass = message => { passed++; console.log(`PASS ${message}`); };
try {
  await page.goto(server.base);
  const loops = [];
  for (const mode of ['converge', 'cap']) {
    const id = await startLoop(page, server.data, mode);
    const loop = await poll(() => api(page, `/loops/${id}`), loop => ['succeeded', 'capped', 'failed'].includes(loop.status), 'Real loop completes');
    assert.equal(loop.resultText, sentences[mode]);
    loops.push(loop); pass(`${mode} real loop completes`);
  }
  const held = new Promise(resolve => { release = resolve; });
  // Delay an older group, not the one the demo is about to expand. Every
  // rendered receipt participates in the quality audit.
  await page.route(`**/api/loops/${loops[0].id}`, async route => { await held; await route.continue(); });
  await page.goto(`${server.base}/#bot/${server.data.maker}`);
  const older = page.locator('.ho-loop-receipt').filter({ has: page.locator(`a[href="#loop/${loops[0].id}"]`) });
  await older.getByRole('status').filter({ hasText: /^Loading$/ }).waitFor();
  const loading = await page.evaluate(inspectQuality, { selector: '.ho-receipt' });
  assert.ok(loading.issues.some(issue => issue.startsWith('k.loop-title:')));
  pass('Strict title guard rejects the unresolved real receipt');
  const expected = { id: loops[1].id, name: loops[1].spec.name };
  let ready = false, captured = false;
  const waiting = waitForLoopReceipts(page, expected).then(() => { ready = true; });
  const capture = screenshot(page, evidence, 'handoff-receipt', 320).then(file => { captured = true; return file; });
  // A bounded observation of the deliberately held response proves the waits
  // do not succeed merely because the target group's button already exists.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(ready, false); pass('Expansion readiness waits for the older group');
  assert.equal(captured, false); pass('Screenshot waits for the older group');
  release();
  const [, file] = await Promise.all([waiting, capture]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file.replace(/\.png$/, '.quality.json'), 'utf8')).issues, []);
  pass('Resolved receipt capture passes the unchanged quality inspector');
  const target = page.locator('.ho-loop-receipt').filter({ has: page.locator(`a[href="#loop/${expected.id}"]`) });
  const title = target.locator('.ho-receipt--loop .layout-row__title');
  await title.evaluate(el => { el.textContent = 'Earlier release draft'; });
  let matched = false;
  const exact = waitForLoopReceipts(page, expected).then(() => { matched = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(matched, false);
  await title.evaluate((el, name) => { el.textContent = name; }, expected.name);
  await exact; pass('Expansion readiness requires the exact loop name');
} finally {
  release?.(); await page.unrouteAll({ behavior: 'wait' });
  await view.close(); await server.close();
}
console.log(`Receipt readiness: ${passed} pass, 0 fail`);
