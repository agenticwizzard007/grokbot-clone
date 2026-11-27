// Regression checks for the auditor itself; these do not stand in for product route coverage.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectAlignment, inspectDashboardGrid, inspectDashboardLabels } from '../../layout-alignment-ui.mjs';
import { inspectScreenQuality } from './screen-quality.mjs';
import { compareKnownIssues } from '../fixtures/uc-p-known-issues.mjs';
import { runSuite } from '../fixtures/harness.mjs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const cases = [];
for (const width of [390, 1280]) for (const height of [44]) cases.push({ name: `control floor ${width} ${height}`, run: async () => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(`<style>:root{--control-h:${height}px}body{margin:0}button{height:${height}px;width:100%}</style><main data-layout="page"><button>Fixture action</button></main>`);
    const issues = await page.evaluate(inspectAlignment, { selector: 'main' });
    assert.equal(issues.some(issue => issue.startsWith('Below')), height < 44);
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
cases.push({ name: 'clipped accessible tables are exempt but visible dashboard labels remain checked', run: async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>.dashboard-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}</style><main><h2>Fixture chart</h2><div class="dashboard-sr-only"><table><caption><span style="display:block;width:1px;overflow:hidden;text-overflow:ellipsis">Fixture data</span></caption><tbody><tr><td>2026-11-21</td><td>0.2512</td></tr></tbody></table></div></main>');
    const audit = () => page.locator('main').evaluate(inspectDashboardLabels);
    assert.deepEqual(await audit(), []);
    await page.locator('.dashboard-sr-only').evaluate(el => { el.style.width = '100px'; el.style.height = '100px'; });
    assert.deepEqual(await audit(), [], 'A table larger than 1px is still fully clipped');
    await page.locator('.dashboard-sr-only').evaluate(el => { el.style.clipPath = 'inset(20%)'; });
    assert.ok((await audit()).length > 0, 'Partial clipping cannot bypass visible label checks');
    await page.locator('.dashboard-sr-only').evaluate(el => { el.style.clipPath = 'none'; });
    assert.ok((await audit()).length > 0, 'The class alone cannot bypass visual label checks');
    await page.locator('.dashboard-sr-only').evaluate(el => { el.style.clipPath = 'inset(50%)'; });
    await page.locator('h2').evaluate(el => { el.style.cssText = 'width:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; });
    assert.ok((await audit()).some(issue => issue.startsWith('truncated label:')));
    await page.locator('h2').evaluate(el => { el.textContent = 'Fixtureword'; el.style.cssText = 'width:20px;overflow-wrap:anywhere'; });
    assert.ok((await audit()).some(issue => issue.startsWith('split word:')));
  } finally { await page.close(); }
} });
const qualityCases = [
  ['readable body and secondary text', '<p>Review the launch email</p><small>Updated today</small>', issues => assert.deepEqual(issues, [])],
  ['decorative glyph is not body text', '<span aria-hidden="true" style="font-size:10px">●</span>', issues => assert.deepEqual(issues, [])],
  ['aria-hidden visible words still count', '<span aria-hidden="true" style="font-size:10px">Working</span>', issues => assert.ok(issues.some(i => i.rule === 'body-text-size'))],
  ['secondary descendants inherit secondary floor', '<div class="dashboard-list-meta"><span style="font-size:13px">Updated today</span></div>', issues => assert.deepEqual(issues, [])],
  ['tiny body text', '<p style="font-size:13px">Review the launch email</p>', issues => assert.ok(issues.some(i => i.rule === 'body-text-size'))],
  ['tiny secondary text', '<small style="font-size:12px">Updated today</small>', issues => assert.ok(issues.some(i => i.rule === 'secondary-text-size'))],
  ['low contrast secondary text', '<small style="color:#aaa">Updated today</small>', issues => assert.ok(issues.some(i => i.rule === 'text-contrast'))],
  ['hidden text is excluded', '<p hidden>mock Fixture PRIVATE QA- undefined null [object</p><p style="clip-path:inset(50%);position:absolute">mock</p><p>Daily summary</p>', issues => assert.deepEqual(issues, [])],
  ['visible SVG labels are included', '<svg><text y="20">mock</text></svg>', issues => assert.ok(issues.some(i => i.rule === 'forbidden-visible-text'))],
  ['nested visible text is included', '<p>Daily <span>mock</span></p>', issues => assert.ok(issues.some(i => i.rule === 'forbidden-visible-text'))],
  ['visible input and placeholder are included', '<input value="PRIVATE"><input placeholder="undefined">', issues => assert.equal(issues.filter(i => i.rule === 'forbidden-visible-text').length, 2)],
  ['button floor and card tokens', '<section data-layout="card" style="padding:12px;border-radius:8px"><button style="height:24px">Save</button></section>', issues => assert.ok(issues.some(i => i.rule === 'control-height') && issues.some(i => i.rule === 'card-paddingTop'))],
  ['group flex contract', '<div data-layout="button-group" style="display:flex"><button>Cancel</button><button>Save</button></div>', issues => assert.equal(issues.filter(i => i.rule === 'button-group-flex').length, 2)],
  ['correct group flex', '<div data-layout="button-group" style="display:flex"><button style="flex:1 1 0">Cancel</button><button style="flex:1 1 0">Save</button></div>', issues => assert.deepEqual(issues, [])],
  ['section style and spacing', '<div data-layout="section" style="gap:5px"><header class="layout-section__header"><h2>Tasks</h2></header></div>', issues => assert.ok(issues.some(i => i.rule === 'spacing-rowGap') && issues.some(i => i.rule === 'section-heading-style'))],
  ['duplicate title', '<div class="shell-header__title">Tasks</div><h1>Tasks</h1>', issues => assert.ok(issues.some(i => i.rule === 'duplicate-screen-title'))],
  ['helper copy limit', '<p class="layout-page__subtitle">This helper sentence has more than eight words on purpose.</p>', issues => assert.ok(issues.some(i => i.rule === 'helper-copy-length'))],
];
for (const term of ['mock', 'Fixture', 'PRIVATE', 'QA-', 'undefined', 'null', '[object']) qualityCases.push([`forbidden text ${term}`, `<p>${term}</p>`, issues => assert.equal(issues.filter(i => i.rule === 'forbidden-visible-text').length, 1)]);
for (const [name, body, verify] of qualityCases) cases.push({ name, run: async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>body{background:#fff;color:#18202a;font:14px/20px Arial}small{font-size:13px}button,input{height:44px}button{font:inherit}</style><main>${body}</main>`);
    verify(await page.evaluate(inspectScreenQuality, { selector: 'main' }));
  } finally { await page.close(); }
} });
cases.push({ name: 'modal excludes inert background and requires one phone Back', run: async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.setContent('<style>body{font:14px Arial}dialog{color:#18202a;background:white}button{height:44px;font:inherit}</style><main><p>mock</p></main><dialog><h1>Widget settings</h1><button>Back</button></dialog>');
    await page.locator('dialog').evaluate(el => el.showModal());
    assert.deepEqual(await page.evaluate(inspectScreenQuality, { selector: 'dialog[open]', phoneBack: true }), []);
    await page.locator('button').evaluate(el => el.remove());
    assert.ok((await page.evaluate(inspectScreenQuality, { selector: 'dialog[open]', phoneBack: true })).some(i => i.rule === 'phone-back-count'));
  } finally { await page.close(); }
} });
cases.push({ name: 'known issue matching rejects new, changed, stale and forbidden violations', run: () => {
  const issue = { rule: 'body-text-size', target: 'p', actual: '12px', expected: '14px minimum' };
  const inventory = { views: { screen: [issue] } };
  assert.deepEqual(compareKnownIssues('screen', [issue], inventory, false), { unexpected: [], stale: [], known: 1 });
  assert.deepEqual(compareKnownIssues('screen', [issue], { findings: { Q001: issue }, views: { screen: ['Q001'] } }, false), { unexpected: [], stale: [], known: 1 });
  assert.throws(() => compareKnownIssues('screen', [], { views: { screen: ['missing'] } }, false), /Unknown UC-P finding/);
  assert.equal(compareKnownIssues('screen', [{ ...issue, actual: '11px' }], inventory, false).unexpected.length, 1);
  assert.equal(compareKnownIssues('screen', [], inventory, false).stale.length, 1);
  assert.equal(compareKnownIssues('screen', [issue], inventory, true).unexpected.length, 1);
  const forbidden = { ...issue, rule: 'forbidden-visible-text' };
  assert.equal(compareKnownIssues('screen', [forbidden], { views: { screen: [forbidden] } }, false).unexpected.length, 1);
} });
try { await runSuite('alignment-auditor', cases, { server: false }); } finally { await browser.close(); }
