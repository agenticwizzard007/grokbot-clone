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

const settingsKey = '390-light-settings';
const settingsExpected = {
  tokens: expected.tokens,
  nodes: [
    { tag: 'HEADER', class: 'shell-header', rect: [0, 0, 390, 56], font: '14px Inter' },
    { tag: 'DIV', class: 'layout-page', rect: [0, 56, 390, 810], padding: '16px' },
    { tag: 'SECTION', class: 'layout-section settings-nav__group', rect: [16, 230, 358, 370] },
    { tag: 'DIV', class: 'layout-card layout-card--list settings-nav__items', rect: [16, 262, 358, 338] },
    { tag: 'SECTION', class: 'layout-section settings-nav__group', rect: [16, 624, 358, 226] },
    { tag: 'H2', class: '', rect: [24, 627, 81.2, 18] },
    { tag: 'DIV', class: 'layout-card layout-card--list settings-nav__items', rect: [16, 656, 358, 194] },
    { tag: 'NAV', class: 'phone-tabs', rect: [0, 787, 390, 57] },
  ],
};
const rectangles = [
  [1, [0, 56, 390, 858]], [2, [16, 230, 358, 418]], [3, [16, 262, 358, 386]],
  [4, [16, 672, 358, 226]], [5, [24, 675, 81.2, 18]], [6, [16, 704, 358, 194]],
].map(([index, after]) => ({ index, tag: settingsExpected.nodes[index].tag,
  class: settingsExpected.nodes[index].class, before: settingsExpected.nodes[index].rect, after }));
const settingsReviewed = { [settingsKey]: { reason: 'The Agents row adds 48px to Workspace and shifts Connections by 48px.', rectangles } };
function settingsChanged() {
  const value = structuredClone(settingsExpected);
  for (const { index, after } of rectangles) value.nodes[index].rect = [...after];
  return value;
}
test('listed Settings rectangles retain a complete exact snapshot assertion', () => {
  assert.equal(compareDefaultView(settingsKey, settingsChanged(), settingsExpected, settingsReviewed), 'reviewed');
  assert.throws(() => compareDefaultView(settingsKey, settingsChanged(), settingsExpected), /390-light-settings/);
});
for (const [name, change] of [
  ['tokens', value => { value.tokens['--color-bg-pane'] = '#000000'; }],
  ['unlisted header', value => { value.nodes[0].rect[3] += 1; }],
  ['unlisted phone tabs', value => { value.nodes[7].rect[1] -= 1; }],
  ['listed Page dimensions', value => { value.nodes[1].rect[2] -= 1; }],
  ['listed card dimensions', value => { value.nodes[3].rect[3] += 1; }],
  ['styles', value => { value.nodes[1].padding = '24px'; }],
  ['node order', value => { [value.nodes[4], value.nodes[5]] = [value.nodes[5], value.nodes[4]]; }],
  ['extra nodes', value => { value.nodes.push(structuredClone(value.nodes[3])); }],
  ['missing nodes', value => { value.nodes.splice(3, 1); }],
]) test(`reviewed Settings rectangles reject changed ${name}`, () => {
  const value = settingsChanged(); change(value);
  assert.throws(() => compareDefaultView(settingsKey, value, settingsExpected, settingsReviewed));
});
test('rectangle reviews reject a changed pin, wrong identity, duplicate index and invalid boxes', () => {
  for (const edit of [
    review => { review.rectangles[0].before[3] += 1; },
    review => { review.rectangles[0].class = 'layout-card'; },
    review => { review.rectangles[0].tag = 'SECTION'; },
    review => { review.rectangles[0].index = 99; },
    review => { review.rectangles.push(review.rectangles[0]); },
    review => { review.rectangles[0].after = [0, 0, -1, 40]; },
    review => { review.rectangles[0].after = [0, 0, 390, Infinity]; },
    review => { review.rectangles[0].after = [0, 0, 390]; },
    review => { review.rectangles = []; },
    review => { review.reason = ' '; },
    review => { review.navigation = []; },
  ]) {
    const reviews = structuredClone(settingsReviewed); edit(reviews[settingsKey]);
    assert.throws(() => compareDefaultView(settingsKey, settingsChanged(), settingsExpected, reviews));
  }
});
test('rectangle reviews reject stale entries even when other rectangles differ', () => {
  const reviews = structuredClone(settingsReviewed);
  reviews[settingsKey].rectangles[0].after = [...reviews[settingsKey].rectangles[0].before];
  assert.throws(() => compareDefaultView(settingsKey, settingsChanged(), settingsExpected, reviews), /remove unchanged rectangle review/);
  assert.throws(() => compareDefaultView(settingsKey, settingsExpected, settingsExpected, settingsReviewed), /remove the review/);
});
