import type { Row, ToolCallBody } from '@shared/types';
import { linkedWork } from './userRoutes';

export function savedFileResult(body: Row['body']): ToolCallBody['savedFile'] {
  if (body.type !== 'tool-call' || body.name !== 'save_file' || body.status !== 'done' || !body.savedFile) return;
  const route = linkedWork(body.savedFile.href);
  if (route?.tab === 'Reports' && route.botSlug) return body.savedFile;
}

/** Only suppress repeated links when the corresponding result is loaded in this turn. */
export function savedFileLinksByMessage(rows: Row[]): Map<number, string[]> {
  const links = new Map<string, Set<string>>();
  const messages = new Map<number, string>();
  let turn = 0;
  for (const row of rows) {
    const body = row.body;
    if (body.type === 'message' && body.role === 'user') turn = row.seq;
    const key = `${row.botId}:${row.generation}:${body.jobId ?? `turn-${turn}`}`;
    const saved = savedFileResult(body);
    if (saved) {
      if (!links.has(key)) links.set(key, new Set());
      links.get(key)!.add(saved.href);
    }
    if (body.type === 'message' && body.role === 'assistant') messages.set(row.seq, key);
  }
  return new Map([...messages].flatMap(([seq, key]) => links.has(key) ? [[seq, [...links.get(key)!]]] : []));
}

/** Match only navigation in this document, including older absolute app links. */
export function inAppHash(href: string | undefined): string | undefined {
  if (href?.startsWith('#')) return href;
  if (href && typeof window !== 'undefined') {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname
        && url.search === window.location.search && url.hash) return url.hash;
    } catch { /* Invalid links retain the external-link behavior. */ }
  }
}
