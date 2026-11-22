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
};

// The random part must contain an upper case letter or a digit, so ordinary snake_case words such as
// "call_center_notes" or "bot_configuration" are left alone.
const RANDOM = '(?=[A-Za-z0-9_-]*[A-Z0-9])';
const SWARM_ID = new RegExp(`(?<![A-Za-z0-9_-])(req|apr|cli|call|job|room|connect|bot)_${RANDOM}[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])`, 'g');
const ACCOUNT_ID = new RegExp(`(?<![A-Za-z0-9_-])ca_${RANDOM}[A-Za-z0-9_-]{6,64}(?![A-Za-z0-9_-])`, 'g');

export interface RedactOptions {
  /** Return a display name for a Bot id, or undefined to use the neutral label. */
  botName?: (id: string) => string | undefined | null;
}

/** Replace connected account, request, approval, tool call and Bot ids with neutral labels. */
export function redactInternalIds(text: string, options: RedactOptions = {}): string {
  if (!text || !text.includes('_')) return text;
  return text
    .replace(ACCOUNT_ID, LABELS.ca)
    .replace(SWARM_ID, (id, prefix: string) => {
      if (prefix === 'bot') {
        const name = options.botName?.(id);
        if (name) return name;
      }
      return LABELS[prefix] ?? 'item';
    });
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
