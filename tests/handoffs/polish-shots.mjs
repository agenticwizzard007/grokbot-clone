import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { polishFixture } from './polish-fixture.mjs';
import { runQuality } from './ui-quality.mjs';

export async function captureShots({ phase = process.env.HO_POLISH_PHASE || 'after', suffix = process.env.HO_POLISH_SUFFIX || phase, names = (process.env.HO_SHOT_SCREENS || 'receipt-grouped,receipt-expanded,flow-tab,message-actions').split(','), output = process.env.HO_POLISH_OUTPUT || '/workspace/swarm-qa/handoffs/shots/polish' } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await polishFixture(), report = [];
  try {
    for (const name of names) for (const width of name.startsWith('receipt') ? [320,390,500,1280] : [390,1280]) for (const theme of ['light']) {
      const state = await fixture.open(name, width, theme);
      const { page } = state;
      if ((name.startsWith('receipt') || name === 'flow-tab') || name.startsWith('settings-agents')) {
        const height = await page.locator('.transcript, .ho-route, .flow-page, .app-settings__page').evaluateAll(els => Math.max(...els.map(el => el.scrollHeight)));
        if (height > 1000) await page.setViewportSize({width,height:Math.min(5000,height+160)});
      }
      await page.locator(state.selector).first().scrollIntoViewIfNeeded();
      const file = path.join(output, `${name}-${width}${name.startsWith('settings-agents') ? `-${theme}` : ''}-${suffix}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const wordsIn = selector => page.locator(selector).evaluateAll(els => els.map(el => el.innerText).join(' ').trim().split(/\s+/).filter(Boolean).length);
      const words = await wordsIn(name === 'sidebar-loops' ? '.sidebar [role="menu"]' : state.selector);
      const dialog = page.locator('dialog[open], [role="dialog"]:visible');
      const mainWords = await wordsIn(name === 'sidebar-loops' ? '.sidebar [role="menu"]' : await dialog.count() ? 'dialog[open], [role="dialog"]:visible' : await page.locator('.shell-content').count() ? '.shell-content' : '#root');
      const receiptGeometry = await page.locator('.ho-receipt:visible').evaluateAll(rows => rows.map(row => ({ height: row.getBoundingClientRect().height, metaHeight: row.querySelector('.ho-receipt-meta')?.getBoundingClientRect().height })));
      const actionGeometry = await page.locator('.ho-message-actions').evaluateAll(actions => actions.map(action => {
        const footer = action.parentElement, bubble = footer.previousElementSibling;
        const r = action.getBoundingClientRect(), text = bubble.querySelector('.bubble').getBoundingClientRect();
        const next = footer.closest('.ho-finished-message')?.nextElementSibling ?? footer.nextElementSibling ?? footer.closest('.group').nextElementSibling;
        return { width: r.width, height: r.height, before: r.top - text.bottom, after: next ? next.getBoundingClientRect().top - r.bottom : null };
      }));
      report.push({ name, width, theme, file, words, mainWords, receiptGeometry, actionGeometry }); console.log(`PASS ${name} ${width} ${theme} ${suffix}`);
      await state.close();
    }
  } finally { await fixture.close(); fs.writeFileSync(path.join(output, `ho-q-${suffix}.json`), JSON.stringify(report, null, 2)); }
  console.log(`POLISH SHOTS ${report.length} passed, 0 failed. Output: ${output}/ho-q-${suffix}.json`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await captureShots();
  if (process.env.HO_POLISH_PHASE !== 'before') await runQuality();
}
