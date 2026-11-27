export type InlineNode = { kind: 'text' | 'bold' | 'italic'; text: string } | { kind: 'link'; text: string; href: string; domain?: string };
export type NoteNode = { kind: 'paragraph' | 'heading'; level?: 2 | 3; content: InlineNode[] } | { kind: 'list'; ordered: boolean; items: InlineNode[][] };
export function noteLink(target: string): { href: string; domain?: string } | null {
  if (/^https:\/\//i.test(target)) {
    try { const url = new URL(target); return url.protocol === 'https:' ? { href: url.href, domain: url.hostname } : null; } catch { return null; }
  }
  if (/^(bots|tasks|settings)$/.test(target)) return { href: `#${target}` };
  if (/^dashboard:d_[a-z0-9]{8}$/.test(target)) return { href: `#dash/${target.slice(10)}` };
  if (/^bot:[a-zA-Z0-9_-]{1,100}$/.test(target)) return { href: `#bot/${target.slice(4)}` };
  return null;
}
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []; let offset = 0;
  const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) nodes.push({ kind: 'text', text: text.slice(offset, match.index) });
    if (match[1]) { const link = noteLink(match[2]); nodes.push(link ? { kind: 'link', text: match[1], ...link } : { kind: 'text', text: match[0] }); }
    else nodes.push({ kind: match[3] ? 'bold' : 'italic', text: match[3] || match[4] });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) nodes.push({ kind: 'text', text: text.slice(offset) });
  return nodes;
}
/** Fixed node set only. HTML and images remain literal text, never markup. */
export function parseNote(text: string): NoteNode[] {
  const result: NoteNode[] = [];
  for (const line of text.slice(0, 2000).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = /^(#{2,3})\s+(.+)$/.exec(line), list = /^\s*(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
    if (heading) result.push({ kind: 'heading', level: heading[1].length as 2 | 3, content: parseInline(heading[2]) });
    else if (list) {
      const ordered = !list[1], last = result[result.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(parseInline(list[2]));
      else result.push({ kind: 'list', ordered, items: [parseInline(list[2])] });
    } else result.push({ kind: 'paragraph', content: parseInline(line) });
  }
  return result;
}
