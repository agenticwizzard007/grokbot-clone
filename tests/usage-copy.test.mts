import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportRangeLabel, requestHeadline, tokenCoverageNote } from '../web/src/lib/usageCopy.js';

test('usage headline contains only the exact request count', () => {
  assert.equal(requestHeadline(565), '565 requests');
  assert.equal(requestHeadline(1), '1 request');
  assert.equal(requestHeadline(0), '0 requests');
  assert.equal(requestHeadline(12_345), '12,345 requests');
});

test('usage footnote omits zero-count clauses and explains reported tokens', () => {
  assert.equal(tokenCoverageNote({}), null);
  assert.equal(tokenCoverageNote({ partialUsageRequests: 0, unavailableUsageRequests: 0 }), null);
  for (const coverage of [{ partialUsageRequests: 1, unavailableUsageRequests: 0 }, { partialUsageRequests: 0, unavailableUsageRequests: 1 }]) {
    assert.equal(tokenCoverageNote(coverage), 'Token counts are incomplete for 1 request; totals include only reported tokens.');
  }
  assert.equal(tokenCoverageNote({ partialUsageRequests: 1, unavailableUsageRequests: 2 }), 'Token counts are incomplete for 3 requests; totals include only reported tokens.');
});

test('Usage and Analytics share explicit range labels with a UTC fallback', () => {
  const days = [{ day: '2026-11-19' }, { day: '2026-11-25' }];
  assert.equal(reportRangeLabel(days, 'Asia/Dubai'), 'Nov 19 to Nov 25 · Asia/Dubai');
  assert.equal(reportRangeLabel(days), 'Nov 19 to Nov 25 · UTC');
  assert.equal(reportRangeLabel(days.slice(0, 1), 'UTC'), 'Nov 19 · UTC');
});
