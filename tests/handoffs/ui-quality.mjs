import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkQualityGuards } from './quality-guards.mjs';
import { polishFixture, screens } from './polish-fixture.mjs';

// Executed in the browser. Only rendered text counts; closed details and screen
// reader summaries do not. Dialogs are audited separately from their inert page.
export function inspectQuality({ selector, finished = false }) {
  const roots = [...document.querySelectorAll(selector)];
  const visible = el => el.checkVisibility() && !el.closest('[inert], .sr-only, .flow-sr, [aria-hidden="true"]') && el.getBoundingClientRect().width > 1;
  const all = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(visible);
  const issues = [], counts = {};
  const check = (rule, okay, el, detail = '') => { counts[rule] = (counts[rule] || 0) + 1; if (!okay) issues.push(`${rule}: ${el.tagName}.${el.className} ${(el.innerText || '').trim().slice(0,70)} ${detail}`); };
  const close = (a,b) => Math.abs(a-b) <= 1;
  const minimum = innerWidth <= 760 ? 44 : 36;
  const chip = '.ho-chip, .ho-status, .ho-loop-chip, .flow-badge, .chip, .agents-settings .cfg-chip';
  const forbidden = /mock:|\[object|\bundefined\b|\bnull\b|\{"|[\u2013\u2014]/i;
  for (const el of all) {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue;
      const font = parseFloat(css.fontSize);
      check('a.type', font >= (el.closest(chip) ? 12 : el.closest('p,pre,textarea,[role="tooltip"]') ? 14 : 13), el, `${font}px`);
      check('h.copy', !forbidden.test(node.textContent), el);
      check('h.count-copy', !/\b1 reports\b|\bto \d+ (files|reports)\b/.test(node.textContent), el);
      if (el.closest('.ho-receipt-meta') && !el.closest(chip)) check('a.receipt-meta', font >= 13, el, `${font}px`);
    }
    if (el.matches('input,textarea')) check('h.copy', !forbidden.test(el.value) && !forbidden.test(el.getAttribute('placeholder') || ''), el);
    if (el.matches('.ho-output-summary')) { const title = el.closest('.ho')?.querySelector('.ho-heading'); if (title) check('g.viewer-title', !el.textContent.trim().toLowerCase().startsWith(title.textContent.trim().toLowerCase()), el); }
    if (el.matches('.ho-loop-goal')) { const subtitles = [...el.closest('.ho-loops').querySelectorAll('.layout-row__subtitle')].filter(visible); check('g.unique-goal', subtitles.every(node => node.textContent.trim() !== el.textContent.trim()), el); }
    if (el.matches('[data-layout="row"],button,[role="button"],summary,a[href]:not(.flow-sr)')) check('b.target', r.height >= minimum - 1, el, `${r.height}px`);
    if (el.matches('[data-layout="button-group"]')) {
      const children = [...el.children].filter(visible), rects = children.map(x => x.getBoundingClientRect());
      check('c.equal-actions', rects.every(x => close(x.width,rects[0]?.width)), el);
      const rows = new Map(); for (const rect of rects) { const key = Math.round(rect.top); rows.set(key, (rows.get(key)||0)+1); }
      check('c.no-orphan-action', rows.size <= 1 || [...rows.values()].every(n => n === 1) || [...rows.values()].every(n => n > 1), el);
      if (el.closest('[data-layout="card"]')) check('c.two-actions', [...rows.values()].every(n => n <= 2), el);
    }
    if (el.matches('[data-layout="card"]')) {
      check('d.card', ['paddingTop','paddingRight','paddingBottom','paddingLeft'].every(k => close(parseFloat(css[k]),16)) && close(parseFloat(css.borderTopLeftRadius),12) && close(parseFloat(css.borderTopWidth),1), el, `${css.padding} radius ${css.borderTopLeftRadius}`);
      const title = el.querySelector('.layout-row__title, h2, h3'); const body = el.querySelector('p');
      if (title && body) check('g.unique-title', !body.textContent.trim().toLowerCase().startsWith(title.textContent.trim().toLowerCase()), el);
    }
    if (el.matches(chip)) { check('e.chip', [el, el.closest('a')].filter(Boolean).every(node => getComputedStyle(node).textDecorationLine === 'none'), el); check('e.chip-size', close(r.height,20) && close(parseFloat(css.fontSize),12) && close(parseFloat(css.lineHeight),16) && css.fontWeight === '500', el); }
    if (el.matches('label,button,a,h1,h2,h3,.layout-row__title,.layout-row__subtitle,.flow-node__text')) check('e.label', el.scrollWidth <= el.clientWidth + 1 && css.textOverflow !== 'ellipsis' && !['hidden','clip'].includes(css.overflowY), el);
    check('e.overflow', r.left >= -1 && r.right <= innerWidth + 1, el);
    if (el.matches('.ho-receipt') && el.closest('.transcript__col') && !el.closest('.ho-receipt-passes')) { const column = el.closest('.transcript__col').getBoundingClientRect(); check('d.receipt-column', close(r.width,column.width) && close(r.right,column.right),el); }
    if (el.matches('.ho-receipt')) {
      const meta = el.querySelector('.ho-receipt-meta');
      const title = el.querySelector('.layout-row__title');
      const titleLines = title ? title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight) : 1;
      // Full loop and agent names grow by their extra title lines, not blank space.
      const extraTitleHeight = title ? Math.max(0, titleLines - 1) * parseFloat(getComputedStyle(title).lineHeight) : 0;
      if (meta && meta.getBoundingClientRect().height <= 21) check('f.receipt-height', r.height <= 80 + extraTitleHeight, el, `${r.height}px`);
      check('b.receipt-target', r.height >= 44, el);
      for (const action of el.querySelectorAll('a,button')) { const a = action.getBoundingClientRect(); check('b.receipt-target', a.height >= 44 && a.width >= 44, action); }
    }
    if (el.matches('.ho-receipt--loop')) {
      const title = el.querySelector('.layout-row__title').textContent.trim();
      check('k.loop-title', !!title && !/^(?:(?:agent|new|untitled) )?loop$/i.test(title), el);
      check('k.loop-chip', /^(?:\d+ pass(?:es)?|Pass \d+ of \d+)$/.test(el.querySelector('.ho-chip').textContent), el);
      const toggle = el.querySelector('.ho-receipt-expand');
      check('k.loop-toggle', toggle.getAttribute('aria-label') === `${toggle.getAttribute('aria-expanded') === 'true' ? 'Hide' : 'Show'} passes for ${title}`, toggle);
    }
    if (el.matches('[data-layout="row"]')) {
      const leading = el.querySelector(':scope > .layout-row__leading'), title = el.querySelector(':scope > .layout-row__text > .layout-row__title');
      if (leading && title) { const icon = leading.getBoundingClientRect(), text = title.getBoundingClientRect(); check('j.icon', Math.abs(icon.top + icon.height/2 - text.top - parseFloat(getComputedStyle(title).lineHeight)/2) <= 2, el); }
      const action = el.querySelector(':scope > .layout-row__trailing');
      if (action) { const a = action.getBoundingClientRect(); check('j.trailing', Math.abs(a.top+a.height/2-r.top-r.height/2) <= 2, el); check('j.trailing-edge', close(a.right, r.right - parseFloat(css.paddingRight)), el); }
    }
    if (el.matches('.flow-node button')) {
      const icon = el.querySelector('.flow-node__logo').getBoundingClientRect(), text = el.querySelector('strong').getBoundingClientRect();
      check('j.icon', Math.abs(icon.top+icon.height/2-text.top-parseFloat(getComputedStyle(el.querySelector('strong')).lineHeight)/2) <= 2, el);
    }
    const children = [...el.children].filter(visible);
    const cards = children.filter(x => x.matches('[data-layout="card"]'));
    if (cards.length > 1) { const rects = cards.map(x=>x.getBoundingClientRect()); check('d.shared-edges', rects.every(x=>close(x.width,rects[0].width) && close(x.left,rects[0].left) && close(x.right,rects[0].right)), el); }
    const rows = children.filter(x => x.matches('[data-layout="row"], .ho-loop-timeline > li, .flow-nodes > li'));
    if (rows.length > 1) { const rects=rows.map(x=>x.getBoundingClientRect()), gaps=rects.slice(1).map((x,i)=>x.top-rects[i].bottom); check('f.spacing', gaps.every(x=>close(x,gaps[0]) && close(x,Math.round(x/8)*8)), el, gaps.join(',')); }
  }
  for (const el of document.querySelectorAll('.ho-receipt-wrap + .ho-receipt-wrap, .ho-receipt-passes > div + div')) {
    if (!visible(el)) continue;
    const gap = el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom;
    check('f.receipt-gap', gap >= 8 && gap <= 16, el, `${gap}px`);
  }
  check('coverage.surface', roots.length > 0 && all.length > 0, document.documentElement);
  for (const el of document.querySelectorAll('.ho-message-actions')) {
    if (!visible(el)) continue;
    check('i.action-label', el.textContent.trim() === '' && el.getAttribute('aria-label') === 'Message actions', el);
    check('b.message-target', el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44, el);
    const footer = el.parentElement, bubble = footer.previousElementSibling;
    if (bubble?.matches('.bubble-wrap')) {
      const text = bubble.querySelector('.bubble').getBoundingClientRect(), action = el.getBoundingClientRect();
      const copy = bubble.querySelector('.bubble__copy').getBoundingClientRect();
      check('f.message-before', action.top - text.bottom >= 8 && action.top - text.bottom <= 16, el, `${action.top - text.bottom}px`);
      check('f.message-inline', close(action.top, copy.top) && close(action.left - copy.right, 8), el);
      const group = footer.closest('.group');
      let next = footer.closest('.ho-finished-message')?.nextElementSibling ?? footer.nextElementSibling ?? group?.nextElementSibling;
      while (next && !visible(next)) next = next.nextElementSibling;
      if (next) {
        const gap = next.getBoundingClientRect().top - action.bottom;
        check('f.message-after', gap >= 8 && gap <= 16, el, `${gap}px`);
      }
    }
  }
  for (const el of document.querySelectorAll('.group button')) if (visible(el)) check('i.no-actions-copy', el.innerText.trim() !== 'Actions', el);
  check('e.document', document.documentElement.scrollWidth <= innerWidth + 1, document.documentElement);
  if (finished) check('i.finished', !document.querySelector('.first-response, .is-streaming, .pb-room-typing, .first-response__mark, .load-feedback[aria-busy="true"]'), roots[0]);
  return { issues, counts };
}
export async function runQuality() {
  const out = path.resolve(process.env.HO_QUALITY_OUTPUT || '.context/ho-q/quality'); fs.mkdirSync(out,{recursive:true});
  const fixture = await polishFixture(), report = [];
  try {
    await checkQualityGuards(fixture, inspectQuality);
    for (const width of (process.env.HO_WIDTHS || '320,390,500,1280').split(',').map(Number)) for (const theme of (process.env.HO_THEMES || 'light,dark').split(',')) for (const name of (process.env.HO_SCREENS ? process.env.HO_SCREENS.split(',') : screens)) {
      let state;
      try {
        state = await fixture.open(name,width,theme);
        const result = await state.page.evaluate(inspectQuality,{ selector: state.selector, finished: name.startsWith('receipt') || name === 'message-actions' });
        if (name.startsWith('receipt')) {
          const group = state.page.locator('.ho-loop-receipt');
          assert.equal(await group.count(), 1, 'one group for the loop');
          assert.equal(await state.page.locator('.transcript__col > .ho-receipt-wrap:not(.ho-loop-receipt)').count(), 1, 'one independent handoff');
          const expanded = name === 'receipt-expanded';
          const toggle = group.locator('.ho-receipt-expand');
          assert.equal(await group.locator('.ho-receipt--loop .layout-row__title').innerText(), state.receiptTitle);
          assert.equal(await toggle.getAttribute('aria-label'), `${expanded ? 'Hide' : 'Show'} passes for ${state.receiptTitle}`);
          assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
          assert.equal(await group.locator('.ho-receipt-passes .ho-receipt:visible').count(), expanded ? 6 : 0);
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-expanded'), String(!expanded));
          assert.equal(await group.locator('.ho-receipt-passes .ho-receipt:visible').count(), expanded ? 0 : 6);
          assert.equal(await toggle.getAttribute('aria-label'), `${expanded ? 'Show' : 'Hide'} passes for ${state.receiptTitle}`);
          if (!expanded) {
            const open = await state.page.evaluate(inspectQuality, { selector: state.selector, finished: true });
            result.issues.push(...open.issues);
          }
          await toggle.click();
          const href = await group.getByRole('link', {name:'View loop',exact:true}).getAttribute('href');
          assert.match(href, /^#loop\//);
          if (name === 'receipt-running') {
            assert.equal(await group.locator('.ho-chip').innerText(), 'Pass 2 of 4');
            await state.advanceLoop();
            await group.getByText('Pass 3 of 4', {exact:true}).waitFor();
            assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'live updates preserve collapsed state');
          }
          await group.getByRole('link', {name:'View loop',exact:true}).click();
          await state.page.locator('[data-loop-revision]').waitFor();
          assert.equal(new URL(state.page.url()).hash, href);
          result.counts['k.loop-group'] = 1;
        }
        if (name === 'message-actions') {
          const button = state.page.getByRole('button', { name: 'Message actions', exact: true }).first();
          await button.focus(); await state.page.keyboard.press('Enter');
          await state.page.getByRole('menuitem', { name: 'Send to agent', exact: true }).waitFor();
          const menu = await state.page.evaluate(inspectQuality, { selector: '.ho-message-footer [role="menu"]' });
          result.issues.push(...menu.issues);
          await state.page.keyboard.press('Escape');
          assert.equal(await button.getAttribute('aria-expanded'), 'false');
          assert.equal(await button.evaluate(el => el === document.activeElement), true);
          result.counts['i.message-menu'] = 1;
        }
        report.push({name,width,theme,...result});
        if (result.issues.length) await state.page.screenshot({path:path.join(out,`${name}-${width}-${theme}.png`),fullPage:true});
        console.log(`${result.issues.length ? 'FAIL' : 'PASS'} ${name} ${width} ${theme}: ${result.issues.length} issues`);
      } catch(error) { report.push({name,width,theme,issues:[String(error)],counts:{}}); console.log(`FAIL ${name} ${width} ${theme}: ${error.message.split('\n')[0]}`); }
      finally { if(state) await state.close(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); }
    }
  } finally { await fixture.close(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); }
  const failures = report.filter(x=>x.issues.length);
  console.log(`UI QUALITY ${report.length-failures.length} passed, ${failures.length} failed. Output: ${out}/report.json`);
  assert.equal(failures.length,0,JSON.stringify(failures.slice(0,3),null,2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runQuality();
