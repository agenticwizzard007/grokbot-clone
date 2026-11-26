import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import { approvalBinding } from '../security/approval.js';
import { executionPolicyFor } from './tools.js';

// Review tools run outside the chat queue. Their cards must not resume a pending chat turn.
db.exec(`CREATE TABLE IF NOT EXISTS review_action_approvals (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE
)`);
export const isReviewApproval = (id: string) => !!db.prepare('SELECT 1 FROM review_action_approvals WHERE approval_id=?').get(id);

export function expireReviewApprovals(jobId: string) {
  const rows = db.prepare(`SELECT a.id,a.bot_id,a.row_seq FROM approvals a JOIN review_action_approvals r ON r.approval_id=a.id
    JOIN rows c ON c.bot_id=a.bot_id AND c.seq=a.row_seq WHERE a.status='pending' AND json_extract(c.body,'$.jobId')=?`).all(jobId) as { id: string; bot_id: string; row_seq: number }[];
  for (const approval of rows) {
    db.prepare("UPDATE approvals SET status='expired',resolved_at=? WHERE id=? AND status='pending'").run(now(), approval.id);
    const row = getRow(approval.bot_id, approval.row_seq);
    if (row?.body.type === 'card' && row.body.card === 'approval') updateRow(approval.bot_id, approval.row_seq, { ...row.body, status: 'expired' });
  }
}

export async function approveReviewAction(ctx: { userId: string; botId: string; jobId: string }, name: string, args: unknown, signal: AbortSignal, guard: () => void): Promise<boolean> {
  const policy = await executionPolicyFor(ctx.userId, name, args, ctx.botId);
  guard();
  if (policy.decision !== 'ask') return policy.decision === 'allow';
  const id = newId('apr'), callId = newId('review_tool');
  const card = db.transaction(() => {
    const row = appendRow(ctx.botId, 'card', { type: 'card', card: 'approval', approvalId: id, jobId: ctx.jobId,
      title: `Allow ${getBotRow(ctx.botId).name} to ${policy.title}?`, detail: 'Requested while reviewing memory and skills.', tool: name, args, status: 'pending' });
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at,binding_hash) VALUES (?,?,?,?,?,?,?,?)').run(id, ctx.botId, row.seq, callId, policy.key, 'pending', now(), approvalBinding(ctx.userId, ctx.botId, callId, name, args));
    db.prepare('INSERT INTO review_action_approvals(approval_id) VALUES (?)').run(id);
    return row;
  })();
  try {
    for (;;) {
      signal.throwIfAborted(); guard();
      const row = db.prepare('SELECT status FROM approvals WHERE id=?').get(id) as { status: string } | undefined;
      if (row?.status !== 'pending') return row?.status === 'allowed' || row?.status === 'always';
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (db.prepare("UPDATE approvals SET status='expired',resolved_at=? WHERE id=? AND status='pending'").run(now(), id).changes) {
      const row = getRow(ctx.botId, card.seq);
      if (row?.body.type === 'card' && row.body.card === 'approval') updateRow(ctx.botId, card.seq, { ...row.body, status: 'expired' });
    }
  }
}
