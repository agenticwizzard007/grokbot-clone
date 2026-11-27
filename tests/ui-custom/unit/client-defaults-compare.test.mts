import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDefaultView } from './client-defaults-compare.mjs';

const key = '390-light-bot-activity';
const expected = {
  tokens: { '--color-bg-pane': '#FFFFFF' },
  nodes: [
    { class: 'shell-header', rect: [0, 0, 390, 64], font: '14px Inter' },
    { class: 'layout-page flow-page', rect: [0, 117, 390, 286] },
    { class: 'layout-card', rect: [16, 293, 358, 94] },
    { class: 'phone-tabs', rect: [0, 787, 390, 57] },
  ],
};
const reviewed = { [key]: {
  reason: 'Shared Flow navigation replaces the temporary header and fallback tabs.',
  navigation: [{ class: 'shell-header', rect: [0, 0, 390, 56] }],
} };
function changed() {
  const value = structuredClone(expected);
  value.nodes.pop();
  value.nodes[0].rect[3] = 56;
  return value;
}

test('unlisted default views require the complete snapshot to match', () => {
  assert.equal(compareDefaultView(key, structuredClone(expected), expected), 'matched');
  assert.throws(() => compareDefaultView(key, changed(), expected), /390-light-bot-activity/);
});
test('a reviewed navigation change still compares the complete content and tokens', () => {
  assert.equal(compareDefaultView(key, changed(), expected, reviewed), 'reviewed');
});
test('a reviewed view rejects token differences', () => {
  const value = changed(); value.tokens['--color-bg-pane'] = '#000000';
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /token maps/);
});
test('a reviewed view rejects changed Page bounding boxes', () => {
  const value = changed(); value.nodes[1].rect[2] -= 8;
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /Page geometry/);
});
test('a reviewed view rejects changed card bounding boxes', () => {
  const value = changed(); value.nodes[2].rect[3] += 8;
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /Page geometry/);
});
test('reviewed navigation must match its recorded bounding boxes', () => {
  const value = changed(); value.nodes[0].rect[3] += 8;
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /reviewed navigation boxes/);
});
test('reviewed navigation cannot change styles', () => {
  const value = changed(); value.nodes[0].font = '16px serif';
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /navigation styles/);
});
test('a reviewed view must retain the Page primitive', () => {
  const value = changed(); value.nodes.splice(1, 1);
  assert.throws(() => compareDefaultView(key, value, expected, reviewed), /Page exists/);
});
test('stale reviews must be removed when the pin already matches', () => {
  assert.throws(() => compareDefaultView(key, expected, expected, reviewed), /remove the review/);
});
