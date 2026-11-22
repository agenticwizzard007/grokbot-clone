import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactInternalIds, redactDeep, hasInternalId } from '../server/src/lib/redact.js';
import { stripInternalIds, displayExchangeText, INTERNAL_ID_PATTERN } from '../web/src/lib/stripInternalIds.js';

test('R2F-002: routine ids are filtered from assistant, notice and approval display fields', () => {
  const fields = {
    assistant: 'Created rt_aukPXFs6dQee for bot_AbCdEf123456.',
    notice: 'Request req_AbCdEf123456 is waiting for apr_AbCdEf123456.',
    title: 'Run rt_nbjlbdBm97MG',
    detail: 'Account: ca_KIxihCKrE-D2\nAccount: ca_pESfPrEqcgnN',
    args: { account: 'ca_AbCdEf123456', routine: 'rt_AbCdEf123456', nested: ['cli_AbCdEf123456'] },
  };
  const botName = (id: string) => id === 'bot_AbCdEf123456' ? 'Research' : undefined;
  const clean = redactDeep(fields, { botName });
  assert.equal(clean.assistant, 'Created routine for Research.');
  assert.equal(clean.args.routine, 'routine');
  assert.equal(hasInternalId(JSON.stringify(clean)), false);
  for (const input of [fields.assistant, fields.notice, fields.title, fields.detail, JSON.stringify(fields.args)]) {
    assert.doesNotMatch(stripInternalIds(input, { botName }), INTERNAL_ID_PATTERN);
  }
  assert.equal(stripInternalIds(fields.assistant, { botName }), 'Created routine for Research.');
  assert.equal(displayExchangeText('Run rt_aukPXFs6dQee tomorrow').text, 'Run routine tomorrow');
});

test('R2F-002: all listed prefixes are filtered while ordinary snake_case stays readable', () => {
  for (const prefix of ['ca', 'req', 'apr', 'cli', 'call', 'job', 'room', 'connect', 'bot', 'rt']) {
    const input = `${prefix}_AbCdEf123456`;
    assert.equal(hasInternalId(input), true);
    assert.notEqual(redactInternalIds(input), input);
    assert.doesNotMatch(stripInternalIds(input), INTERNAL_ID_PATTERN);
  }
  for (const text of ['call_center_notes', 'bot_configuration', 'rt_schedule_notes', 'prereq_AbCdEf123456']) {
    assert.equal(stripInternalIds(text), text);
    assert.equal(redactInternalIds(text), text);
  }
});
