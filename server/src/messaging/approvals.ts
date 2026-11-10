import { randomCode, type Link, type LoggedMsg } from './store.js';

/**
 * Answering approvals by text. Adapted from open-instinct's packages/core/src/approvals.ts (MIT).
 *
 * Each approval message carries a short token ("yes K7P2"). A reply that names the token always counts.
 * A bare "yes" or "no" counts only when it can't be about anything else: exactly one approval is open, the reply is a
 * short plain verdict, and either the approval was the last thing sent on this channel or the user used an explicit
 * verb ("approve", "deny"). That last rule is what stops "sure" to a weather question from approving an email.
 */

export const TOKEN_LENGTH = 4;
export const newToken = () => randomCode(TOKEN_LENGTH);

const STRICT_YES = ['yes', 'y', 'yep', 'approve', 'approved', 'allow', 'confirm', 'confirmed', 'go ahead', 'do it', '1', '👍', '✅'];
const CASUAL_YES = ['yeah', 'yea', 'ok', 'okay', 'sure', 'go'];
const ALWAYS = ['always', 'always allow', '2'];
const NO = ['no', 'n', 'nope', 'deny', 'denied', 'decline', 'declined', 'reject', 'rejected', "don't", 'dont', "don't allow", 'stop', '3', '👎', '❌'];
const EXPLICIT = new Set(['approve', 'approved', 'allow', 'confirm', 'confirmed', 'deny', 'denied', 'decline', 'declined', 'reject', 'rejected', 'always']);
const FILLER = new Set(['please', 'thanks', 'thank', 'you', 'pls', 'thx', 'it', 'that', 'this']);
const BARE_MAX_WORDS = 3;

export type Verdict = 'allow' | 'always' | 'deny';

const words = (s: string) => s.toLowerCase().replace(/[.!,?]+/g, ' ').split(/\s+/).filter(Boolean);

/** Parse a short verdict. `strict`: casual words like "ok" and "sure" don't count. */
export function parseVerdict(text: string, opts: { strict?: boolean } = {}): Verdict | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  const phrase = (list: string[]) => list.includes(t);
  if (phrase(ALWAYS)) return 'always';
  if (phrase(NO)) return 'deny';
  if (phrase(STRICT_YES) || (!opts.strict && phrase(CASUAL_YES))) return 'allow';
  const w = words(t).filter((x) => !FILLER.has(x));
  if (!w.length || w.length > BARE_MAX_WORDS) return undefined;
  const head = w[0];
  if (head === 'always') return 'always';
  if (NO.includes(head)) return w.every((x) => NO.includes(x) || x === 'allow') ? 'deny' : undefined;
  const yes = opts.strict ? STRICT_YES : [...STRICT_YES, ...CASUAL_YES];
  if (yes.includes(head)) return w.every((x) => yes.includes(x) || x === 'allow' || x === 'ahead') ? 'allow' : undefined;
  return undefined;
}

const hasExplicitVerb = (text: string) => words(text).some((w) => EXPLICIT.has(w));

export interface ApprovalMatch { card: LoggedMsg; verdict: Verdict }

/**
 * Interpret a reply against the open approval cards on this channel. Returns undefined when the text is not an
 * approval reply (it then goes to the Bot as a normal message).
 */
export function matchApprovalReply(text: string, open: LoggedMsg[], link: Pick<Link, 'lastPrompted'>): ApprovalMatch | undefined {
  if (!open.length) return undefined;
  const upper = text.toUpperCase();
  const tokens: string[] = upper.match(new RegExp(`\\b[A-Z0-9]{${TOKEN_LENGTH}}\\b`, "g")) ?? [];
  const named = open.find((c) => c.token && tokens.includes(c.token));
  if (named) {
    const rest = text.replace(new RegExp(`\\b${named.token}\\b`, 'i'), ' ').trim();
    const verdict = parseVerdict(rest || 'yes');
    return verdict ? { card: named, verdict } : undefined;
  }
  if (open.length !== 1) return undefined;
  const only = open[0];
  const verdict = parseVerdict(text, { strict: true });
  if (!verdict) return undefined;
  if (hasExplicitVerb(text) || (only.token && link.lastPrompted === only.token)) return { card: only, verdict };
  return undefined;
}
