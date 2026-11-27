import type { Loop, LoopSpec, LoopStatus, Verdict } from '@shared/handoffs/contracts';
import { ApiError } from '../../lib/api';
import { requireActiveSession, revalidateSession } from '../../lib/session';
import { useStore } from '../../store';

export type { Loop, LoopSpec, LoopStatus };
export type LoopAction = 'start' | 'pause' | 'resume' | 'stop' | 'approve' | 'decline' | 'extend';
export interface LoopBot { id: string; name: string; kind?: string; hidden?: boolean; isConfiguring?: boolean }
export interface OutputLink { id: string; title: string; partId?: string }
export interface LoopStepRun {
  id: string; iteration: number; stepId: string; botId: string; botName?: string;
  role: 'maker' | 'checker' | 'step';
  status: 'dispatching' | 'dispatched' | 'running' | 'completed' | 'failed' | 'skipped';
  outputId: string | null; outputTitle?: string; startedAt: number | null; finishedAt: number | null;
  waitingForApproval?: boolean; inputs?: OutputLink[];
}
export interface LoopVerdict extends Verdict { iteration: number; claimedPass?: boolean; corrected?: boolean }
export interface LoopEvent { seq: number; type: string; createdAt: number; data: Record<string, unknown> }
export interface LoopDetail {
  loop: Loop; steps: LoopStepRun[]; verdicts: LoopVerdict[];
  bestOutput: OutputLink | null;
  usage?: { tracked: boolean; costUsd?: number; tokens?: number };
  gate?: { kind: 'first' | 'iteration' | 'cap' | 'manual'; iteration: number; expiresAt?: number };
  canExtend?: boolean;
}
export interface LoopApi {
  list(signal?: AbortSignal, after?: string): Promise<{ loops: Loop[]; next?: string | null }>;
  bots(signal?: AbortSignal): Promise<LoopBot[]>;
  get(id: string, signal?: AbortSignal): Promise<LoopDetail>;
  events(id: string, after: number, signal?: AbortSignal): Promise<{ events: LoopEvent[]; next?: number | null }>;
  create(spec: LoopSpec, idempotencyKey: string): Promise<{ loop: Loop }>;
  control(id: string, action: LoopAction): Promise<{ loop: Loop }>;
  subscribe(listener: (id?: string) => void): () => void;
}

async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  requireActiveSession();
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  requireActiveSession();
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401) void revalidateSession();
    throw new ApiError(response.status, error.error || 'Could not load loops. Try again.', error.code);
  }
  return response.json();
}

/** HO-I forwards loop SSE messages as swarm:event; the app owns the connection. */
export function subscribeLoopEvents(listener: (id?: string) => void) {
  const event = (message: Event) => {
    const detail = (message as CustomEvent).detail;
    if (detail?.type === 'loop') listener(detail.id);
  };
  const refresh = () => { if (document.visibilityState !== 'hidden') listener(); };
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.sseConnected && !previous.sseConnected) listener();
  });
  window.addEventListener('swarm:event', event);
  window.addEventListener('swarm:resume', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    unsubscribe(); window.removeEventListener('swarm:event', event);
    window.removeEventListener('swarm:resume', refresh); window.removeEventListener('online', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}

export const loopsApi: LoopApi = {
  list: (signal, after) => request(`/loops?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal),
  bots: async signal => (await request<{ bots: LoopBot[] }>('/bots', signal)).bots.filter(eligibleBot),
  get: (id, signal) => request(`/loops/${encodeURIComponent(id)}`, signal),
  events: (id, after, signal) => request(`/loops/${encodeURIComponent(id)}/events?after=${after}&limit=200`, signal),
  create: (spec, idempotencyKey) => request('/loops', undefined, { spec, idempotencyKey, start: true }),
  control: (id, action) => request(`/loops/${encodeURIComponent(id)}/${action}`, undefined, {}),
  subscribe: subscribeLoopEvents,
};

export const eligibleBot = (bot: LoopBot) => bot.kind !== 'room' && !bot.hidden && !bot.isConfiguring;
export const outputHref = (output: OutputLink) => `#output/${encodeURIComponent(output.id)}${output.partId ? `?part=${encodeURIComponent(output.partId)}` : ''}`;
export const statusLabel: Record<LoopStatus, string> = {
  draft: 'Draft', awaiting_approval: 'Needs approval', running: 'Running', paused: 'Paused',
  succeeded: 'Done', capped: 'Limit reached', stalled: 'No progress', failed: 'Failed', cancelled: 'Stopped',
};
export const isTerminal = (status: LoopStatus) => ['succeeded', 'capped', 'stalled', 'failed', 'cancelled'].includes(status);
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';
