/**
 * R2F-002 safety net: internal identifiers (connected accounts, requests, approvals, CLI calls, Bot ids)
 * must never reach visible chat text. The server redacts at the source; this keeps older stored text clean.
 */
const LABELS: Record<string, { lead: RegExp; alone: string }> = {
  ca: { lead: /\b(account|connection)$/i, alone: 'the connected account' },
  req: { lead: /\brequest$/i, alone: 'a request' },
  apr: { lead: /\bapproval$/i, alone: 'an approval' },
  cli: { lead: /\b(call|request)$/i, alone: 'a request' },
  bot: { lead: /\bbot$/i, alone: 'a Bot' },
};
// An optional "(" or "id:" before the id is consumed with it; the leading space is handled separately.
const PATTERN = /( ?)(\(\s*`?)?(?:\bid[:=]?\s*)?`?(?<![A-Za-z0-9_-])(ca|req|apr|cli|bot)_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{6,}`?(`?\s*\))?/g;

/** Header the coordination layer prepends to a result handed back to the requesting Bot. */
const RESULT_HEADER = /^\s*\[Internal result for request[^\]\n]*\]\s*\n?/i;

export interface StripOptions { botName?: (id: string) => string | undefined }

/** Replace internal ids with neutral words, keeping the sentence readable. */
export function stripInternalIds(text: string, options: StripOptions = {}): string {
  if (!text) return text;
  return stripOtherIds(text).replace(PATTERN, (match: string, space: string, open: string | undefined, prefix: string, close: string | undefined, offset: number, whole: string) => {
    const kind = prefix.toLowerCase();
    const before = whole.slice(0, offset).trimEnd();
    if (kind === 'bot') {
      const id = /bot_[A-Za-z0-9_-]+/.exec(match)?.[0];
      const name = id ? options.botName?.(id) : undefined;
      if (name) return `${space}${name}`;
    }
    const label = LABELS[kind];
    // "Slack account ca_x" reads as "Slack account"; a bare id becomes a neutral noun.
    // A parenthesised id is an aside: drop it with its brackets.
    if ((open && close) || label.lead.test(before)) return '';
    return `${space}${label.alone}`;
  });
}

/** Other ids the server issues (routines, tasks, goals, workflows and more): a prefix and 12 random characters. */
const OTHER_LABELS: Record<string, string> = { rt: 'routine', task: 'task', goal: 'goal', wf: 'workflow', mem: 'memory', skl: 'skill', artifact: 'file', delivery: 'delivery', mcp: 'MCP server', job: 'job', room: 'group chat', call: 'tool call', connect: 'connection request', send: 'message' };
const OTHER_PREFIXES = 'rt|task|goal|wf|mem|skl|skr|skpr|skp|ske|ska|artifact|delivery|mcp|mch|mrv|job|room|call|connect|send|wake|vm|synopsis|sub|claim|checkin|coverage|manual|reconcile|usr';
const OTHER_ID = `(?:${OTHER_PREFIXES})_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])`;
const OTHER_ASIDE = new RegExp(`\\s*\\(\\s*\`?\\b${OTHER_ID}\`?\\s*\\)`, 'g');
const OTHER_BARE = new RegExp(`\`?\\b(${OTHER_PREFIXES})_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])\`?`, 'g');

/** Ids that the first pass does not cover. An id in brackets is an aside and is dropped with them. */
function stripOtherIds(text: string): string {
  return text.replace(OTHER_ASIDE, '').replace(OTHER_BARE, (_m, prefix: string) => OTHER_LABELS[prefix.toLowerCase()] ?? 'item');
}

/** Agent exchange text: drop the machine header (shown as a chip instead) and any ids. */
export function displayExchangeText(text: string, options: StripOptions = {}): { text: string; result: boolean } {
  const result = RESULT_HEADER.test(text);
  return { text: stripInternalIds(text.replace(RESULT_HEADER, ''), options).trim(), result };
}

/** Visible text must never match this (R2F-002 acceptance). */
export const INTERNAL_ID_PATTERN = new RegExp(`\\b(ca|req|apr|cli|bot|${OTHER_PREFIXES})_(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{6,}`);
