import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';

export async function runUiQuality(evidence, runQuality) {
  const script = path.resolve('tests/handoffs/ui-quality.mjs');
  if (!fs.existsSync(script)) {
    const reason = 'HO-P UI quality checker is absent; waiting for ho-p-polish to merge.';
    console.log(`SKIP UI quality: ${reason}`); return { status: 'skip', reason };
  }
  let error;
  try { await (runQuality ?? (await import('../ui-quality.mjs')).runQuality)(); }
  catch (reason) { error = reason.stack || String(reason); }
  const source = path.resolve('.context/ho-p/quality/report.json');
  const checks = fs.existsSync(source) ? JSON.parse(fs.readFileSync(source, 'utf8')) : [];
  const result = { status: error ? 'fail' : 'pass', passed: checks.filter(check => !check.issues.length).length,
    failed: checks.filter(check => check.issues.length).length, ...(error ? { error } : {}), source };
  fs.writeFileSync(path.join(evidence, 'ui-quality.json'), JSON.stringify(result, null, 2));
  console.log(`${error ? 'FAIL' : 'PASS'} HO-P UI quality: ${result.passed} pass, ${result.failed} fail`);
  return result;
}
export async function assertVisibleCopy(page) {
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /mock(?:-iter|-delay)?:|HO-H|gullible|undefined|ATTACK_TOOL/i, 'No harness strings in visible UI');
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'No em or en dashes in visible UI');
}
export async function visualEvidence(page, { finished = false } = {}) {
  await assertVisibleCopy(page);
  const selector = await page.locator('dialog[open]').count() ? 'dialog[open]' : await page.locator('main.paper-shell').count() ? 'main.paper-shell' : '.shell-content > :not(.shell-header):not(.phone-tabs)';
  const alignment = await page.evaluate(inspectAlignment, { selector });
  const result = await page.evaluate(() => {
    const main = ['dialog[open]', '.paper-settings', '.flow-tab', '.ho-route', '.chat', 'main']
      .flatMap(selector => [...document.querySelectorAll(selector)])
      .find(el => el.checkVisibility() && el.getBoundingClientRect().width > 1);
    const text = [];
    if (main) {
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, el = node.parentElement;
        if (!node.textContent.trim() || !el?.checkVisibility() || el.closest('.flow-sr, .sr-only, [aria-hidden="true"]')) continue;
        text.push(node.textContent.trim());
      }
    }
    const words = text.join(' ').split(/\s+/).filter(Boolean).length;
    const issues = [];
    for (const root of document.querySelectorAll('.ho-receipt, .ho-output-card, .ho-loops, .flow-chart, .agents-settings')) {
      for (const el of root.querySelectorAll('*')) {
        if (!el.checkVisibility() || el.closest('.flow-sr, .sr-only, [aria-hidden="true"]')) continue;
        if ([...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 13) issues.push(`Text under 13px: ${el.textContent.trim().slice(0, 60)}`);
      }
    }
    return { words, countedRegion: main?.className || main?.tagName || null, issues: [...new Set(issues)], standard: 'BUILD-SPEC 0b/0c/0d plus HO-P visual quality gate' };
  });
  if (page.viewportSize().width <= 760 && !await page.getByRole('dialog').count()) {
    const count = await page.getByRole('button', { name: 'Back', exact: true }).count();
    if (count !== 1) alignment.push(`Expected one phone Back, found ${count}`);
  }
  let quality = { status: 'skip', reason: 'HO-P UI quality checker has not merged.', issues: [] };
  if (fs.existsSync('tests/handoffs/ui-quality.mjs')) {
    const { inspectQuality } = await import('../ui-quality.mjs');
    const surface = await page.locator('dialog[open]').count() ? 'dialog[open]' : '.ho-route, .flow-tab, .agents-settings, .ho-receipt, .ho-output-card';
    quality = { status: 'checked', ...await page.evaluate(inspectQuality, { selector: surface, finished }) };
  }
  return { ...result, quality, issues: [...result.issues, ...alignment, ...quality.issues] };
}
