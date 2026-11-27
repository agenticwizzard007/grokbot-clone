import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';

export async function runUiQuality(evidence) {
  const script = path.resolve('tests/handoffs/ui-quality.mjs');
  if (!fs.existsSync(script)) {
    const reason = 'HO-P UI quality checker is absent; waiting for ho-p-polish to merge.';
    console.log(`SKIP UI quality: ${reason}`); return { status: 'skip', reason };
  }
  const log = path.join(evidence, 'ui-quality.log'), fd = fs.openSync(log, 'w');
  const exit = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', fd, fd], env: process.env });
    child.on('exit', resolve); child.on('error', () => resolve(1));
  });
  fs.closeSync(fd);
  console.log(`${exit === 0 ? 'PASS' : 'FAIL'} HO-P UI quality: ${log}`);
  return { status: exit === 0 ? 'pass' : 'fail', exit, log };
}
export async function assertVisibleCopy(page) {
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /mock(?:-iter|-delay)?:|HO-H|gullible|undefined|ATTACK_TOOL/i, 'No harness strings in visible UI');
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'No em or en dashes in visible UI');
}
export async function visualEvidence(page) {
  await assertVisibleCopy(page);
  const selector = await page.locator('dialog[open]').count() ? 'dialog[open]' : await page.locator('main.paper-shell').count() ? 'main.paper-shell' : '.shell-content > :not(.shell-header):not(.phone-tabs)';
  const alignment = await page.evaluate(inspectAlignment, { selector });
  const result = await page.evaluate(() => {
    const main = document.querySelector('.ho-route, .flow-tab, .chat') ?? document.querySelector('main');
    const words = main?.innerText.trim().split(/\s+/).filter(Boolean).length ?? 0;
    const issues = [];
    for (const root of document.querySelectorAll('.ho-receipt, .ho-output-card, .ho-loops, .flow-chart')) {
      for (const el of root.querySelectorAll('*')) {
        if (!el.checkVisibility() || el.closest('.flow-sr, .sr-only, [aria-hidden="true"]')) continue;
        if ([...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 13) issues.push(`Text under 13px: ${el.textContent.trim().slice(0, 60)}`);
      }
    }
    return { words, issues: [...new Set(issues)], standard: 'BUILD-SPEC 0b/0c/0d plus HO-P visual quality gate' };
  });
  if (page.viewportSize().width <= 760 && !await page.getByRole('dialog').count()) {
    const count = await page.getByRole('button', { name: 'Back', exact: true }).count();
    if (count !== 1) alignment.push(`Expected one phone Back, found ${count}`);
  }
  return { ...result, issues: [...result.issues, ...alignment] };
}
