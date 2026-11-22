// Agent exchange summaries and id redaction: pure helpers, no server or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeExchangeText, SUMMARY_LIMIT } from '../web/src/lib/exchangeSummary.ts';
import { stripInternalIds } from '../web/src/lib/stripInternalIds.ts';
import { redactInternalIds, hasInternalId } from '../server/src/lib/redact.ts';

const detailed = "The Monday routine is set. QA TEST bot does not start schedules, so I created it here.\n\n- Routine: Monday OK (`rt_aukPXFs6dQee`)\n- Schedule: every Monday at 9:00 AM UTC (`0 9 * * 1`)\n- Enabled: yes\n\nThe original request did not name a timezone, so this is UTC.";

test('a detailed hand-off is summarized to its opening sentences', () => {
  const { summary, truncated } = summarizeExchangeText(detailed);
  assert.equal(summary, 'The Monday routine is set. QA TEST bot does not start schedules, so I created it here.');
  assert.equal(truncated, true);
  assert.doesNotMatch(summary, /Schedule|rt_|Enabled/);
});

test('a long request is capped without cutting a word', () => {
  const long = `Please ${'review every source and compare the results carefully '.repeat(8)}today.`;
  const { summary } = summarizeExchangeText(long);
  assert.ok(summary.length <= SUMMARY_LIMIT, summary);
  assert.match(summary, /\w…$/);
});

test('the result header becomes a flag and short text is kept whole', () => {
  const { summary, result, truncated } = summarizeExchangeText('[Internal result for request req_11evEvIvCvnX; execution finished]\nDone.');
  assert.deepEqual({ summary, result, truncated }, { summary: 'Done.', result: true, truncated: false });
});

test('list-only messages read as one line', () => {
  assert.equal(summarizeExchangeText('- Check sources\n- Draft the brief').summary, 'Check sources; Draft the brief');
});

test('web and server redaction cover routine and other Swarm ids', () => {
  for (const redact of [stripInternalIds, redactInternalIds]) {
    assert.equal(redact('- Routine: Monday OK (`rt_aukPXFs6dQee`)'), '- Routine: Monday OK');
    assert.equal(redact('See `rt_aukPXFs6dQee` now'), 'See routine now');
    assert.equal(redact('request req_11evEvIvCvnX done'), 'request done');
    assert.equal(redact('Slack account ca_KIxihCKrE-D2'), 'Slack account');
    assert.equal(redact('cron (`0 9 * * 1`) and call_center_notes stay'), 'cron (`0 9 * * 1`) and call_center_notes stay');
  }
  assert.equal(hasInternalId('goal goal_AbCdEf123456'), true);
  assert.equal(redactInternalIds('Goal goal_AbCdEf123456 is done'), 'Goal is done');
  assert.equal(redactInternalIds('  - nested item\n    code  block'), '  - nested item\n    code  block', 'unchanged text keeps its spacing');
});
