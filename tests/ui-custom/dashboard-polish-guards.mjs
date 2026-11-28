// Browser-side dashboard guards. Sidebar geometry is part of inspectAlignment.
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
  for (const group of document.querySelectorAll('.dashboard-manager-actions, .dashboard-empty > .layout-button-group')) {
    const buttons = [...group.querySelectorAll('button')], boxes = buttons.map(el => el.getBoundingClientRect());
    if (boxes.some(r => !near(r.width, boxes[0].width) || !near(r.height, boxes[0].height))) issues.push('G5b manager actions have unequal sizes');
    if (buttons.some(button => textBox(button).height > parseFloat(getComputedStyle(button).lineHeight) + 1)) issues.push('G5b manager action label wraps');
  }
  if (innerWidth <= 760) for (const dialog of document.querySelectorAll('.dashboard-dialog[open]')) {
    if ([...dialog.querySelectorAll('button[aria-label="Close"]')].some(visible)) issues.push('G5c phone dialog shows both Back and Close');
  }
  return issues;
}
