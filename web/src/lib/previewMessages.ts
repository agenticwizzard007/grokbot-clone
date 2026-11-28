import type { Row } from '@shared/types';
import type { StoredPreview } from '@shared/ui-config';

/** Only the assistant turn attached to a decided card loses its stale trailing
 * instruction. User text, unrelated turns and still-pending previews stay intact. */
export function previewMessageRows(rows: Row[], decisions: Record<string, StoredPreview['status']>): Row[] {
  const turns = new Map<string, boolean>();
  for (const row of rows) {
    const body = row.body;
    if (body.type !== 'card' || body.card !== 'ui_preview' || !body.jobId) continue;
    const resolved = ['applied', 'discarded'].includes(decisions[body.previewId] ?? body.status);
    turns.set(body.jobId, (turns.get(body.jobId) ?? true) && resolved);
  }
  return rows.map(row => {
    const body = row.body;
    if (body.type !== 'message' || body.role !== 'assistant' || !body.jobId || !turns.get(body.jobId)) return row;
    const text = body.text.replace(/(?:^|(?<=[.!?])\s+|\n+)(?:Press|Click|Tap)\s+(?:the\s+)?(?:\*\*)?Apply(?:\*\*)?\b[^.!?\n]*[.!?]?\s*$/i, '').trimEnd();
    return text === body.text ? row : { ...row, body: { ...body, text } };
  });
}
