import type { HandoffStatus, LoopStatus } from './contracts.js';

export const HANDOFF_EVENT_TYPES = [
  'output.created', 'output.finalized', 'handoff.created', 'handoff.approved', 'handoff.declined',
  'handoff.delivered', 'handoff.read', 'handoff.completed', 'handoff.failed', 'handoff.cancelled', 'handoff.expired',
  'loop.created', 'loop.approval_requested', 'loop.approved', 'loop.declined', 'loop.started',
  'loop.step_dispatched', 'loop.step_completed', 'loop.step_failed', 'loop.verdict', 'verdict.corrected',
  'loop.warning', 'loop.paused', 'loop.resumed', 'loop.extended', 'loop.finished', 'flow.rebuilt',
] as const;
export type HandoffEventType = typeof HANDOFF_EVENT_TYPES[number];
export interface HandoffEvent {
  seq: number; userId: string; loopId: string | null; handoffId: string | null;
  type: HandoffEventType; data: Record<string, unknown>; createdAt: number;
}
export type HandoffServerEvent =
  | { type: 'handoff'; id: string; status: HandoffStatus }
  | { type: 'loop'; id: string; status: LoopStatus; iteration: number }
  | { type: 'flow'; botId: string; version: number }
  | { type: 'output'; id: string; botId: string };

const transitions: Record<HandoffStatus, readonly HandoffStatus[]> = {
  pending_approval: ['queued', 'declined', 'expired'], queued: ['delivered', 'cancelled', 'expired'],
  delivered: ['running', 'failed', 'cancelled'], running: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], declined: [], cancelled: [], expired: [],
};
/** Reconciliation can replay an observation but cannot skip or reverse a transition. */
export function nextHandoffStatus(current: HandoffStatus, observed: HandoffStatus): HandoffStatus {
  return transitions[current].includes(observed) ? observed : current;
}
export const A2A_STATUS: Record<HandoffStatus, string> = {
  pending_approval: 'input-required', queued: 'submitted', delivered: 'submitted', running: 'working',
  completed: 'completed', failed: 'failed', declined: 'rejected', cancelled: 'canceled', expired: 'failed',
};
