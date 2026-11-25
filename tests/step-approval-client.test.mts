import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ApprovalStatus, Bot, Row, ToolCallBody } from '../server/src/types.js';
import { useStore } from '../web/src/store.js';
import { api } from '../web/src/lib/api.js';
import { stepApprovalOutcome } from '../web/src/lib/stepApproval.js';

const botId = 'approval-bot', approvalId = 'approval-fixture';
const tool: ToolCallBody = { type: 'tool-call', callId: 'draft-call', name: 'SWARM_APPS_EXECUTE', label: 'Gmail: Create email draft', status: 'awaiting-approval', approval: { id: approvalId, status: 'pending' } };
const step = (body = tool, updatedSeq = 1): Row => ({ botId, generation: 1, seq: 1, updatedSeq, kind: 'tool-call', body, createdAt: 1 });
const card = (status: ApprovalStatus = 'pending', updatedSeq = 2): Row => ({ botId, generation: 1, seq: 2, updatedSeq, kind: 'card', createdAt: 2, body: { type: 'card', card: 'approval', approvalId, title: 'Allow a draft?', detail: '', tool: tool.name, args: {}, status } });
function setup(rows = [step(), card()]) {
  useStore.setState({ ...useStore.getInitialState(), user: { id: 'fixture-owner' } as any, bots: [{ id: botId, generation: 1 } as Bot], transcripts: { [botId]: { generation: 1, bySeq: Object.fromEntries(rows.map(r => [r.seq, r])), loaded: true } } }, true);
}
const outcome = () => stepApprovalOutcome(useStore.getState().transcripts[botId].bySeq[1].body as ToolCallBody, useStore.getState().approvalDecisions)?.label;
const event = (...rows: Row[]) => useStore.getState().handleEvent({ type: 'rows', botId, generation: 1, rows });
afterEach(() => useStore.setState(useStore.getInitialState(), true));

for (const [decision, status, label] of [['deny', 'denied', 'Not allowed'], ['allow', 'allowed', 'Allowed once'], ['always', 'always', 'Always allowed']] as const) {
  test(`R10-1: ${decision} updates card and step synchronously before HTTP, SSE or a reply`, async t => {
    setup();
    const response = Promise.withResolvers<{ ok: true; status: ApprovalStatus }>();
    t.mock.method(api, 'approve', () => response.promise);
    const request = useStore.getState().decideApproval(approvalId, decision);
    assert.equal(outcome(), label);
    assert.deepEqual(useStore.getState().approvalDecisions[approvalId], { status, pending: true });
    event(step({ ...tool, approval: undefined }, 9));
    assert.equal(outcome(), label, 'late execution event without the link cannot restore waiting');
    response.resolve({ ok: true, status }); await request;
    assert.deepEqual(useStore.getState().approvalDecisions[approvalId], { status });
    assert.equal(outcome(), label);
  });
}

test('R10-1: failed decision rolls back both views and returns a retryable error', async t => {
  setup(); const response = Promise.withResolvers<never>();
  t.mock.method(api, 'approve', () => response.promise);
  const request = useStore.getState().decideApproval(approvalId, 'deny');
  assert.equal(outcome(), 'Not allowed');
  event(step(tool, 10), card());
  response.reject(new Error('offline'));
  await assert.rejects(request, /Could not save your decision. Please try again./);
  assert.equal(outcome(), undefined);
  assert.equal(useStore.getState().approvalDecisions[approvalId], undefined);
  assert.equal((useStore.getState().transcripts[botId].bySeq[2].body as any).status, 'pending');
});

for (const [status, label] of [['denied', 'Not allowed'], ['expired', 'Expired'], ['allowed', 'Allowed once'], ['always', 'Always allowed']] as const) {
  test(`R10-1: ${status} survives reload, second-client SSE, stale snapshots and late waiting events`, async t => {
    setup(); event(card(status, 3));
    assert.equal(outcome(), label);
    event(step({ ...tool, approval: { id: approvalId, status } }, 4));
    event(step(tool, 20), card('pending', 21));
    assert.equal(outcome(), label);
    t.mock.method(api, 'rows', async () => ({ generation: 1, rows: [step(tool, 30), card('pending', 31)] }));
    await useStore.getState().loadRows(botId);
    assert.equal(outcome(), label);
    // A fresh store knows only the enriched step, even if the card is on another page.
    setup([step({ ...tool, approval: { id: approvalId, status } })]);
    assert.equal(outcome(), label);
    event(step({ ...tool, status: 'running', approval: undefined }, 40));
    assert.equal(outcome(), status === 'denied' || status === 'expired' ? label : undefined, 'allowed calls advance to execution without claiming success');
  });
}

test('R10-1: authoritative SSE or HTTP wins a competing decision and transport failure cannot undo confirmation', async t => {
  setup(); const response = Promise.withResolvers<never>();
  t.mock.method(api, 'approve', () => response.promise);
  const request = useStore.getState().decideApproval(approvalId, 'deny');
  event(card('allowed', 5)); response.reject(new Error('lost response')); await request;
  assert.equal(outcome(), 'Allowed once');
  setup(); t.mock.method(api, 'approve', async () => ({ ok: true, status: 'expired' }));
  await useStore.getState().decideApproval(approvalId, 'allow');
  assert.equal(outcome(), 'Expired');
});

test('R10-1: delayed confirmation cannot cross an account change', async t => {
  setup(); const response = Promise.withResolvers<{ ok: true; status: ApprovalStatus }>();
  t.mock.method(api, 'approve', () => response.promise);
  const request = useStore.getState().decideApproval(approvalId, 'deny');
  useStore.getState().set({ user: { id: 'another-owner' } as any });
  response.resolve({ ok: true, status: 'denied' }); await request;
  assert.deepEqual(useStore.getState().approvalDecisions, {});
});
