import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTimeZoneOptions, canonicalTimeZone, timeZoneOptions } from '../web/src/components/config/settingsLogic';

const winter = new Date('2026-01-15T12:00:00Z');
test('time zone labels are readable, unique and ordered by current UTC offset', () => {
  const options = buildTimeZoneOptions(null, winter);
  assert.equal(options.find(option => option.value === 'Asia/Dubai')?.label, '(UTC+04:00) Dubai');
  assert.equal(options.find(option => option.value === 'UTC')?.label, '(UTC+00:00) Coordinated Universal Time');
  assert.equal(new Set(options.map(option => option.value)).size, options.length);
  assert.ok(options.every((option, index) => !index || option.offset >= options[index - 1].offset));
  for (const option of options) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: option.value }));
});
test('time zone options map legacy aliases and keep a saved IANA zone', () => {
  assert.equal(canonicalTimeZone('Africa/Asmera'), 'Africa/Asmara');
  assert.equal(canonicalTimeZone('US/Eastern'), 'America/New_York');
  assert.equal(canonicalTimeZone('Asia/Calcutta'), 'Asia/Kolkata');
  const zones = timeZoneOptions('Africa/Asmera');
  assert.ok(zones.includes('Africa/Asmara'));
  assert.ok(!zones.includes('Africa/Asmera'));
  assert.ok(timeZoneOptions('Pacific/Marquesas').includes('Pacific/Marquesas'));
});
test('time zone offsets include fractional hours and seasonal daylight saving', () => {
  const options = buildTimeZoneOptions('Asia/Kathmandu', winter);
  assert.equal(options.find(option => option.value === 'Asia/Kathmandu')?.label, '(UTC+05:45) Kathmandu');
  assert.equal(options.find(option => option.value === 'America/New_York')?.offset, -300);
  assert.equal(buildTimeZoneOptions(null, new Date('2026-07-15T12:00:00Z')).find(option => option.value === 'America/New_York')?.offset, -240);
});
test('time zone options remain usable without supportedValuesOf', () => {
  const original = Intl.supportedValuesOf;
  try {
    Object.defineProperty(Intl, 'supportedValuesOf', { configurable: true, value: undefined });
    const options = buildTimeZoneOptions('Pacific/Marquesas', winter);
    assert.equal(options.find(option => option.value === 'Pacific/Marquesas')?.label, '(UTC-09:30) Marquesas');
    assert.ok(options.some(option => option.value === 'UTC'));
  } finally { Object.defineProperty(Intl, 'supportedValuesOf', { configurable: true, value: original }); }
});
