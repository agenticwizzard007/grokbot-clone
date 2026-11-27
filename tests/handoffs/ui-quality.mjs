import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const chip = '.ho-chip, .ho-status, .ho-loop-chip, .flow-badge, .chip';
  const forbidden = /mock:|\[object|\bundefined\b|\bnull\b|\{"|[\u2013\u2014]/i;
  for (const el of all) {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue;
      const font = parseFloat(css.fontSize);
      check('a.type', font >= (el.closest(chip) ? 12 : el.closest('p,pre,textarea') ? 14 : 13), el, `${font}px`);
      check('h.copy', !forbidden.test(node.textContent), el);
    }
    if (el.matches('input,textarea')) check('h.copy', !forbidden.test(el.value), el);
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
    if (el.matches(chip)) check('e.chip', css.textDecorationLine === 'none' && !el.closest('a')?.matches('.ho-inline-link'), el);
    if (el.matches('label,button,a,h1,h2,h3,.layout-row__title,.layout-row__subtitle,.flow-node__text')) check('e.label', el.scrollWidth <= el.clientWidth + 1 && css.textOverflow !== 'ellipsis' && !['hidden','clip'].includes(css.overflowY), el);
    check('e.overflow', r.left >= -1 && r.right <= innerWidth + 1, el);
    if (el.matches('[data-layout="row"]')) {
      const leading = el.querySelector(':scope > .layout-row__leading'), title = el.querySelector(':scope > .layout-row__text > .layout-row__title');
      if (leading && title) { const icon = leading.getBoundingClientRect(), text = title.getBoundingClientRect(); check('j.icon', Math.abs(icon.top + icon.height/2 - text.top - parseFloat(getComputedStyle(title).lineHeight)/2) <= 2, el); }
      const action = el.querySelector(':scope > .layout-row__trailing');
      if (action) { const a = action.getBoundingClientRect(); check('j.trailing', Math.abs(a.top+a.height/2-r.top-r.height/2) <= 2, el); }
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
  check('coverage.surface', roots.length > 0 && all.length > 0, document.documentElement);
  if (finished) for (const el of document.querySelectorAll('[aria-label="Message actions"]')) check('i.action-label', el.textContent.trim() === 'Actions', el);
  check('e.document', document.documentElement.scrollWidth <= innerWidth + 1, document.documentElement);
  if (finished) check('i.finished', !document.querySelector('.first-response, .is-streaming, .pb-room-typing, .first-response__mark, .load-feedback[aria-busy="true"]'), roots[0]);
  return { issues, counts };
}
export async function runQuality() {
  const out = path.resolve('.context/ho-p/quality'); fs.mkdirSync(out,{recursive:true});
  const fixture = await polishFixture(), report = [];
  try {
    for (const width of (process.env.HO_WIDTHS || '320,390,500,1280').split(',').map(Number)) for (const theme of (process.env.HO_THEMES || 'light,dark').split(',')) for (const name of (process.env.HO_SCREENS ? process.env.HO_SCREENS.split(',') : screens)) {
      let state;
      try {
        state = await fixture.open(name,width,theme);
        const result = await state.page.evaluate(inspectQuality,{ selector: state.selector, finished: name === 'receipt' });
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
