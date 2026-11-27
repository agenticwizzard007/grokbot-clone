import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffTurnFinished, outputPreview, withoutProviderPrefix } from '../../web/src/handoffs/presentation.ts';

test('automatic output summaries show a heading once and preserve the preview', () => {
  assert.equal(outputPreview('Release note', 'Release note\nVersion 2 improves search.'), 'Version 2 improves search.');
  assert.equal(outputPreview('Release note', 'Release note'), '');
  assert.equal(outputPreview('Draft', 'Drafting the release note.'), 'Drafting the release note.');
  assert.equal(outputPreview('', 'A complete summary.'), 'A complete summary.');
});
test('provider role prefixes are removed without changing ordinary prose', () => {
  assert.equal(withoutProviderPrefix('mock: say Review ready.'), 'Review ready.');
  assert.equal(withoutProviderPrefix('system: assistant: Review ready.'), 'Review ready.');
  assert.equal(withoutProviderPrefix('Review the release note.'), 'Review the release note.');
});
test('a completed receipt ends pending UI even with no public assistant message', () => {
  const receipt = (seq: number, status: string) => ({ seq, kind: 'handoff', body: { status } });
  for (const status of ['completed', 'failed', 'declined', 'cancelled', 'expired']) assert.equal(handoffTurnFinished([receipt(3,status)],2,false),true);
  assert.equal(handoffTurnFinished([receipt(3,'completed')],2,true),false,'a new active run keeps its indicator');
  assert.equal(handoffTurnFinished([receipt(3,'completed')],4,false),false,'old receipts cannot finish a later prompt');
  assert.equal(handoffTurnFinished([receipt(3,'completed'),receipt(4,'running')],2,false),false,'a newer receipt takes precedence');
  for (const status of ['queued', 'delivered', 'running', 'pending_approval']) assert.equal(handoffTurnFinished([receipt(3,status)],2,false),false);
  assert.equal(handoffTurnFinished([],0,false),false);
});
