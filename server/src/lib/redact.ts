/**
 * Internal identifiers never belong in text a person reads (R2F-002). Swarm ids come from newId():
 * a short prefix, an underscore and 12 base64url characters (for example req_ab12CD34ef56). Connected
 * account ids from the app provider look like ca_ followed by 6 or more characters. Models sometimes
 * copy these into briefs and replies, so text that is saved for, or shown to, the user passes through
 * redactInternalIds first.
 */

/** Neutral labels per id prefix. Bot ids use the Bot's name when a resolver is supplied. */
const LABELS: Record<string, string> = {
  ca: 'connected account',
  req: 'request',
  apr: 'approval',
  cli: 'tool call',
  call: 'tool call',
  job: 'job',
  room: 'group chat',
  connect: 'connection request',
  bot: 'a Bot',
  rt: 'routine',
  task: 'task',
  goal: 'goal',
  wf: 'workflow',
  mem: 'memory',
  skl: 'skill',
  artifact: 'file',
  delivery: 'delivery',
  mcp: 'MCP server',
  send: 'message',
  wake: 'wake request',
  synopsis: 'synopsis',
  claim: 'claim',
  checkin: 'check-in',
};

/** Every prefix newId() issues. Ids with other prefixes keep their neutral fallback label. */
const SWARM_PREFIXES = 'req|apr|cli|call|job|room|connect|bot|rt|task|goal|wf|mem|skl|skr|skpr|skp|ske|ska|artifact|delivery|mcp|mch|mrv|send|wake|vm|synopsis|sub|claim|checkin|coverage|manual|reconcile|usr';

// The random part must contain an upper case letter or a digit, so ordinary snake_case words such as
// "call_center_notes" or "bot_configuration" are left alone.
const RANDOM = '(?=[A-Za-z0-9_-]*[A-Z0-9])';
const SWARM_ID = new RegExp(`(?<![A-Za-z0-9_-])(${SWARM_PREFIXES})_${RANDOM}[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])`, 'g');
/** An id given as an aside, for example "Monday OK (`rt_ab12CD34ef56`)", is dropped with its brackets. */
const ASIDE_ID = new RegExp(`\\s*\\(\\s*\`?(?:ca_${RANDOM}[A-Za-z0-9_-]{6,64}|(?:${SWARM_PREFIXES})_${RANDOM}[A-Za-z0-9_-]{12})\`?\\s*\\)`, 'g');
/** A bare id in inline code keeps its label without the code ticks. */
const CODE_ID = new RegExp(`\`((?:ca_${RANDOM}[A-Za-z0-9_-]{6,64}|(?:${SWARM_PREFIXES})_${RANDOM}[A-Za-z0-9_-]{12}))\``, 'g');
const ACCOUNT_ID = new RegExp(`(?<![A-Za-z0-9_-])ca_${RANDOM}[A-Za-z0-9_-]{6,64}(?![A-Za-z0-9_-])`, 'g');

/** Words that already name what the id stands for, so the id can simply be dropped after them. */
const LEAD_WORDS: Record<string, RegExp> = {
  ca: /\b(account|connection)\s*$/i, req: /\brequest\s*$/i, apr: /\bapproval\s*$/i, cli: /\b(call|request)\s*$/i,
  call: /\bcall\s*$/i, job: /\bjob\s*$/i, room: /\b(group|chat)\s*$/i, rt: /\broutine\s*$/i, task: /\btask\s*$/i,
  goal: /\bgoal\s*$/i, wf: /\bworkflow\s*$/i, skl: /\bskill\s*$/i, artifact: /\bfile\s*$/i,
};
function echoes(whole: string, offset: number, prefix: string): boolean {
  return LEAD_WORDS[prefix]?.test(whole.slice(Math.max(0, offset - 24), offset)) ?? false;
}

export interface RedactOptions {
  /** Return a display name for a Bot id, or undefined to use the neutral label. */
  botName?: (id: string) => string | undefined | null;
}

/** Replace connected account, request, approval, tool call and Bot ids with neutral labels. */
export function redactInternalIds(text: string, options: RedactOptions = {}): string {
  if (!text || !text.includes('_')) return text;
  const out = text
    .replace(ASIDE_ID, '')
    .replace(CODE_ID, '$1')
    .replace(ACCOUNT_ID, (_id, offset: number, whole: string) => echoes(whole, offset, 'ca') ? '' : LABELS.ca)
    .replace(SWARM_ID, (id, prefix: string, offset: number, whole: string) => {
      if (prefix === 'bot') {
        const name = options.botName?.(id);
        if (name) return name;
      }
      // "request req_..." reads as "request", not "request request".
      if (echoes(whole, offset, prefix)) return '';
      return LABELS[prefix] ?? 'item';
    });
  // Tidy only the gaps a removed id left behind; indentation and code are untouched.
  return out === text ? text : out.replace(/(\S) +([.,;:!?])(?=\s|$)/g, '$1$2').replace(/(\S) {2,}(?=\S)/g, '$1 ').replace(/(\S) +$/gm, '$1');
}

/** Apply redactInternalIds to every string inside a JSON-like value (briefs, manifests). */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === 'string') return redactInternalIds(value, options) as T;
  if (Array.isArray(value)) return value.map(v => redactDeep(v, options)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, options)])) as T;
  return value;
}

/** True when text still carries an id a person should not see. */
export const hasInternalId = (text: string) => new RegExp(ACCOUNT_ID.source).test(text) || new RegExp(SWARM_ID.source).test(text);

/**
 * Coordination result messages start with a machine header for the receiving model, for example
 * "[Internal result for request req_...; execution finished]". The display form drops that header
 * (the client shows a "Result" chip from kind === 'result') and redacts ids in the remaining text.
 */
const MACHINE_HEADER = /^\[(?:Internal result for request|Consolidated helper result for assignment|Verified workflow result)[^\]\n]*\]\s*\n?/;
export function displayCoordinationText(text: string, options: RedactOptions = {}): string {
  return redactInternalIds(String(text ?? '').replace(MACHINE_HEADER, ''), options);
}
