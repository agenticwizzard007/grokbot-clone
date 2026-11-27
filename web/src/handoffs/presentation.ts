/** Omit an automatic summary's repeated heading, retaining the actual preview. */
export function outputPreview(title: string, summary: string): string {
  const text = summary.trim(), heading = title.trim();
  if (!heading || !text.toLowerCase().startsWith(heading.toLowerCase())) return text;
  const rest = text.slice(heading.length);
  // A shared prefix is not necessarily a repeated title (Draft / Drafting).
  return !rest || /^[\s:.,]/.test(rest) ? rest.replace(/^[\s:.,]+/, '') : text;
}

/** Provider role headers are transport metadata, never display copy. */
export function withoutProviderPrefix(text: string): string {
  return text.replace(/^(?:mock:\s*(?:say\s+)?|(?:system|assistant|provider):\s*)+/gim, '');
}

/** A receipt can finish a handoff turn without a public assistant reply. */
export function handoffTurnFinished(rows: readonly { seq: number; kind: string; body: unknown }[], promptSeq: number, running: boolean): boolean {
  if (running) return false;
  const receipt = rows.findLast(row => row.kind === 'handoff' && row.seq > promptSeq);
  const status = (receipt?.body as { status?: string } | undefined)?.status;
  return !!status && ['completed', 'failed', 'declined', 'cancelled', 'expired'].includes(status);
}
