import { db } from './db.js';

// Stored separately from text pending_turns so voice can wait alongside agentic chat.
db.exec(`CREATE TABLE IF NOT EXISTS voice_action_approvals (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  tool_call_id TEXT,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  generation INTEGER NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0
)`);
export interface VoiceApprovedAction { approval_id: string; call_id: string; tool_call_id?: string; name: string; args: string; generation: number; bot_id: string; user_id: string; status: string; row_seq: number; action_call_id: string; binding_hash: string }
let handler: ((action: VoiceApprovedAction) => Promise<void>) | undefined;
export function bindVoiceApprovalHandler(next: typeof handler) {
  handler = next;
  // Decisions committed immediately before a restart can still dispatch once.
  for (const row of db.prepare("SELECT v.approval_id FROM voice_action_approvals v JOIN approvals a ON a.id=v.approval_id WHERE v.dispatched=0 AND a.status IN ('allowed','always','denied')").all() as { approval_id: string }[]) resumeVoiceApproval(row.approval_id);
}
export function resumeVoiceApproval(approvalId: string): boolean {
  const row = db.prepare(`SELECT v.*,a.bot_id,a.status,a.row_seq,a.call_id AS action_call_id,a.binding_hash,b.user_id FROM voice_action_approvals v
    JOIN approvals a ON a.id=v.approval_id JOIN bots b ON b.id=a.bot_id WHERE v.approval_id=?`).get(approvalId) as VoiceApprovedAction | undefined;
  if (!row) return false;
  queueMicrotask(() => {
    if (!handler || !['allowed', 'always', 'denied'].includes(row.status)) return;
    if (!db.prepare('UPDATE voice_action_approvals SET dispatched=1 WHERE approval_id=? AND dispatched=0').run(approvalId).changes) return;
    void handler(row).catch(() => console.error('[voice] approved action could not finish'));
  });
  return true;
}
