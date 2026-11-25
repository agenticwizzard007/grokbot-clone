import type { ApprovalStatus, Row, ToolCallBody } from '@shared/types';

export type ApprovalDecision = { status: Exclude<ApprovalStatus, 'pending'>; pending?: boolean };
export type ApprovalDecisions = Partial<Record<string, ApprovalDecision>>;
export const APPROVAL_OUTCOME = { allowed: 'Allowed once', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };

/** Execution events may carry an older body without the approval link. */
export function withKnownStepApproval(incoming: Row, current?: Row): Row {
  if (incoming.body.type !== 'tool-call' || current?.body.type !== 'tool-call'
    || incoming.botId !== current.botId || incoming.generation !== current.generation
    || incoming.body.callId !== current.body.callId || !current.body.approval) return incoming;
  const known = current.body.approval, next = incoming.body.approval;
  if (!next || (next.id === known.id && next.status === 'pending' && known.status !== 'pending')) {
    return { ...incoming, body: { ...incoming.body, approval: known } };
  }
  return incoming;
}

/** A server decision confirms an optimistic choice. Later waiting events cannot undo it. */
export function confirmedApprovals(current: ApprovalDecisions, rows: Row[]): ApprovalDecisions {
  let next = current;
  for (const { body } of rows) {
    const approval = body.type === 'tool-call' ? body.approval
      : body.type === 'card' && body.card === 'approval' ? { id: body.approvalId, status: body.status } : undefined;
    if (!approval || approval.status === 'pending') continue;
    const known = next[approval.id];
    if (known && !known.pending) continue;
    if (next === current) next = { ...current };
    next[approval.id] = { status: approval.status };
  }
  return next;
}

/** Permission never claims execution succeeded. Once running, allowed calls show normal progress. */
export function stepApprovalOutcome(body: ToolCallBody, decisions: ApprovalDecisions) {
  const status = body.approval && (decisions[body.approval.id]?.status ?? body.approval.status);
  if (!status || status === 'pending') return undefined;
  if (status === 'denied' || status === 'expired' || body.status === 'awaiting-approval') {
    return { status, label: APPROVAL_OUTCOME[status] };
  }
  return undefined;
}
