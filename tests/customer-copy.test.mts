import assert from 'node:assert/strict';
import test from 'node:test';
import { setupResourceText, setupFileText } from '../web/src/components/config/setupResources.ts';
import { customerSetupText, customerSetupValue, setupConnectionWords } from '../server/src/customer-setup-text.ts';
import { historySummary } from '../web/src/components/config/historyCopy.ts';

test('customer Setup copy translates connection states in older saved sentences', () => {
  assert.equal(setupResourceText('toolkit slack, revision 1, was EXPIRED'), 'Slack needs to be reconnected');
  assert.equal(setupResourceText('Gmail account is ACTIVE at revision 1'), 'Gmail connected');
  for (const state of ['ACTIVE', 'EXPIRED', 'REVOKED', 'FAILED', 'PENDING', 'DISCONNECTED']) {
    assert.doesNotMatch(setupResourceText(`toolkit gmail, revision 7, was ${state}`), /toolkit|revision|ACTIVE|EXPIRED|REVOKED|FAILED|PENDING|DISCONNECTED/);
  }
  assert.equal(setupResourceText('Keep the active project notes in https://example.test/notes.'), 'Keep the active project notes in https://example.test/notes.');
});

test('customer Setup file preview preserves Markdown and leaves the source unchanged', () => {
  const source = '# Resources\n\nRevision: 32\n- toolkit slack, revision 1, was EXPIRED\n  - Keep notes.';
  assert.equal(setupFileText(source), '# Resources\n\n\n- Slack needs to be reconnected\n  - Keep notes.');
  assert.match(source, /Revision: 32/);
});

test('customer history summaries name changes without internal identifiers', () => {
  assert.equal(historySummary('setup', 'updated'), 'Setup updated');
  assert.equal(historySummary('skill_proposal', 'pending'), 'Skill suggestion ready for review');
  assert.equal(historySummary('memory', 'edit'), 'Memory updated');
  assert.equal(historySummary('learning-settings', 'settings-updated'), 'Learning settings updated');
  assert.equal(historySummary('skill-lifecycle', 'suspended'), 'Skill paused');
  assert.equal(historySummary('unknown_internal_kind', 'INTERNAL_ENUM'), 'Change recorded');
});


test('all generated connection enums become plain words in Harness and Setup text', () => {
  for (const [state, words] of Object.entries(setupConnectionWords)) {
    assert.equal(customerSetupText(`Slack account is ${state}.`), `Slack ${words}.`);
    assert.equal(customerSetupText(`Connection: ${state}`), `Connection: ${words}`);
  }
  assert.equal(customerSetupText('Slack connection expired'), 'Slack needs to be reconnected');
  assert.equal(customerSetupText('Keep the active project and pending tasks.'), 'Keep the active project and pending tasks.');
});

test('customer setup rendering maps every brief field without mutating saved text or Markdown', () => {
  const source = { purpose: 'Gmail account is ACTIVE', workflows: [{ steps: ['Slack was EXPIRED'] }], style: '# Status\n\n- Email is INITIATED' };
  const snapshot = JSON.stringify(source);
  assert.deepEqual(customerSetupValue(source), { purpose: 'Gmail connected', workflows: [{ steps: ['Slack needs to be reconnected'] }], style: '# Status\n\n- Email waiting for connection' });
  assert.equal(JSON.stringify(source), snapshot);
});
