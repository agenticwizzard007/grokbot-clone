import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';
import { loopFixture, scenarios } from './ui-e-fixture.mjs';

/** Spec 22 permits a lightweight rule set until UC-H supplies axe. */
export async function accessibility(page) {
  try {
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const report = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(report.violations.filter(violation => ['serious', 'critical'].includes(violation.impact)), [], 'axe serious/critical violations');
    return 'axe';
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  const issues = await page.evaluate(() => {
    const visible = element => element.checkVisibility() && !element.closest('[inert]');
    const issues = [];
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    if (new Set(ids).size !== ids.length) issues.push('Duplicate IDs');
    if (!document.documentElement.lang) issues.push('Missing document language');
    if (!document.title) issues.push('Missing document title');
    if (!document.querySelector('main')) issues.push('Missing main landmark');
    for (const element of [...document.querySelectorAll('button,a[href],input,select,textarea,[role="tab"],[role="dialog"]')].filter(visible)) {
      const name = element.getAttribute('aria-label') || element.textContent.trim() || [...(element.labels || [])].map(label => label.textContent).join(' ') || document.getElementById(element.getAttribute('aria-labelledby'))?.textContent;
      if (!name) issues.push(`Unnamed ${element.tagName}`);
      if (element.hasAttribute('aria-describedby')) for (const id of element.getAttribute('aria-describedby').split(' ')) if (!document.getElementById(id)) issues.push(`Missing description ${id}`);
    }
    for (const list of document.querySelectorAll('ol,ul')) if ([...list.children].some(child => child.tagName !== 'LI')) issues.push('Invalid list structure');
    for (const image of document.querySelectorAll('svg')) if (!image.hasAttribute('aria-hidden') && !image.getAttribute('aria-label')) issues.push('Unnamed image');
    return issues;
  });
  assert.deepEqual(issues, [], 'Accessibility fallback rules');
  return 'fallback';
}

export async function audit(page, { modal = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const selector = modal ? '.ho-loop-sheet' : '#root';
  assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), [], 'Paper alignment');
  await readableWords(page.locator(selector));
  assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1, 'One Back control');
  await accessibility(page);
}

export async function runLayout() {
  const fixture = await loopFixture({ output: '.context/handoffs/ui-e-layout' });
  const results = [];
  try {
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const view = await fixture.page(width, theme), { page } = view;
      await view.open(); await page.getByRole('button', { name: 'New loop', exact: true }).waitFor();
      for (const filter of ['Running', 'Done', 'Stopped']) {
        await page.getByRole('button', { name: filter, exact: true }).click(); await audit(page);
        results.push(`${width} ${theme} list ${filter}`);
      }
      await page.getByRole('button', { name: 'New loop', exact: true }).click(); await audit(page, { modal: true });
      await page.getByText('Advanced', { exact: true }).click(); await audit(page, { modal: true });
      results.push(`${width} ${theme} builder`); await page.keyboard.press('Escape');
      for (const name of Object.keys(scenarios)) {
        await view.open(`#loop/lp_${name}`); await page.getByRole('button', { name: 'Copy details', exact: true }).waitFor(); await audit(page);
        results.push(`${width} ${theme} ${name} timeline`);
        await page.getByRole('tab', { name: 'Graph', exact: true }).click(); await audit(page);
        const overlap = await page.locator('.ho-loop-graph-node').evaluateAll(nodes => nodes.flatMap((node, index) => nodes.slice(index + 1).filter(other => {
          const a = node.getBoundingClientRect(), b = other.getBoundingClientRect();
          return Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1;
        }).map(() => 'Overlapping graph nodes')));
        assert.deepEqual(overlap, []); results.push(`${width} ${theme} ${name} graph`);
        if (name === 'converged') await page.screenshot({ path: path.join(fixture.out, `graph-${width}-${theme}.png`), fullPage: true });
      }
      await view.close();
    }
    fs.writeFileSync(path.join(fixture.out, 'report.json'), JSON.stringify({ pass: results.length, fail: 0, accessibility: 'axe when installed, otherwise spec 22 fallback', results }, null, 2));
    console.log(`PASS HO-E layout: ${results.length} views, 0 alignment or accessibility failures`);
  } finally { await fixture.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await runLayout();
