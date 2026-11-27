import type { Bot } from '@shared/types';
import type { Handoff, HandoffLink, HandoffSettings, HandoffStatus, RunOutput, OutputPart, LoopSpec } from '@shared/handoffs/contracts';
import { ApiError } from '../lib/api';
import { requireActiveSession, revalidateSession } from '../lib/session';

export type { Handoff, HandoffLink, HandoffSettings, HandoffStatus, RunOutput, OutputPart, LoopSpec };
export type HandoffSource = { outputId: string } | { taskId: string } | { messageRef: { botId: string; generation: number; seq: number } };
export type HandoffAgent = Pick<Bot, 'id' | 'name' | 'label' | 'kind' | 'onboarding' | 'avatarShape' | 'avatarColor' | 'lastActivityAt'> & { hidden?: boolean; helperForBotId?: string; active?: boolean };
export interface SendInput {
  source: HandoffSource; toBotId: string; instruction: string; returnResult: boolean;
  idempotencyKey: string; createTask?: boolean; includeSensitive?: boolean; roomId?: string;
}
export interface HandoffEvent { seq: number; type: string; createdAt: number; data: Record<string, unknown> }
export interface HandoffDetailData { handoff: Handoff; events: HandoffEvent[] }
export interface HandoffPage { handoffs: Handoff[]; next: string | null }
export interface PartPage { text?: string; next: number | null; part?: OutputPart }
export type LinkInput = Pick<HandoffLink, 'toBotId' | 'mode' | 'trigger' | 'template' | 'autoApproveLoops'> & { id?: string };

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  requireActiveSession();
  const response = await fetch(`/api${path}`, { method, credentials: 'include', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  requireActiveSession();
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (response.status === 401) void revalidateSession();
    throw new ApiError(response.status, error.error || 'Could not complete this request. Try again.', error.code);
  }
  return response.json() as Promise<T>;
}
const id = encodeURIComponent;
const query = (values: Record<string, string | number | undefined>) => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) result.set(key, String(value));
  return result.toString();
};

/** All calls use the signed-in user's session. Bodies and file bytes are fetched only on Open. */
export const handoffApi = {
  agents: (signal?: AbortSignal) => request<{ bots: HandoffAgent[] }>('/bots', 'GET', undefined, signal),
  output: (outputId: string, signal?: AbortSignal) => request<{ output: RunOutput }>(`/outputs/${id(outputId)}`, 'GET', undefined, signal),
  outputByJob: (jobId: string, signal?: AbortSignal) => request<{ output: RunOutput | null }>(`/outputs/by-job/${id(jobId)}`, 'GET', undefined, signal),
  part: (outputId: string, partId: string, offset = 0, signal?: AbortSignal) => request<PartPage>(`/outputs/${id(outputId)}/parts/${id(partId)}?${query({ offset, limit: 8000 })}`, 'GET', undefined, signal),
  send: (input: SendInput) => request<{ handoff: Handoff }>('/handoffs', 'POST', input),
  detail: (handoffId: string, signal?: AbortSignal) => request<HandoffDetailData>(`/handoffs/${id(handoffId)}`, 'GET', undefined, signal),
  list: (input: { botId?: string; direction?: 'sent' | 'received'; after?: string; limit?: number }, signal?: AbortSignal) => request<HandoffPage>(`/handoffs?${query({ ...input, limit: input.limit ?? 20 })}`, 'GET', undefined, signal),
  act: (handoffId: string, action: 'approve' | 'decline' | 'cancel') => request<{ handoff: Handoff }>(`/handoffs/${id(handoffId)}/${action}`, 'POST', {}),
  links: (botId: string, signal?: AbortSignal) => request<{ links: HandoffLink[] }>(`/handoff-links?${query({ botId })}`, 'GET', undefined, signal),
  saveLinks: (botId: string, links: LinkInput[]) => request<{ links: HandoffLink[] }>(`/handoff-links?${query({ botId })}`, 'PUT', { links }),
  settings: (signal?: AbortSignal) => request<{ settings: HandoffSettings }>('/handoff-settings', 'GET', undefined, signal),
  saveSettings: (settings: HandoffSettings) => request<{ settings: HandoffSettings }>('/handoff-settings', 'PUT', settings),
  startLoop: (spec: LoopSpec, idempotencyKey: string) => request<{ loop: { id: string } }>('/loops', 'POST', { spec, idempotencyKey, start: true }),
};

export function eligibleAgents(agents: HandoffAgent[], senderId: string, roomMemberIds?: string[]) {
  return agents.filter(bot => bot.id !== senderId && bot.kind !== 'room' && bot.active !== false
    && (!bot.onboarding || bot.onboarding.status === 'active')
    && (!bot.hidden || bot.helperForBotId === senderId)
    && (!roomMemberIds || roomMemberIds.includes(bot.id)));
}
export function linkInput(link: HandoffLink): LinkInput {
  const { id, toBotId, mode, trigger, template, autoApproveLoops } = link;
  return { id, toBotId, mode, trigger, template, autoApproveLoops };
}
