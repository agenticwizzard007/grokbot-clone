import { db } from './db.js';
import type { ApprovalStatus, RowBody } from './types.js';

/** Use the durable call identity, including for rows written before this link existed. */
export function withStepApproval(body: RowBody, botId: string, generation: number): RowBody {
  if (body.type !== 'tool-call') return body;
  const approval = db.prepare(`SELECT a.id,a.status FROM approvals a
    JOIN rows card ON card.bot_id=a.bot_id AND card.seq=a.row_seq AND card.generation=?
    WHERE a.bot_id=? AND a.call_id=? AND json_extract(card.body,'$.approvalId')=a.id
    AND json_extract(card.body,'$.card')='approval' ORDER BY a.created_at DESC LIMIT 1`)
    .get(generation, botId, body.callId) as { id: string; status: ApprovalStatus } | undefined;
  return approval || body.approval ? { ...body, approval } : body;
}

/** Advance step revisions with the card so SSE and reconnects see the same decision. */
export function approvalSteps(botId: string, generation: number, approvalId: string, cardSeq: number) {
  return db.prepare(`SELECT r.seq,r.body FROM rows r JOIN approvals a ON a.bot_id=r.bot_id
    AND a.call_id=json_extract(r.body,'$.callId') WHERE a.id=? AND a.bot_id=? AND a.row_seq=?
    AND r.generation=? AND json_extract(r.body,'$.type')='tool-call'`)
    .all(approvalId, botId, cardSeq, generation) as { seq: number; body: string }[];
}
