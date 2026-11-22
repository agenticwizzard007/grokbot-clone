import { Hono } from 'hono';
import { db } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/** One thing waiting for the user (MF-012). `seq` points at the card row in the bot's current conversation. */
export interface NeedsYouItem {
  id: string;
  type: 'setup_review' | 'approval' | 'question' | 'connect';
  botId: string;
  botName: string;
  title: string;
  createdAt: number;
  seq: number | null;
}

const short = (text: unknown, max = 140) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
};

/** Setups to review, pending approvals, unanswered questions and app connections the user was asked for. */
export function needsYou(userId: string): NeedsYouItem[] {
  const cards = db.prepare(`
    SELECT r.bot_id, r.seq, r.body, r.created_at, b.name AS bot_name
    FROM bots b JOIN rows r ON r.bot_id=b.id AND r.generation=b.generation
    WHERE b.user_id=? AND COALESCE(b.kind,'agent')<>'room' AND r.kind='card'
      AND json_extract(r.body,'$.status')='pending' AND json_extract(r.body,'$.card') IN ('approval','question','connect')
    ORDER BY r.created_at ASC`).all(userId) as { bot_id: string; seq: number; body: string; created_at: number; bot_name: string }[];
  const setups = db.prepare(`
    SELECT s.bot_id, s.onboarding_status, s.updated_at, b.name AS bot_name
    FROM bot_setups s JOIN bots b ON b.id=s.bot_id
    WHERE b.user_id=? AND COALESCE(b.kind,'agent')<>'room' AND s.onboarding_status IN ('review','interviewing')`).all(userId) as { bot_id: string; onboarding_status: string; updated_at: number; bot_name: string }[];
  const pendingApproval = db.prepare("SELECT 1 FROM approvals WHERE id=? AND bot_id=? AND status='pending'");
  const interviewing = new Map(setups.filter((s) => s.onboarding_status === 'interviewing').map((s) => [s.bot_id, s]));
  const interviewQuestion = new Map<string, { seq: number; question: string; createdAt: number }>();
  const items: NeedsYouItem[] = [];
  for (const row of cards) {
    let body: any;
    try { body = JSON.parse(row.body); } catch { continue; }
    const base = { botId: row.bot_id, botName: row.bot_name, createdAt: row.created_at, seq: row.seq };
    if (body.card === 'approval') {
      if (!pendingApproval.get(body.approvalId, row.bot_id)) continue;
      items.push({ ...base, id: `approval:${body.approvalId}`, type: 'approval', title: short(body.title || `Allow ${body.tool ?? 'an action'}?`) });
    } else if (body.card === 'question') {
      // A setup interview question is the setup review item for that bot, not a separate question.
      if (interviewing.has(row.bot_id)) { interviewQuestion.set(row.bot_id, { seq: row.seq, question: body.question, createdAt: row.created_at }); continue; }
      items.push({ ...base, id: `question:${row.bot_id}:${row.seq}`, type: 'question', title: short(body.question || 'Answer a question') });
    } else if (body.card === 'connect') {
      items.push({ ...base, id: `connect:${row.bot_id}:${row.seq}`, type: 'connect', title: short(`Connect ${body.toolkitName || body.toolkit || 'an app'}`) });
    }
  }
  for (const s of setups) {
    if (s.onboarding_status === 'review') {
      items.push({ id: `setup:${s.bot_id}`, type: 'setup_review', botId: s.bot_id, botName: s.bot_name, title: short(`Review and activate ${s.bot_name}`), createdAt: s.updated_at, seq: null });
      continue;
    }
    const q = interviewQuestion.get(s.bot_id);
    if (q) items.push({ id: `setup:${s.bot_id}`, type: 'setup_review', botId: s.bot_id, botName: s.bot_name, title: short(`Set up ${s.bot_name}: ${q.question}`), createdAt: q.createdAt, seq: q.seq });
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export const attentionApi = new Hono<AuthVars>();
attentionApi.get('/needs-you', requireUser, (c) => c.json({ items: needsYou(c.get('user').id) }));
