import { db } from '../db.js';
import { selectedCli } from '../cli/store.js';
import { currentUserMessageRef } from '../knowledge/sessions.js';
import type { ToolCtx } from './tools.js';
import { asksBeforeEveryAction } from './approval-level.js';

type CreateKind = 'skill' | 'task' | 'memory';

/** Only direct requests, not quoted examples, questions about creation or edits.
 * This classification never grants permission or executes a lookup or write. */
export function explicitCreateKind(text: string): CreateKind | null {
  const start = /(?:^|[.!?]\s+|\n\s*)(?:(?:please|can you|could you|would you|i want you to|i would like you to)\s+)?/i.source;
  const create = new RegExp(`${start}(?:create|make|add|save|set up)\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|the|new)\\s+)*(skill|task|memory)\\b`, 'i').exec(text);
  if (create) return create[1].toLowerCase() as CreateKind;
  // "Can you remember my name?" is retrieval, not a request to save a fact.
  return new RegExp(`${start}remember(?:\\s*:|\\s+(?:that|i|we)\\s+|\\s+(?:my|our)\\s+[^.!?\\n]*\\b(?:is|are|was|were)\\b)`, 'i').test(text) ? 'memory' : null;
}

/** Err toward the ordinary approval path whenever older context is requested. */
export function requestsEarlierContext(text: string): boolean {
  const requested = text.replace(/\b(?:do not|don't|never|without|no need to)\s+(?:search(?:ing)?|find(?:ing)?|look(?:ing)?|us(?:e|ing))\b[^.!?\n]*?(?=\b(?:but|instead|and then)\b|[.!?\n]|$)/gi, '');
  return /\b(?:past|previous|earlier|older|archived|existing|yesterday|discussed)\b|\b(?:last|prior)\s+(?:chat|conversation|session|week|time)\b|\b(?:we|i)\s+(?:said|mentioned|talked|told)\b|\b(?:search|find|look\s*(?:up|through|in|at))\b[^.!?\n]*\b(?:chats?|conversations?|history|skills?|memories)\b|\bfrom before\b/i.test(requested);
}

export function currentMessageCreate(ctx: Pick<ToolCtx, 'userId' | 'botId' | 'jobId' | 'roomId'>) {
  // The API preference and this redirect must never alter CLI or group turns.
  if (selectedCli(ctx.userId) || ctx.roomId) return null;
  const source = currentUserMessageRef(ctx.userId, ctx.botId, ctx.jobId);
  if (!source) return null;
  // Read exactly the bound current message, without a search or truncation that
  // could drop a request for earlier context at the end of a long message.
  const row = db.prepare('SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(source.botId, source.generation, source.seq) as { body: string };
  const text = JSON.parse(row.body).text as string;
  const kind = explicitCreateKind(text);
  return kind ? { kind, source, needsEarlierContext: requestsEarlierContext(text) } : null;
}

const SOURCE_LOOKUPS = new Set(['session_search', 'recall', 'list_skills']);

export function currentCreateGuidance(create: NonNullable<ReturnType<typeof currentMessageCreate>>): string {
  const action = create.kind === 'skill' ? 'propose_skill or manage_skill (action create), with expected_revision 0'
    : create.kind === 'task' ? 'create_task' : 'remember';
  return `Continue the explicit current-message create request with ${action}. The current user message and this source reference are sufficient evidence: ${JSON.stringify(create.source)}. Use it in evidence where required. Do not retry an optional lookup. The create action still requires its own approval. If essential details are missing, ask for those details.`;
}

/** A skipped lookup is a tool result, never an allow decision or a fake search. */
export function redirectCreateLookup(ctx: ToolCtx, name: string): string | null {
  if (!SOURCE_LOOKUPS.has(name) || !asksBeforeEveryAction(ctx.userId)) return null;
  const create = currentMessageCreate(ctx);
  if (!create || create.needsEarlierContext) return null;
  return `Lookup not performed. No past chats, memories or existing skills were read. ${currentCreateGuidance(create)}`;
}
