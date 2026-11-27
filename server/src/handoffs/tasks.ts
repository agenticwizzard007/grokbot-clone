import type { Task } from '../types.js';

/** Task projections use the existing three task states. */
export function loopTaskState(status: string, stopReason: string | null): Task['state'] {
  if (status === 'succeeded' && stopReason === 'passed') return 'done';
  if (status === 'running' || status === 'draft' || status === 'paused') return 'working';
  return 'needs_input';
}
