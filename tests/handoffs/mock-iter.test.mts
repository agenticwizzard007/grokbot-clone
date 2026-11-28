import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checks, goals, iterationScript } from './mock-iter.mjs';

for (const mode of ['converge', 'cap'] as const) test(`${mode}: real drafts and submitted verdicts agree on all three checks`, () => {
  const drafts = new Set<string>();
  for (let iteration = 1; iteration <= 3; iteration++) {
    const packet = `${goals[mode]}\niteration ${iteration} of 3`;
    const draft = iterationScript(packet)!.replace(/^say /, '');
    drafts.add(draft);
    const actual = [draft.includes('Version 1.0'), draft.split(/\s+/).length < 60, draft.endsWith('Try the release.')];
    const exit = { mode: 'checklist', items: checks.map((text: string, i: number) => ({ id: `check-${i}`, text, required: true })) };
    const script = iterationScript(`${packet}\nHOW TO ANSWER\nReview the output against ${JSON.stringify(exit)}. Submit your verdict with submit_verdict`)!;
    const verdict = JSON.parse(script.match(/^submit_verdict (.+) \| say /)![1]);
    assert.deepEqual(verdict.checklist.map((item: { pass: boolean }) => item.pass), actual);
    assert.equal(verdict.pass, actual.every(Boolean));
    assert.equal(actual.filter(Boolean).length, mode === 'converge' ? iteration : 1);
    assert.doesNotMatch(draft, /mock:|undefined|HO-H|[\u2013\u2014]/);
    assert.equal(draft.split('\n').length, 3);
  }
  assert.equal(drafts.size, 3, 'Each pass has a distinct draft, so the cap journey does not stall early');
});
