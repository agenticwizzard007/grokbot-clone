// Local fallback when the shared quality workstream has not supplied axe yet.
export function inspectFlowAccessibility() {
  const root = document.querySelector('[role="dialog"].flow-sheet') ?? document.querySelector('.flow-tab');
  const issues = [];
  if (!root) return ['No flow surface'];
  const visible = el => el.checkVisibility() && !el.closest('[hidden], [inert]');
  for (const el of root.querySelectorAll('button, a[href], input, select, textarea')) {
    if (!visible(el)) continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent).join(' ') || (el.labels?.length ? [...el.labels].map(l => l.textContent).join(' ') : el.textContent);
    if (!label?.trim()) issues.push(`Unnamed ${el.tagName}`);
    if (el.matches('button,a[href]') && el.getBoundingClientRect().height < 44) issues.push(`Small target: ${label}`);
  }
  for (const img of root.querySelectorAll('img')) if (!img.hasAttribute('alt')) issues.push('Image without alternative text');
  for (const el of root.querySelectorAll('[aria-labelledby]')) for (const id of el.getAttribute('aria-labelledby').split(' ')) if (!document.getElementById(id)) issues.push('Missing accessible name reference');
  if (root.matches('.flow-tab')) {
    if (root.querySelectorAll('.flow-lanes > li').length !== 5) issues.push('Missing ordered lanes');
    if (root.querySelectorAll('.flow-lanes > li ol').length !== 5) issues.push('Missing ordered node lists');
    if (!root.querySelector('.flow-sr')?.textContent) issues.push('Missing chart name');
    for (const el of root.querySelectorAll('svg')) if (el.getAttribute('aria-hidden') !== 'true' && !el.closest('[aria-hidden="true"]')) issues.push('Decorative connector is exposed');
  } else if (root.getAttribute('aria-modal') !== 'true') issues.push('Dialog is not modal');
  return issues;
}
