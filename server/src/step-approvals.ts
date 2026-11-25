import { db } from './db.js';
import type { ApprovalStatus, Row, RowBody, ToolCallBody } from './types.js';

type Approval = NonNullable<ToolCallBody['approval']>;

/** One indexed lookup per page, including cards outside the loaded transcript window. */
function approvalsForCalls(botId: string, generation: number, callIds: string[]): Map<string, Approval> {
  const approvals = new Map<string, Approval>();
  if (!callIds.length) return approvals;
  const records = db.prepare(`SELECT a.id,a.call_id,a.status,card.body FROM approvals a
    JOIN rows card ON card.bot_id=a.bot_id AND card.generation=? AND card.seq=a.row_seq
    WHERE a.bot_id=? AND a.call_id IN (${callIds.map(() => '?').join(',')}) ORDER BY a.created_at`)
    .all(generation, botId, ...callIds) as { id: string; call_id: string; status: ApprovalStatus; body: string }[];
  for (const record of records) {
    const card = JSON.parse(record.body) as RowBody;
    if (card.type === 'card' && card.card === 'approval' && card.approvalId === record.id) {
      approvals.set(record.call_id, { id: record.id, status: record.status });
    }
  }
  return approvals;
}

/** Use the durable call identity, including for rows written before this link existed. */
export function withStepApproval(body: RowBody, botId: string, generation: number): RowBody {
  if (body.type !== 'tool-call') return body;
  const approval = approvalsForCalls(botId, generation, [body.callId]).get(body.callId);
  return approval || body.approval ? { ...body, approval } : body;
}

/** Transcript readers supply a single Bot and generation. Never query once per step. */
export function withStepApprovals(rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const callIds = rows.flatMap(row => row.body.type === 'tool-call' ? [row.body.callId] : []);
  const approvals = approvalsForCalls(rows[0].botId, rows[0].generation, [...new Set(callIds)]);
  return rows.map(row => {
    if (row.body.type !== 'tool-call') return row;
    const approval = approvals.get(row.body.callId);
    return approval || row.body.approval ? { ...row, body: { ...row.body, approval } } : row;
  });
}

/** Advance step revisions with the card so SSE and reconnects see the same decision. */
export function approvalSteps(botId: string, generation: number, approvalId: string, cardSeq: number) {
  return db.prepare(`SELECT r.seq,r.body FROM rows r JOIN approvals a ON a.bot_id=r.bot_id
    AND a.call_id=json_extract(r.body,'$.callId') WHERE a.id=? AND a.bot_id=? AND a.row_seq=?
    AND r.generation=? AND json_extract(r.body,'$.type')='tool-call'`)
    .all(approvalId, botId, cardSeq, generation) as { seq: number; body: string }[];
}
