import { plainBodyText } from './PreviewBody';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type ObjectValue = Record<string, unknown>;
export interface PreviewField { label: string; value: string }
export interface ToolPreview {
  kind: 'email' | 'slack' | 'calendar' | 'generic';
  fields: PreviewField[];
  body?: string;
  notes: string[];
}
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const first = (args: ObjectValue, keys: string[]) => keys.map(key => args[key]).find(value => value !== undefined && value !== null);
const string = (value: unknown) => typeof value === 'string' ? value : '';
export const humanizeKey = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

/** Never mount provider HTML. Parsing to text preserves paragraphs/entities without
 * loading remote images, following links, or trusting attributes and executable tags. */
export function htmlToText(html: string): string {
  const walk = (node: DefaultTreeAdapterMap['node']): string => {
    if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
    const element = node as DefaultTreeAdapterMap['element'];
    const tag = element.tagName;
    if (['script', 'style', 'template', 'iframe', 'object', 'svg', 'math', 'head'].includes(tag)) return '';
    if (tag === 'br') return '\n';
    if (tag === 'img') return element.attrs.find(a => a.name === 'alt')?.value ?? '';
    const content = ('childNodes' in node ? node.childNodes : []).map(walk).join('');
    if (tag === 'a') {
      const href = element.attrs.find(a => a.name === 'href')?.value;
      return href && /^(https?:\/\/|mailto:)/i.test(href) && content !== href ? `${content} (${href})` : content;
    }
    if (['p', 'div', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'tr', 'ul', 'ol'].includes(tag)) return `\n${content}\n`;
    if (tag === 'li') return `\n• ${content}\n`;
    if (tag === 'td' || tag === 'th') return `${content}\t`;
    return content;
  };
  return walk(parseFragment(html)).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function bodyText(value: unknown, html = false): string {
  const text = string(value);
  // Some tools double-escape line endings. They are presentation escapes, not paragraphs.
  return html ? htmlToText(text) : plainBodyText(text);
}

function recipients(value: unknown): string {
  if (Array.isArray(value)) return value.map(recipients).filter(Boolean).join(', ');
  if (typeof value === 'string') return value;
  const entry = object(value);
  if (entry.emailAddress) return recipients(entry.emailAddress);
  if (entry.email_address && typeof entry.email_address === 'object') return recipients(entry.email_address);
  const address = string(first(entry, ['address', 'email', 'email_address']));
  const name = string(first(entry, ['name', 'displayName', 'display_name']));
  return name && address ? `${name} <${address}>` : address || name;
}

function dateText(value: unknown, timezone: unknown): string {
  const entry = object(value);
  const date = string(first(entry, ['dateTime', 'date_time', 'date'])) || string(value);
  const zone = string(first(entry, ['timeZone', 'time_zone', 'timezone'])) || string(timezone);
  // Preserve the supplied local time and offset; never silently convert to the viewer's zone.
  return [date.replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 '), zone].filter(Boolean).join(' · ');
}

const internal = /(^|_)(id|ids|timezone|revision|token|secret|password)($|_)|^(is_html|include_signature|html|connectionId|connectedAccountId|threadId|messageId|calendarId)$/i;
function genericFields(args: ObjectValue): PreviewField[] {
  return Object.entries(args).flatMap(([key, value]) => {
    if (internal.test(key) || /(?:Id|Ids|Token|Secret|Password)$/.test(key)) return [];
    // Structured payloads and JSON encoded strings belong in Details.
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      try { JSON.parse(value); return []; } catch { /* ordinary prose */ }
    }
    return [{ label: humanizeKey(key), value: bodyText(String(value)) }];
  });
}

/** Project only supplied values. The original args remain untouched for execution and Details. */
export function toolPreviews(tool: string, raw: unknown): ToolPreview[] {
  const envelope = object(raw);
  if (Array.isArray(envelope.tools)) return envelope.tools.flatMap(item => {
    const entry = object(item);
    return toolPreviews(string(first(entry, ['tool_slug', 'tool', 'name'])) || tool, entry.arguments ?? entry.args ?? entry);
  });
  const name = string(envelope.tool_slug) || tool;
  const args = object(envelope.arguments ?? envelope.args ?? raw);
  const kind = /calendar|create_event|update_event/i.test(name) ? 'calendar'
    : /gmail|outlook|email|mail_(send|draft|reply)/i.test(name) ? 'email' : /slack/i.test(name) ? 'slack' : 'generic';
  const fields: PreviewField[] = [];
  const notes: string[] = [];
  const field = (label: string, value: string) => { if (value) fields.push({ label, value }); };
  let body: string | undefined;
  if (kind === 'email') {
    const message = { ...args, ...object(args.message) };
    field('To', recipients(first(message, ['to', 'recipient_email', 'recipient_emails', 'to_email', 'to_emails', 'toRecipients', 'to_recipients', 'recipients', 'recipient'])));
    field('Cc', recipients(first(message, ['cc', 'ccRecipients', 'cc_recipients', 'cc_emails'])));
    field('Bcc', recipients(first(message, ['bcc', 'bccRecipients', 'bcc_recipients', 'bcc_emails'])));
    field('Subject', string(message.subject));
    const content = first(message, ['body', 'body_content', 'html_body', 'text', 'content', 'comment']);
    const structured = object(content);
    const html = message.is_html === true || message.html_body !== undefined || /^html$/i.test(string(first(structured, ['contentType', 'content_type'])) || string(first(message, ['contentType', 'body_type', 'content_type'])));
    body = bodyText(typeof content === 'object' ? structured.content : content, html);
    if (message.include_signature === true) notes.push('Signature will be added');
    if (first(message, ['thread_id', 'threadId', 'message_id', 'messageId'])) {
      const subject = string(first(message, ['thread_subject', 'threadSubject', 'original_subject']));
      notes.push(subject ? `Reply to: ${subject}` : 'Reply in existing thread');
    }
  } else if (kind === 'slack') {
    field('Channel', string(first(args, ['channel', 'channel_id', 'channel_name'])));
    body = bodyText(first(args, ['text', 'message', 'content']));
    // Block-only Slack messages still need a readable preview, in provider order.
    if (!body && Array.isArray(args.blocks)) body = args.blocks.flatMap(block => {
      const b = object(block);
      return [object(b.text).text, ...(Array.isArray(b.fields) ? b.fields.map(f => object(f).text) : [])].filter(v => typeof v === 'string');
    }).join('\n\n');
  } else if (kind === 'calendar') {
    field('Title', string(first(args, ['summary', 'title', 'subject'])));
    const timezone = first(args, ['timezone', 'time_zone', 'timeZone']);
    field('Start', dateText(first(args, ['start', 'start_datetime', 'start_date_time', 'start_time']), timezone));
    field('End', dateText(first(args, ['end', 'end_datetime', 'end_date_time', 'end_time']), timezone));
    field('Duration', string(args.duration) || (typeof args.event_duration_hour === 'number' || typeof args.event_duration_minutes === 'number' ? [args.event_duration_hour === undefined ? '' : `${args.event_duration_hour} hours`, args.event_duration_minutes === undefined ? '' : `${args.event_duration_minutes} minutes`].filter(Boolean).join(' ') : ''));
    field('Attendees', recipients(args.attendees));
    field('Location', string(args.location) || string(object(args.location).displayName));
    const description = args.description ?? args.body;
    body = bodyText(typeof description === 'object' ? object(description).content : description, /^html$/i.test(string(object(description).contentType)));
  } else fields.push(...genericFields(args));
  return [{ kind, fields, body, notes }];
}
