import assert from 'node:assert/strict';

/** Scroll the actual box into view, then inspect every clipping ancestor. */
export async function boxFullyVisible(locator, size) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const measured = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
    const problems = [];
    if (rect.left < parent.left - 1 || rect.right > parent.right + 1 || rect.top < parent.top - 1 || rect.bottom > parent.bottom + 1) problems.push('outside parent');
    if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) problems.push('outside viewport');
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) problems.push(`hidden by ${ancestor.className}`);
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) problems.push(`clipped horizontally by ${ancestor.className}`);
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) problems.push(`clipped vertically by ${ancestor.className}`);
    }
    return { width: rect.width, height: rect.height, problems, shrink: getComputedStyle(el).flexShrink };
  });
  assert.equal(measured.width, size.width, 'slot width is fixed');
  assert.equal(measured.height, size.height, 'slot height is fixed');
  assert.equal(measured.shrink, '0', 'slot never shrinks');
  assert.deepEqual(measured.problems, [], 'entire box is visible inside its container and all ancestors');
}
