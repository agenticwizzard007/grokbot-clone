// Regression checks for the auditor itself; these do not stand in for product route coverage.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectAlignment, inspectDashboardGrid } from '../../layout-alignment-ui.mjs';
import { runSuite } from '../fixtures/harness.mjs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const cases = [];
for (const width of [390, 1280]) for (const height of [40, 44, 48]) cases.push({ name: `control floor ${width} ${height}`, run: async () => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(`<style>:root{--control-h:${height}px}body{margin:0}button{height:${height}px;width:100%}</style><main data-layout="page"><button>Fixture action</button></main>`);
    const issues = await page.evaluate(inspectAlignment, { selector: 'main' });
    assert.equal(issues.some(issue => issue.startsWith('Below')), width <= 480 && height < 44);
    await page.locator('button').evaluate(el => { el.style.height = '20px'; });
    assert.ok((await page.evaluate(inspectAlignment, { selector: 'main' })).some(issue => issue.startsWith('Below')));
  } finally { await page.close(); }
} });
for (const width of [320, 390, 500, 768, 1280]) cases.push({ name: `grid spans and height checks ${width}`, run: async () => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const columns = width >= 1024 ? 12 : width >= 481 ? 6 : 2;
  const small = width >= 1024 ? 4 : width >= 481 ? 2 : 1, large = columns - small;
  try {
    await page.setContent(`<style>body{margin:0}.grid{display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:16px}.card{border:1px solid;box-sizing:border-box;height:88px;grid-row:span 1}</style><main data-layout="page" data-page-type="wide"><div class="grid"><section class="card" data-layout="card" style="grid-column:span ${small}">First fixture</section><section class="card" data-layout="card" style="grid-column:span ${large}">Second fixture</section></div></main>`);
    assert.deepEqual(await page.evaluate(inspectDashboardGrid), []);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: 'main' }), [], 'Declared unequal spans are valid');
    if (width >= 1024) {
      await page.locator('main').evaluate(el => { el.dataset.pageType = 'form'; });
      assert.ok((await page.evaluate(inspectAlignment, { selector: 'main' })).some(issue => issue.startsWith('Unequal row card widths')), 'Only wide dashboard Pages permit unequal declared spans');
      await page.locator('main').evaluate(el => { el.dataset.pageType = 'wide'; });
    }
    await page.locator('.card').last().evaluate(el => { el.style.height = '100px'; });
    assert.ok((await page.evaluate(inspectDashboardGrid)).includes('Same-row widget heights differ'));
    await page.locator('.card').last().evaluate(el => { el.style.width = '20px'; });
    assert.ok((await page.evaluate(inspectDashboardGrid)).includes('Dashboard span does not fill its tracks'));
  } finally { await page.close(); }
} });
cases.push({ name: 'ordinary unequal cards remain rejected', run: async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>body{margin:0}.cards{display:flex}.card{height:88px;width:100px}.card+ .card{width:200px}</style><main data-layout="page"><div class="cards"><section class="card" data-layout="card">First fixture</section><section class="card" data-layout="card">Second fixture</section></div></main>');
    assert.ok((await page.evaluate(inspectAlignment, { selector: 'main' })).some(issue => issue.startsWith('Unequal row card widths')));
  } finally { await page.close(); }
} });
try { await runSuite('alignment-auditor', cases, { server: false }); } finally { await browser.close(); }
