import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportDay, reportDayStart, reportTimezone } from '../server/src/report-days.js';

test('report days cross the account midnight instead of UTC midnight', () => {
  assert.equal(reportDay(Date.parse('2026-11-22T19:59:59Z'), 'Asia/Dubai'), '2026-11-22');
  assert.equal(reportDay(Date.parse('2026-11-22T20:00:00Z'), 'Asia/Dubai'), '2026-11-23');
  assert.equal(reportDayStart('2026-11-23', 'Asia/Dubai'), Date.parse('2026-11-22T20:00:00Z'));
  assert.equal(reportDay(Date.parse('2026-11-23T07:59:59Z'), 'America/Los_Angeles'), '2026-11-22');
});

test('report boundaries handle short, long and shifted-midnight DST days', () => {
  const hours = (a: string, b: string, zone: string) => (reportDayStart(b, zone) - reportDayStart(a, zone)) / 3_600_000;
  assert.equal(hours('2026-03-08', '2026-03-09', 'America/New_York'), 23);
  assert.equal(hours('2026-11-01', '2026-11-02', 'America/New_York'), 25);
  assert.equal(reportDayStart('2018-11-04', 'America/Sao_Paulo'), Date.parse('2018-11-04T03:00:00Z'));
});

test('unset or invalid account time zones fall back to UTC', () => {
  assert.equal(reportTimezone(null), 'UTC');
  assert.equal(reportTimezone('invalid/zone'), 'UTC');
  assert.equal(reportTimezone('Asia/Dubai'), 'Asia/Dubai');
});
