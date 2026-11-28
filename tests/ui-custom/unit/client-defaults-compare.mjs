import assert from 'node:assert/strict';

const navigationNode = node => node.class === 'shell-header' || node.class === 'phone-tabs';

export function compareDefaultView(key, actual, expected, reviewedDifferences = {}) {
  const review = reviewedDifferences[key];
  if (!review) {
    assert.deepEqual(actual, expected, key);
    return 'matched';
  }
  assert.ok(review.reason?.trim(), `${key}: reviewed reason`);
  assert.notDeepEqual(actual, expected, `${key}: remove the review when the pin matches`);
  assert.deepEqual(actual.tokens, expected.tokens, `${key}: token maps`);
  // A reviewed view must retain its Page, including when its exact height changes.
  assert.ok(actual.nodes.some(node => node.class.split(' ').includes('layout-page')), `${key}: Page exists`);
  if (review.rectangles !== undefined) return compareReviewedRectangles(key, actual, expected, review);
  // Shell-navigation reviews leave every content node and Page box unchanged.
  assert.deepEqual(actual.nodes.filter(node => !navigationNode(node)), expected.nodes.filter(node => !navigationNode(node)), `${key}: content and Page geometry`);
  const navigation = actual.nodes.filter(navigationNode);
  assert.deepEqual(navigation.map(({ class: name, rect }) => ({ class: name, rect })), review.navigation, `${key}: reviewed navigation boxes`);
  for (const node of navigation) {
    const original = expected.nodes.find(candidate => candidate.class === node.class);
    assert.ok(original, `${key}: known navigation node`);
    assert.deepEqual({ ...node, rect: original.rect }, original, `${key}: navigation styles`);
  }
  return 'reviewed';
}

function compareReviewedRectangles(key, actual, expected, review) {
  assert.equal(review.navigation, undefined, `${key}: rectangle reviews cannot also bypass navigation`);
  assert.ok(Array.isArray(review.rectangles) && review.rectangles.length, `${key}: explicit rectangles required`);
  const pinned = structuredClone(expected), indices = new Set();
  for (const change of review.rectangles) {
    const { index, class: name, tag, before, after } = change;
    assert.ok(Number.isInteger(index) && index >= 0 && index < pinned.nodes.length, `${key}: known node index`);
    assert.ok(!indices.has(index), `${key}: duplicate node review`);
    indices.add(index);
    const original = pinned.nodes[index];
    assert.equal(original.class, name, `${key}: reviewed node class`);
    assert.equal(original.tag, tag, `${key}: reviewed node tag`);
    assert.deepEqual(original.rect, before, `${key}: pinned rectangle`);
    assert.ok(Array.isArray(after) && after.length === 4 && after.every(Number.isFinite) && after[2] >= 0 && after[3] >= 0, `${key}: finite rectangle`);
    assert.notDeepEqual(after, before, `${key}: remove unchanged rectangle review`);
    original.rect = after;
  }
  // Content additions are full node records, anchored to the untouched pin.
  // Indices refer to the original snapshot, just like rectangle reviews.
  if (review.insertions !== undefined) {
    assert.ok(Array.isArray(review.insertions) && review.insertions.length, `${key}: explicit insertions required`);
    let previous = -1, offset = 0;
    for (const { index, before, nodes } of review.insertions) {
      assert.ok(Number.isInteger(index) && index > previous && index <= expected.nodes.length, `${key}: ordered known insertion index`);
      assert.deepEqual(index === expected.nodes.length ? null : expected.nodes[index], before, `${key}: pinned insertion anchor`);
      assert.ok(Array.isArray(nodes) && nodes.length, `${key}: explicit inserted nodes required`);
      for (const node of nodes) {
        assert.ok(typeof node.tag === 'string' && typeof node.class === 'string', `${key}: inserted node identity`);
        assert.ok(Array.isArray(node.rect) && node.rect.length === 4 && node.rect.every(Number.isFinite) && node.rect[2] >= 0 && node.rect[3] >= 0, `${key}: finite inserted rectangle`);
      }
      pinned.nodes.splice(index + offset, 0, ...structuredClone(nodes));
      previous = index; offset += nodes.length;
    }
  }
  // Compare every token, style and node after only the explicitly recorded edits.
  assert.deepEqual(actual, pinned, `${key}: exact reviewed geometry and unchanged content`);
  return 'reviewed';
}
