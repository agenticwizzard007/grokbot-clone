import { db } from './db.js';
import type { ActiveCall } from './voice-registry.js';
import type { CardBody, RowBody, VoiceApprovalReference } from './types.js';

type ApprovalCard = Extract<CardBody, { card: 'approval' }>;

/** Both the durable decision and its card must still be pending. Historical prose is not state. */
export function pendingVoiceApproval(botId: string, generation: number, seq: number, body: ApprovalCard, call?: ActiveCall): boolean {
  if (body.status !== 'pending') return false;
  const baseline = call?.connectionBaseline.get(botId);
  if (call && (!baseline || baseline.generation !== generation || seq <= baseline.seq)) return false;
  return !!db.prepare(`SELECT 1 FROM approvals WHERE id=? AND bot_id=? AND row_seq=? AND status='pending'
    AND (? IS NULL OR created_at>=?)`).get(body.approvalId, botId, seq, call?.startedAt ?? null, call?.startedAt ?? null);
}

/** Freeze membership at call end, never the decision. */
export function callApprovalReferences(call: ActiveCall, endedAt: number, endSequences: Map<string, number>): VoiceApprovalReference[] {
  const botIds = [...new Set([call.botId, ...call.jobs.map(job => job.botId)])];
  const pending: VoiceApprovalReference[] = [];
  for (const botId of botIds) {
    const baseline = call.connectionBaseline.get(botId);
    if (!baseline) continue;
    const rows = db.prepare(`SELECT r.seq,r.body,b.name FROM approvals a
      JOIN bots b ON b.id=a.bot_id JOIN rows r ON r.bot_id=a.bot_id AND r.seq=a.row_seq AND r.generation=b.generation
      WHERE b.id=? AND b.user_id=? AND b.generation=? AND r.seq>? AND r.seq<=? AND a.created_at>=? AND a.created_at<=?
      AND a.status='pending' AND a.id=json_extract(r.body,'$.approvalId') AND json_extract(r.body,'$.card')='approval' AND json_extract(r.body,'$.status')='pending'
      AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'
      ORDER BY r.seq`).all(botId, call.userId, baseline.generation, baseline.seq, endSequences.get(botId) ?? baseline.seq, call.startedAt, endedAt) as { seq: number; body: string; name: string }[];
    for (const row of rows) {
      const body = JSON.parse(row.body) as ApprovalCard;
      pending.push({ approvalId: body.approvalId, botId, generation: baseline.generation, rowSeq: row.seq, botName: row.name, detail: voiceApprovalDetail(body) });
    }
  }
  return pending;
}

/** Shared by API snapshots, SSE, sidebar previews and voice context. No prose matching. */
export function serializeVoiceCall(body: RowBody, userId: string, forVoice = false): RowBody {
  if (body.type !== 'event' || body.event !== 'voice-call' || body.call?.phase !== 'ended') return body;
  const call = body.call;
  if (!call.baseText || !call.approvals) {
    // Older pills contain no approval IDs. Preserve the UI history, but do not
    // supply a frozen status or model recollection as current voice context.
    const safeDiscussion = discussionSummary(body.text, [call.summary ?? '', ...(call.transcript ?? []).map(line => line.text)]);
    return forVoice && !safeDiscussion
      ? { ...body, text: 'Historical voice call ended. Approval status was not recorded.', call: { ...call, summary: undefined, transcript: undefined } }
      : body;
  }
  const groups = new Map<string, VoiceApprovalReference[]>();
  for (const ref of call.approvals) {
    const decision = db.prepare(`SELECT a.status FROM approvals a JOIN bots b ON b.id=a.bot_id
      JOIN rows r ON r.bot_id=a.bot_id AND r.seq=a.row_seq AND r.generation=?
      WHERE a.id=? AND a.bot_id=? AND a.row_seq=? AND b.user_id=?
      AND json_extract(r.body,'$.approvalId')=a.id AND json_extract(r.body,'$.card')='approval'
      AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'`)
      .get(ref.generation, ref.approvalId, ref.botId, ref.rowSeq, userId) as { status: string } | undefined;
    const status = decision?.status === 'always' ? 'allowed' : decision?.status ?? 'unavailable';
    const group = groups.get(status) ?? [];
    group.push(ref); groups.set(status, group);
  }
  const sentences = [...groups].map(([status, refs]) => {
    const count = refs.length;
    const noun = `${count} ${count === 1 ? 'approval' : 'approvals'} from this call`;
    const verb = count === 1 ? 'was' : 'were';
    const state = status === 'pending' ? `${count === 1 ? 'is' : 'are'} still pending in ${count === 1 ? `${refs[0].botName}'s chat` : 'chat'}`
      : status === 'allowed' ? `${verb} allowed` : status === 'denied' ? `${verb} not allowed`
      : status === 'expired' ? 'expired' : `${count === 1 ? 'has' : 'have'} no current status available`;
    return `${noun} ${state}: ${refs.map(ref => ref.detail).join('; ')}`;
  });
  const summary = [call.discussion, sentences.join('. ')].filter(Boolean).join(' ');
  return { ...body, text: summary ? `${call.baseText}. ${summary}` : call.baseText, call: { ...call, summary: summary || undefined } };
}

/** Locate only exact references in current conversations belonging to the same account. */
export function voiceCallsReferencing(userId: string, botId: string, generation: number, rowSeq: number, approvalId: string) {
  return db.prepare(`SELECT r.bot_id,r.seq,r.body FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    WHERE b.user_id=? AND r.kind='event' AND json_extract(r.body,'$.event')='voice-call'
    AND EXISTS (SELECT 1 FROM json_each(r.body,'$.call.approvals') ref
      WHERE json_extract(ref.value,'$.approvalId')=? AND json_extract(ref.value,'$.botId')=?
      AND json_extract(ref.value,'$.generation')=? AND json_extract(ref.value,'$.rowSeq')=?)`)
    .all(userId, approvalId, botId, generation, rowSeq) as { bot_id: string; seq: number; body: string }[];
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
