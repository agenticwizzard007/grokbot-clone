/**
 * iMessage and SMS show text as typed: no bold or italics. Strip Markdown to plain text a person would write.
 * Lists stay as lines; links become "text (url)"; tables become one line per row.
 */
export function toPlainText(md: string): string {
  const blocks: string[] = [];
  let s = md.replace(/```[^\n`]*\n([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => (alt ? `${alt}: ${url}` : url))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text, url) => (text === url ? url : `${text} (${url})`))
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, '$1')
    .replace(/__(?!\s)([^\n]+?)(?<!\s)__/g, '$1')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g, '$1$2')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  s = tablesToLists(s).replace(/^\*(.+)\*$/gm, '$1');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[+i]);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown tables don't render in text messages; turn each row into "- a · b · c". */
function tablesToLists(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (!isRow) { out.push(line); continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const next = lines[i + 1] ?? '';
    const isHeader = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(next);
    out.push(isHeader ? `*${cells.join(' · ')}*` : `- ${cells.join(' · ')}`);
  }
  return out.join('\n');
}

/** Split into messages of at most `max` characters, preferring paragraph, then line, then word breaks. */
export function chunk(text: string, max = 3800): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
