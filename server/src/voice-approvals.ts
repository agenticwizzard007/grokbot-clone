import { db } from './db.js';
import type { ActiveCall } from './voice-registry.js';
import type { CardBody } from './types.js';

type ApprovalCard = Extract<CardBody, { card: 'approval' }>;

/** Both the durable decision and its card must still be pending. Historical prose is not state. */
export function pendingVoiceApproval(botId: string, generation: number, seq: number, body: ApprovalCard, call?: ActiveCall): boolean {
  if (body.status !== 'pending') return false;
  const baseline = call?.connectionBaseline.get(botId);
  if (call && (!baseline || baseline.generation !== generation || seq <= baseline.seq)) return false;
  return !!db.prepare(`SELECT 1 FROM approvals WHERE id=? AND bot_id=? AND row_seq=? AND status='pending'
    AND (? IS NULL OR created_at>=?)`).get(body.approvalId, botId, seq, call?.startedAt ?? null, call?.startedAt ?? null);
}

/** Re-read at the instant the system pill is written, after any asynchronous summary work. */
export function callApprovalSummary(call: ActiveCall, endedAt: number, endSequences: Map<string, number>): string | null {
  const botIds = [...new Set([call.botId, ...call.jobs.map(job => job.botId)])];
  const pending: { botName: string; body: ApprovalCard }[] = [];
  for (const botId of botIds) {
    const baseline = call.connectionBaseline.get(botId);
    if (!baseline) continue;
    const rows = db.prepare(`SELECT r.seq,r.body,b.name FROM approvals a
      JOIN bots b ON b.id=a.bot_id JOIN rows r ON r.bot_id=a.bot_id AND r.seq=a.row_seq AND r.generation=b.generation
      WHERE b.id=? AND b.user_id=? AND b.generation=? AND r.seq>? AND r.seq<=? AND a.created_at>=? AND a.created_at<=?
      AND a.status='pending' AND a.id=json_extract(r.body,'$.approvalId') AND json_extract(r.body,'$.card')='approval' AND json_extract(r.body,'$.status')='pending'
      AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'
      ORDER BY r.seq`).all(botId, call.userId, baseline.generation, baseline.seq, endSequences.get(botId) ?? baseline.seq, call.startedAt, endedAt) as { seq: number; body: string; name: string }[];
    for (const row of rows) pending.push({ botName: row.name, body: JSON.parse(row.body) });
  }
  if (!pending.length) return null;
  if (pending.length > 1) return `${pending.length} approvals from this call are still pending in chat.`;
  const { botName, body } = pending[0];
  return `1 approval from this call is still pending in ${botName}'s chat: ${voiceApprovalDetail(body)}`;
}

export function voiceApprovalDetail(body: ApprovalCard): string {
  const args = body.args as { tool_slug?: unknown; arguments?: { subject?: unknown } } | null;
  // Quote only the exact persisted Gmail subject, never a model's recollection of it.
  const subject = args?.tool_slug === 'GMAIL_CREATE_EMAIL_DRAFT' && typeof args.arguments?.subject === 'string' ? args.arguments.subject : null;
  return subject !== null ? `Gmail draft with subject ${JSON.stringify(subject)}` : body.title;
}

/** Generated discussion prose must never supply approval facts or email subjects. */
export function discussionSummary(text: string, sources: string[]): string | null {
  // When approval or subject details were discussed, retain only the verified record below.
  // This also rejects paraphrases of a stale assistant statement, not just literal repeats.
  const approvalTopic = /approv|pending|permission|allow|declin|denied|expired|subject|consent|await|waiting|decision/i;
  return [text, ...sources].some(source => approvalTopic.test(source)) ? null : text || null;
}
