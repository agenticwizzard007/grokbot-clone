import assert from 'node:assert/strict';
import test from 'node:test';
import { setupResourceText, setupFileText } from '../web/src/components/config/setupResources.ts';
import { historySummary } from '../web/src/components/config/historyCopy.ts';

test('customer Setup copy translates connection states in older saved sentences', () => {
  assert.equal(setupResourceText('toolkit slack, revision 1, was EXPIRED'), 'Slack connection expired');
  assert.equal(setupResourceText('Gmail account is ACTIVE at revision 1'), 'Gmail connected');
  for (const state of ['ACTIVE', 'EXPIRED', 'REVOKED', 'FAILED', 'PENDING', 'DISCONNECTED']) {
    assert.doesNotMatch(setupResourceText(`toolkit gmail, revision 7, was ${state}`), /toolkit|revision|ACTIVE|EXPIRED|REVOKED|FAILED|PENDING|DISCONNECTED/);
  }
  assert.equal(setupResourceText('Keep the active project notes in https://example.test/notes.'), 'Keep the active project notes in https://example.test/notes.');
});

test('customer Setup file preview preserves Markdown and leaves the source unchanged', () => {
  const source = '# Resources\n\nRevision: 32\n- toolkit slack, revision 1, was EXPIRED\n  - Keep notes.';
  assert.equal(setupFileText(source), '# Resources\n\n\n- Slack connection expired\n  - Keep notes.');
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
