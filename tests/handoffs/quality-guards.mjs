import assert from 'node:assert/strict';

/** Prove the gate rejects regressions instead of only passing our fixtures. */
export async function checkQualityGuards(fixture, inspect) {
  const state = await fixture.open('output-card',390,'light');
  const { page, selector } = state;
  const cases = [
    ['a.type', el => { el.querySelector('.layout-row__title').style.fontSize = '11px'; }],
    ['b.target', el => { const b=el.querySelector('button'); b.style.setProperty('min-height','20px','important'); b.style.setProperty('height','20px','important'); b.style.padding='0'; }],
    ['c.equal-actions', el => { el.querySelector('.layout-button-group > *').style.width='40px'; }],
    ['c.two-actions', el => { const g=el.querySelector('.layout-button-group'); g.append(g.firstElementChild.cloneNode(true)); }],
    ['d.card', el => { el.style.padding='8px'; }],
    ['e.chip', el => { const chip=document.createElement('span'); chip.className='ho-chip'; chip.textContent='Loop'; const link=document.createElement('a');link.href='#loops';link.style.textDecoration='underline';link.append(chip);el.append(link); }],
    ['e.overflow', el => { el.style.width='2000px'; }],
    ['f.spacing', el => { const list=document.createElement('div'); list.style.display='grid'; list.style.gap='5px'; for(let i=0;i<3;i++){const row=document.createElement('div');row.dataset.layout='row';row.textContent='Release note';list.append(row);} el.append(list); }],
    ['g.unique-title', el => { const p=document.createElement('p'); p.textContent=el.querySelector('.layout-row__title').textContent; el.prepend(p); }],
    ['g.viewer-title', el => { const title=document.createElement('h1'); title.className='ho-heading'; title.textContent='Release note'; const p=document.createElement('p'); p.className='ho-output-summary'; p.textContent=title.textContent; el.append(title,p); }],
    ['g.unique-goal', el => { const wrapper=document.createElement('div'); wrapper.className='ho-loops'; const goal=document.createElement('p'); goal.className='ho-loop-goal'; goal.textContent='Review the release note.'; const subtitle=document.createElement('div'); subtitle.className='layout-row__subtitle'; subtitle.textContent=goal.textContent; wrapper.append(goal,subtitle); el.append(wrapper); }],
    ['h.copy', el => { el.append(document.createTextNode('mock: review')); }],
    ['h.count-copy', el => { el.append(document.createTextNode('1 reports')); }],
    ['h.count-copy', el => { el.append(document.createTextNode('2 to 5 files')); }],
    ['i.action-label', el => { const b=document.createElement('button'); b.className='ho-message-actions'; b.setAttribute('aria-label','Message actions'); b.textContent='Actions'; el.append(b); }],
    ['f.receipt-height', el => { const row=document.createElement('div'); row.className='ho-receipt'; row.style.height='100px'; row.innerHTML='<div class="ho-receipt-meta">Release note</div>'; el.append(row); }],
    ['a.receipt-meta', el => { const meta=document.createElement('div'); meta.className='ho-receipt-meta'; meta.style.fontSize='12px'; meta.textContent='Release note'; el.append(meta); }],
    ['f.receipt-gap', el => { const stack=document.createElement('div'); stack.style.cssText='display:flex;flex-direction:column;gap:24px'; stack.innerHTML='<div class="ho-receipt-wrap">First</div><div class="ho-receipt-wrap">Second</div>'; el.append(stack); }],
    ['i.finished', el => { const pending=document.createElement('div');pending.className='first-response';el.append(pending); }],
    ['j.icon', el => { el.querySelector('.layout-row__leading').style.transform='translateY(8px)'; }],
    ['j.trailing', el => { const row=el.querySelector('.layout-row');const trailing=document.createElement('div');trailing.className='layout-row__trailing';trailing.textContent='Open';trailing.style.transform='translateY(12px)';row.append(trailing); }],
  ];
  try {
    const original = await page.locator(selector).first().evaluate(el => el.outerHTML);
    for (const [rule, mutate] of cases) {
      await page.locator(selector).first().evaluate(mutate);
      const result = await page.evaluate(inspect,{selector,finished:true});
      assert.ok(result.issues.some(issue=>issue.startsWith(`${rule}:`)),`Gate must reject ${rule}`);
      await page.locator(selector).first().evaluate((el, html)=>{el.outerHTML=html;},original);
      console.log(`PASS quality guard ${rule}`);
    }
    // Only a final output replaces the message menu. A draft or earlier output
    // must not make the completed message's existing action disappear.
    let status = 'draft';
    await page.route('**/api/outputs/by-job/*', async route => {
      const response = await route.fetch(); const data = await response.json();
      await route.fulfill({ response, json: { ...data, output: { ...data.output, status } } });
    });
    for (status of ['draft', 'superseded']) {
      const read = page.waitForResponse(response => response.url().includes('/api/outputs/by-job/'));
      await page.reload();
      await (await read).finished(); await page.waitForTimeout(200);
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Message actions"]').length === 2 && !document.querySelector('.ho-output-card'));
      const result = await page.evaluate(inspect, { selector: '.ho-message-actions', finished: true });
      assert.deepEqual(result.issues, [], `${status} retains readable message actions`);
      console.log(`PASS quality guard message-actions-${status}`);
    }
  } finally { await page.unrouteAll({ behavior: 'wait' }); await state.close(); }
  const receipt = await fixture.open('receipt', 390, 'light');
  const receiptCases = [
    ['k.loop-title', '.ho-receipt--loop .layout-row__title', el => { el.textContent = 'Loop'; }],
    ['k.loop-chip', '.ho-receipt--loop .ho-chip', el => { el.textContent = 'Loop, 3 passes'; }],
    ['k.loop-toggle', '.ho-receipt-expand', el => { el.setAttribute('aria-label', 'Show passes'); }],
    ['e.label', '.ho-receipt--loop .layout-row__title', el => { el.style.textOverflow = 'ellipsis'; el.style.overflow = 'hidden'; }],
    ['f.receipt-height', '.ho-receipt--loop', el => { el.style.height = '500px'; }],
    ['f.message-before', '.ho-message-actions', el => { el.style.transform = 'translateY(24px)'; }],
    ['f.message-inline', '.ho-message-actions', el => { el.style.transform = 'translateX(24px)'; }],
    ['f.message-after', '.ho-message-actions', el => { el.closest('.group').nextElementSibling.style.marginTop = '40px'; }],
  ];
  try {
    for (const [rule, selector, mutate] of receiptCases) {
      const root = receipt.page.locator('.transcript__col');
      const original = await root.evaluate(el => el.innerHTML);
      await receipt.page.locator(selector).first().evaluate(mutate);
      const result = await receipt.page.evaluate(inspect, { selector: receipt.selector, finished: true });
      assert.ok(result.issues.some(issue => issue.startsWith(`${rule}:`)), `Gate must reject ${rule}`);
      await root.evaluate((el, html) => { el.innerHTML = html; }, original);
      console.log(`PASS quality guard ${rule}`);
    }
  } finally { await receipt.close(); }
  return cases.length + 2 + receiptCases.length;
}
