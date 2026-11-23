import { useEffect, useRef, useState } from 'react';
import type { Row } from '@shared/types';
import { useDisplayText } from '../lib/useDisplayText';

/** Mounted per conversation generation, with only user-visible rows. */
export function CompletedReplyAnnouncer({ rows, loaded, botName }: { rows: Row[]; loaded: boolean; botName: string }) {
  const highWater = useRef<number | null>(null);
  const pending = useRef(new Set<number>());
  const [completed, setCompleted] = useState<{ seq: number; text: string }[]>([]);
  const clean = useDisplayText();

  useEffect(() => {
    if (!loaded) return;
    const previous = highWater.current;
    highWater.current = rows.reduce((max, row) => Math.max(max, row.seq), previous ?? 0);
    const replies: typeof completed = [];
    for (const row of rows) {
      const body = row.body;
      if (body.type !== 'message' || body.role !== 'assistant') continue;
      // Initial history stays silent, but an in-flight reply can still finish.
      // Older pages have lower sequences and must never enter the pending set.
      if (previous === null ? body.streaming : row.seq > previous) pending.current.add(row.seq);
      if (!pending.current.has(row.seq) || body.streaming) continue;
      pending.current.delete(row.seq);
      if (body.text.trim() && !body.interrupted) replies.push({
        seq: row.seq, text: `New reply from ${clean(body.from?.name || botName)}: ${clean(body.text)}`,
      });
    }
    if (replies.length) setCompleted(replies);
  }, [rows, loaded, botName, clean]);

  return (
    <div role="status" aria-label="Completed replies" aria-live="polite" aria-atomic="true"
      style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 }}>
      {completed.map(reply => <span key={reply.seq}>{reply.text} </span>)}
    </div>
  );
}
