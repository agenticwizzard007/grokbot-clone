import type { Loop, LoopBot, LoopSpec, LoopStatus } from './loops/api';

export interface ReceiptIdentity { loopId?: string; iteration?: number }
export type ReceiptGroup<T> = { kind: 'item'; item: T } | { kind: 'loop'; loopId: string; members: T[] };

/** Preserve transcript order and boundaries, including messages and date dividers. */
export function groupReceipts<T>(items: readonly T[], receiptFor: (item: T) => ReceiptIdentity | undefined): ReceiptGroup<T>[] {
  const groups: ReceiptGroup<T>[] = [];
  for (const item of items) {
    const loopId = receiptFor(item)?.loopId;
    const previous = groups.at(-1);
    if (!loopId) groups.push({ kind: 'item', item });
    else if (previous?.kind === 'loop' && previous.loopId === loopId) previous.members.push(item);
    else groups.push({ kind: 'loop', loopId, members: [item] });
  }
  return groups;
}

const status: Record<LoopStatus, string> = {
  draft: 'Draft', awaiting_approval: 'Needs approval', running: 'Running', paused: 'Paused',
  succeeded: 'Completed', capped: 'Capped', stalled: 'Stopped', failed: 'Failed', cancelled: 'Stopped',
};

/** Keep task names intact; replace only empty names and generic placeholders. */
export function receiptLoopTitle(spec?: Pick<LoopSpec, 'name' | 'steps'>, bots: readonly Pick<LoopBot, 'id' | 'name'>[] = []) {
  if (!spec) return 'Loop';
  const name = spec.name.trim();
  if (name && !/^(?:(?:agent|new|untitled) )?loop$/i.test(name)) return name;
  const maker = spec.steps.find(step => step.role === 'maker') ?? spec.steps[0];
  const checker = spec.steps.find(step => step.role === 'checker');
  const botName = (id: string | undefined, fallback: string) => bots.find(bot => bot.id === id)?.name.trim() || fallback;
  return `${botName(maker?.botId, 'Maker')} and ${botName(checker?.botId, 'Checker')} loop`;
}

/** Count passes, not handoff directions; the live run is authoritative when loaded. */
export function receiptLoopSummary(receipts: readonly ReceiptIdentity[], loop?: Pick<Loop, 'status' | 'iteration' | 'spec'>) {
  const passes = loop?.iteration ?? Math.max(0, ...receipts.map(receipt => receipt.iteration ?? 0));
  return {
    chip: loop?.status === 'running' ? `Pass ${passes} of ${loop.spec.limits.maxIterations}` : `${passes} ${passes === 1 ? 'pass' : 'passes'}`,
    status: loop ? status[loop.status] : undefined,
  };
}
