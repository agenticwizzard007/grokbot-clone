import assert from 'node:assert/strict';

// Measure each rendered word, not CSS declarations: a wrapped word has text
// fragments on different lines even when scrollWidth happens to fit.
export async function readableWords(scope) {
  const failures = await scope.evaluate(root => {
    const failures = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('svg, script, style, [hidden], .sr-only') || !parent.checkVisibility()) continue;
      if (parent.scrollWidth > parent.clientWidth + 1) failures.push(`overflow: ${node.textContent.trim()}`);
      for (const word of node.textContent.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
        const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (new Set(rects.map(r => Math.round(r.top))).size > 1) failures.push(`split word: ${word[0]}`);
      }
      const style = getComputedStyle(parent);
      if (style.textOverflow === 'ellipsis' || !['none', ''].includes(style.webkitLineClamp)) failures.push(`truncated label: ${node.textContent.trim()}`);
    }
    return failures;
  });
  assert.deepEqual(failures, [], 'visible labels fit and wrap only between words');
}
