import { displayExchangeText, type StripOptions } from './stripInternalIds';

/** Longest summary line shown for one agent exchange message. */
export const SUMMARY_LIMIT = 160;

/** Markdown and list syntax that reads as noise in a one line summary. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/**
 * A short coordination summary for one message between Bots: the first sentence or two of its first
 * paragraph, without ids, markdown or detail lists. The full text stays available on request.
 */
export function summarizeExchangeText(text: string, options: StripOptions = {}): { summary: string; result: boolean; truncated: boolean } {
  const shown = displayExchangeText(text, options);
  const full = shown.text.trim();
  const firstParagraph = full.split(/\n\s*\n/).find(part => part.trim()) ?? '';
  // Lines of a list become one sentence: "Item one; Item two."
  const lines = plain(firstParagraph).split('\n').map(line => line.trim()).filter(Boolean);
  const flat = lines.reduce((acc, line) => !acc ? line : `${acc}${/[.!?:;]$/.test(acc) ? ' ' : '; '}${line}`, '').replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [];
  let summary = '';
  for (const sentence of sentences) {
    const next = summary ? `${summary} ${sentence}` : sentence;
    if (summary && (next.length > SUMMARY_LIMIT || summary.length >= 80)) break;
    summary = next;
  }
  if (!summary) summary = flat;
  if (summary.length > SUMMARY_LIMIT) summary = `${summary.slice(0, SUMMARY_LIMIT - 1).replace(/\s+\S*$/, '')}…`;
  const truncated = summary.replace(/…$/, '').length < plain(full).replace(/\s+/g, ' ').trim().length;
  return { summary, result: shown.result, truncated };
}
