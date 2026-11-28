// Browser-side geometry guards. Return every defect so baseline evidence is complete.
export function inspectSidebarUsage() {
  const issues = [], near = (a, b) => Math.abs(a - b) <= 1;
  for (const sidebar of document.querySelectorAll('.sidebar:not(.is-collapsed)')) {
    const box = sidebar.getBoundingClientRect();
    if (!sidebar.checkVisibility() || box.right <= 0 || box.left >= innerWidth) continue;
    const meter = sidebar.querySelector('.sidebar-usage');
    if (!meter?.checkVisibility()) continue;
    const footer = sidebar.querySelector('.sidebar__footer'), scroll = sidebar.querySelector('.sidebar__custom-scroll, .sidebar__scroll');
    const nav = sidebar.querySelector('.sidebar__nav, .sidebar__dashboards');
    const m = meter.getBoundingClientRect(), f = footer.getBoundingClientRect(), s = scroll.getBoundingClientRect();
    const css = getComputedStyle(sidebar), contentLeft = box.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const contentRight = box.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
    if (!near(m.left, contentLeft) || !near(m.right, contentRight)) issues.push(`G1 usage width/edges: ${m.width.toFixed(2)}px, sidebar content ${(contentRight - contentLeft).toFixed(2)}px`);
    if (nav) { const n = nav.getBoundingClientRect(); if (!near(m.left, n.left) || !near(m.right, n.right)) issues.push('G1 usage edges differ from navigation'); }
    if (f.top - m.bottom < -1 || f.top - m.bottom > 16) issues.push(`G1 usage/footer gap: ${(f.top - m.bottom).toFixed(2)}px`);
    if (!near(f.bottom, box.bottom - parseFloat(css.paddingBottom) - parseFloat(css.borderBottomWidth))) issues.push('G1 Settings is not pinned to sidebar bottom');
    if (s.bottom > m.top + 1 || scroll.contains(meter) || scroll.contains(footer)) issues.push('G1 usage or Settings overlaps the scroll area');
    if (m.top < box.top || f.bottom > innerHeight + 1) issues.push('G1 usage or Settings is outside the viewport');
    const mc = getComputedStyle(meter);
    if (mc.padding !== '16px' || mc.borderTopLeftRadius !== '12px') issues.push('G1 usage card needs 16px padding and 12px radius');
  }
  return issues;
}

export function inspectDashboardPolish() {
  const issues = [], near = (a, b) => Math.abs(a - b) <= 1;
  const visible = el => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const textBox = el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); };
  for (const list of document.querySelectorAll('.dashboard-agent-list')) {
    const buttons = [...list.querySelectorAll('button')].filter(visible), boxes = buttons.map(el => el.getBoundingClientRect());
    if (boxes.some(r => r.width < 120 || !near(r.width, boxes[0].width) || !near(r.height, 44) || !near(r.right, boxes[0].right))) issues.push(`G2 inline actions need equal widths >=120px, 44px height and aligned right edges: ${boxes.map(r => `${r.width.toFixed(2)}x${r.height.toFixed(2)}@${r.right.toFixed(2)}`).join(', ')}`);
    if (buttons.some(button => textBox(button).height > parseFloat(getComputedStyle(button).lineHeight) + 1)) issues.push('G2 inline action label wraps');
    if ([...list.querySelectorAll('.dashboard-agent-row-text')].some(text => text.getBoundingClientRect().width < 96)) issues.push('G2 inline actions squeeze the row text below 96px');
  }
  const stats = [...document.querySelectorAll('.dashboard-grid:not(.dashboard-grid--editing) .dashboard-widget--stat')];
  for (const stat of stats) {
    const label = stat.querySelector('h2');
    if (innerWidth >= 390 && textBox(label).height > parseFloat(getComputedStyle(label).lineHeight) + 1) issues.push(`G3 KPI label wraps: ${label.textContent}`);
  }
  if (stats.length && stats.some(el => !near(el.getBoundingClientRect().height, stats[0].getBoundingClientRect().height))) issues.push('G3 KPI tiles have unequal heights');
  for (const card of document.querySelectorAll('.dashboard-grid:not(.dashboard-grid--editing) .dashboard-widget--botStatus')) {
    const last = card.querySelector('.dashboard-bot-list li:last-child');
    if (last && card.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom > 17) issues.push('G4 Bots card stretches below its content');
  }
  // Small stats preceding a full-width card must finish their row.
  for (const slot of document.querySelectorAll('.dashboard-grid:not(.dashboard-grid--editing) > [data-widget-kind="stat"]')) {
    const next = slot.nextElementSibling, grid = slot.parentElement.getBoundingClientRect(), s = slot.getBoundingClientRect();
    if (next && next.dataset.widgetKind !== 'stat' && near(next.getBoundingClientRect().width, grid.width) && !near(s.right, grid.right)) issues.push('G5a orphan stat leaves an unfinished row');
  }
  for (const group of document.querySelectorAll('.dashboard-manager-actions')) {
    const buttons = [...group.querySelectorAll('button')], boxes = buttons.map(el => el.getBoundingClientRect());
    if (boxes.some(r => !near(r.width, boxes[0].width) || !near(r.height, boxes[0].height))) issues.push('G5b manager actions have unequal sizes');
    if (buttons.some(button => textBox(button).height > parseFloat(getComputedStyle(button).lineHeight) + 1)) issues.push('G5b manager action label wraps');
  }
  if (innerWidth <= 760) for (const dialog of document.querySelectorAll('.dashboard-dialog[open]')) {
    if ([...dialog.querySelectorAll('button[aria-label="Close"]')].some(visible)) issues.push('G5c phone dialog shows both Back and Close');
  }
  return issues;
}
