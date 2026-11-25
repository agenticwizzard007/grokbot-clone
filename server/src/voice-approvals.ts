import { db } from './db.js';
import type { ActiveCall } from './voice-registry.js';
import type { CardBody, RowBody, VoiceApprovalReference } from './types.js';

type ApprovalCard = Extract<CardBody, { card: 'approval' }>;
type CallLocation = { botId: string; generation: number; seq: number; createdAt: number };
type CallBody = Extract<RowBody, { type: 'event' }>;

/** Read-time compatibility: never rewrite old rows or infer a subject from model prose. */
function legacyCall(body: CallBody, userId: string, location?: CallLocation): CallBody {
  const call = body.call;
  const baseText = body.text.match(/^Voice call ended(?: · \d+(?:m \d+s|s|m))?/)?.[0] ?? 'Voice call ended';
  const sources = [body.text, call?.summary ?? '', ...(call?.transcript ?? []).map(line => line.text)];
  const discussion = discussionSummary(call?.summary ?? body.text.slice(baseText.length).replace(/^\.\s*/, ''), sources) ?? undefined;
  const approvals: VoiceApprovalReference[] = [];
  if (call && location) {
    const { botId, generation, seq, createdAt } = location;
    const start = db.prepare(`SELECT r.created_at FROM rows r JOIN bots b ON b.id=r.bot_id
      WHERE b.user_id=? AND r.bot_id=? AND r.generation=? AND r.seq<? AND r.created_at<=?
      AND json_extract(r.body,'$.event')='voice-call' AND json_extract(r.body,'$.call.id')=?
      AND json_extract(r.body,'$.call.phase')='started' ORDER BY r.seq DESC LIMIT 1`)
      .get(userId, botId, generation, seq, createdAt, call.id) as { created_at: number } | undefined;
    const startedAt = start?.created_at ?? (Number.isFinite(call.durationMs) && call.durationMs! > 0 ? createdAt - call.durationMs! : undefined);
    if (startedAt !== undefined) {
      const candidates = db.prepare(`SELECT a.id,r.seq,r.body,b.name FROM approvals a
        JOIN bots b ON b.id=a.bot_id JOIN rows r ON r.bot_id=a.bot_id AND r.seq=a.row_seq AND r.generation=?
        WHERE b.user_id=? AND b.id=? AND r.seq<? AND a.created_at>=? AND a.created_at<=?
        AND r.created_at>=? AND r.created_at<=? AND json_extract(r.body,'$.card')='approval'
        AND json_extract(r.body,'$.approvalId')=a.id AND COALESCE(json_extract(r.body,'$.audience'),'user')!='internal'`)
        .all(generation, userId, botId, seq, startedAt, createdAt, startedAt, createdAt) as { id: string; seq: number; body: string; name: string }[];
      const matches = candidates.flatMap(row => {
        const card = JSON.parse(row.body) as ApprovalCard;
        const args = card.args as { tool_slug?: string; arguments?: { subject?: unknown } } | null;
        const subject = args?.tool_slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? args.arguments?.subject : undefined;
        // Only an exact quoted saved subject in the pill can establish identity.
        if (typeof subject !== 'string' || !subject || ![body.text, call.summary ?? ''].some(text => text.includes(`Gmail draft with subject ${JSON.stringify(subject)}`))) return [];
        return [{ approvalId: row.id, botId, generation, rowSeq: row.seq, botName: row.name, detail: voiceApprovalDetail(card) }];
      });
      // Duplicate subjects in one call are ambiguous. Do not choose an approval.
      for (const ref of matches) if (matches.filter(other => other.detail === ref.detail).length === 1) approvals.push(ref);
    }
  }
  return { ...body, text: discussion ? `${baseText}. ${discussion}` : baseText,
    call: call ? { ...call, baseText, discussion, approvals, summary: discussion, transcript: discussion ? call.transcript : undefined } : undefined };
}

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

/** Shared by API snapshots, SSE, previews and voice context, including legacy records. */
export function serializeVoiceCall(body: RowBody, userId: string, _forVoice = false, location?: CallLocation): RowBody {
  if (body.type !== 'event' || body.event !== 'voice-call' || body.call?.phase === 'started') return body;
  if (!body.call?.baseText || !body.call.approvals) body = legacyCall(body, userId, location);
  const call = body.call;
  if (!call?.baseText || !call.approvals) return body;
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
  const linked = db.prepare(`SELECT r.bot_id,r.seq,r.body FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    WHERE b.user_id=? AND r.kind='event' AND json_extract(r.body,'$.event')='voice-call'
    AND EXISTS (SELECT 1 FROM json_each(r.body,'$.call.approvals') ref
      WHERE json_extract(ref.value,'$.approvalId')=? AND json_extract(ref.value,'$.botId')=?
      AND json_extract(ref.value,'$.generation')=? AND json_extract(ref.value,'$.rowSeq')=?)`)
    .all(userId, approvalId, botId, generation, rowSeq) as { bot_id: string; seq: number; body: string }[];
  const legacy = db.prepare(`SELECT r.* FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    WHERE b.user_id=? AND r.bot_id=? AND r.generation=? AND r.seq>?
    AND json_extract(r.body,'$.event')='voice-call' AND json_extract(r.body,'$.call.phase')='ended'
    AND (json_extract(r.body,'$.call.approvals') IS NULL OR json_extract(r.body,'$.call.baseText') IS NULL)`)
    .all(userId, botId, generation, rowSeq) as { bot_id: string; seq: number; body: string; created_at: number }[];
  return [...linked, ...legacy.filter(row => legacyCall(JSON.parse(row.body), userId,
    { botId, generation, seq: row.seq, createdAt: row.created_at }).call?.approvals?.some(ref => ref.approvalId === approvalId))];
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
