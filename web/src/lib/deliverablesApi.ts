import { ApiError } from './api';
import type { DeliveryAction, DeliveryDestination } from './deliveryActions';
import type { Artifact, ArtifactDelivery, DeliveryChannel, RoutineRun } from '@shared/deliverables/types';
export type { Artifact, ArtifactDelivery, DeliveryChannel, RoutineRun };
export type SavedDeliverable = Artifact & { deliveries: ArtifactDelivery[] };

async function request<T>(path: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/deliverables${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new ApiError(response.status, detail?.error ?? 'Could not load saved reports.');
  }
  return response.json();
}
export const deliverablesApi = {
  list: (botId: string, signal?: AbortSignal) => request<{ artifacts: SavedDeliverable[] }>(`/bots/${encodeURIComponent(botId)}`, undefined, undefined, signal),
  runs: (botId: string, routineId?: string, signal?: AbortSignal) => request<{ runs: RoutineRun[] }>(`/bots/${encodeURIComponent(botId)}/runs${routineId ? `?routineId=${encodeURIComponent(routineId)}` : ''}`, undefined, undefined, signal),
  run: (id: string, signal?: AbortSignal) => request<{ run: RoutineRun; artifacts: Artifact[] }>(`/runs/${encodeURIComponent(id)}`, undefined, undefined, signal),
  preview: (id: string, channel: DeliveryChannel) => request<{ destination: DeliveryDestination }>(`/artifacts/${encodeURIComponent(id)}/delivery-preview`, { channel }),
  retryPreview: (id: string) => request<{ destination: DeliveryDestination }>(`/deliveries/${encodeURIComponent(id)}/retry-preview`, {}),
  delivery: (id: string) => request<{ delivery: ArtifactDelivery }>(`/deliveries/${encodeURIComponent(id)}`),
  execute: (action: DeliveryAction) => request<{ delivery: ArtifactDelivery }>(action.kind === 'send' ? `/artifacts/${encodeURIComponent(action.artifactId)}/deliveries` : `/deliveries/${encodeURIComponent(action.deliveryId)}/${action.kind}`, action.body, action.key),
  deliver: (id: string, channel: DeliveryChannel, key: string) => request<{ delivery: ArtifactDelivery }>(`/artifacts/${encodeURIComponent(id)}/deliveries`, { channel }, key),
  retry: (id: string) => request<{ delivery: ArtifactDelivery }>(`/deliveries/${encodeURIComponent(id)}/retry`, {}),
};
