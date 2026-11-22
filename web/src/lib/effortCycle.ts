import type { Effort } from '@shared/types';

/** Weakest to strongest; the keyboard cycle walks this order and wraps (MF-030). */
export const EFFORT_ASCENDING: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
/** New Bots are saved with this effort (server/src/bots.ts), so it is the effective default. */
export const BOT_DEFAULT_EFFORT: Effort = 'medium';

/** The offered levels in cycle order, without "No thinking". */
export function effortCycleOrder(levels: Effort[]): Effort[] {
  return levels.filter(e => e !== 'none').sort((a, b) => EFFORT_ASCENDING.indexOf(a) - EFFORT_ASCENDING.indexOf(b));
}

/** The level after `current` (ascending, wrapping). An unknown current starts at the weakest. */
export function nextEffort(levels: Effort[], current: Effort | null | undefined): Effort | null {
  const order = effortCycleOrder(levels);
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  return order[(at + 1) % order.length];
}
