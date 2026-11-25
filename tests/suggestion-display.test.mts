import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileSuggestionDisplay } from '../web/src/lib/suggestionDisplay.ts';

const slack = { slug: 'slack', name: 'Slack', categories: [], noAuth: false, reason: 'Slack was suggested for this Bot.' };
const github = { ...slack, slug: 'github', name: 'GitHub', reason: 'GitHub was suggested for this Bot.' };
const rankedSlack = { ...slack, reason: "Slack is named in this Bot's work." };
const rankedGithub = { ...github, reason: "GitHub is named in this Bot's work." };

test('quiet refresh preserves saved reasons and order for the same app set', () => {
  const previous = [slack, github];
  const next = [rankedGithub, rankedSlack];
  assert.deepEqual(reconcileSuggestionDisplay(previous, next, true), previous);
  assert.equal(next[1].reason, rankedSlack.reason, 'fresh cache data is not mutated');
});

test('adding, removing or replacing an app displays the new set and reasons', () => {
  for (const [previous, next] of [[[slack], [rankedSlack, rankedGithub]], [[slack, github], [rankedGithub]], [[slack], [rankedGithub]], [[slack], []]]) {
    assert.deepEqual(reconcileSuggestionDisplay(previous, next, true), next);
  }
});

test('explicit actions and first results display current reasons', () => {
  assert.deepEqual(reconcileSuggestionDisplay([slack], [rankedSlack], false), [rankedSlack]);
  assert.deepEqual(reconcileSuggestionDisplay(undefined, [rankedSlack], true), [rankedSlack]);
});
