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
  // Page boxes, cards, rows and all other content retain exact snapshot checks.
  assert.ok(actual.nodes.some(node => node.class.split(' ').includes('layout-page')), `${key}: Page exists`);
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
