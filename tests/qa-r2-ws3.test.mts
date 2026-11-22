// Round 2 WS3 fixes: analytics cumulative series (R2F-035) and app name fallback (R2F-026).
//   node --import tsx --test tests/qa-r2-ws3.test.mts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-r2-ws3-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  SERVER_URL: 'http://localhost:1', APP_URL: 'http://localhost:1', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { createAccount } = await import('../server/src/accounts.js');
const { botAnalytics } = await import('../server/src/analytics.js');
const { cumulativeHours, slotCentre } = await import('../web/src/components/config/analyticsSeries.ts');
const { toolkitDisplayName } = await import('../web/src/components/config/settingsLogic.ts');

const userId = createAccount({ email: 'analytics@example.test', name: 'Analytics' }).id;
const botId = (db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY created_at LIMIT 1').get(userId) as { id: string }).id;
let seq = 1;
const reply = (createdAt: number, words: number) => db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(botId, 1, seq++, 1, 'message', JSON.stringify({ type: 'message', role: 'assistant', text: Array(words).fill('word').join(' ') }), createdAt);
const isNonDecreasing = (values: number[]) => values.every((value, i) => i === 0 || value >= values[i - 1]);

test('R2F-035: day buckets are consecutive local days and the cumulative series never falls', () => {
  // A week that crosses the US daylight saving change (8 Mar 2026), seen from two zones.
  const now = Date.UTC(2026, 2, 10, 6, 30); // 9 Mar 23:30 in Los Angeles, 10 Mar 10:30 in Dubai
  for (let hoursAgo = 0; hoursAgo < 7 * 24; hoursAgo += 5) reply(now - hoursAgo * 3_600_000, 40 + (hoursAgo % 7) * 40);
  reply(now - 60_000, 400); // the last minute counts in today's bucket
  for (const zone of ['America/Los_Angeles', 'Asia/Dubai', 'UTC', 'Pacific/Kiritimati']) {
    const result = botAnalytics(botId, '7d', now, zone);
    const keys = result.days.map(day => day.day);
    assert.deepEqual(keys, [...keys].sort(), `${zone}: calendar order`);
    for (let i = 1; i < keys.length; i++) assert.equal(Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`), 86_400_000, `${zone}: consecutive days`);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    assert.equal(keys.at(-1), today, `${zone}: the last bucket is today`);
    assert.ok(result.days.at(-1)!.minutesSaved >= 10, `${zone}: today's work is in the last bucket`);
    assert.ok(result.days.every(day => day.minutesSaved >= 0), `${zone}: no negative days`);
    const series = cumulativeHours(result.days);
    assert.ok(isNonDecreasing(series), `${zone}: cumulative series is non-decreasing`);
    assert.equal(series.indexOf(Math.max(...series)), series.length - 1, `${zone}: the peak is the last bucket`);
    assert.ok(Math.abs(series.at(-1)! * 60 - result.totals.minutesSaved) < 0.5, `${zone}: the final value equals the total`);
  }
});

test('R2F-035: the chart series sorts by day and ignores bad values', () => {
  const days = [
    { day: '2026-11-22', messages: 1, minutesSaved: 30 },
    { day: '2026-11-20', messages: 1, minutesSaved: 60 },
    { day: '2026-11-21', messages: 0, minutesSaved: -5 },
    { day: '2026-11-19', messages: 0, minutesSaved: Number.NaN },
  ];
  const series = cumulativeHours(days);
  assert.deepEqual(series, [0, 1, 1, 1.5]);
  assert.ok(isNonDecreasing(series));
  assert.equal(slotCentre(6, 7), 13 / 14, 'the last point sits at the centre of the last slot, like its date label');
});

test('R2F-026: unknown toolkit slugs read as title-cased names', () => {
  assert.equal(toolkitDisplayName('notion'), 'Notion');
  assert.equal(toolkitDisplayName('slack', null), 'Slack');
  assert.equal(toolkitDisplayName('googlecalendar'), 'Google Calendar');
  assert.equal(toolkitDisplayName('zoho_crm'), 'Zoho Crm');
  assert.equal(toolkitDisplayName('linear-app'), 'Linear App');
  assert.equal(toolkitDisplayName('notion', 'Notion Workspace'), 'Notion Workspace', 'the catalog name wins');
  assert.equal(toolkitDisplayName('notion', '  '), 'Notion', 'a blank catalog name falls back');
});
