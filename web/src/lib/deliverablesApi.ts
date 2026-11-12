import type { Artifact, ArtifactDelivery, DeliveryChannel, RoutineRun } from '@shared/deliverables/types';
export type { Artifact, ArtifactDelivery, DeliveryChannel, RoutineRun };
export type SavedDeliverable = Artifact & { deliveries: ArtifactDelivery[] };

async function request<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`/api/deliverables${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? 'Could not load saved reports.');
  }
  return response.json();
}
export const deliverablesApi = {
  list: (botId: string) => request<{ artifacts: SavedDeliverable[] }>(`/bots/${encodeURIComponent(botId)}`),
  runs: (botId: string, routineId?: string) => request<{ runs: RoutineRun[] }>(`/bots/${encodeURIComponent(botId)}/runs${routineId ? `?routineId=${encodeURIComponent(routineId)}` : ''}`),
  run: (id: string) => request<{ run: RoutineRun; artifacts: Artifact[] }>(`/runs/${encodeURIComponent(id)}`),
  deliver: (id: string, channel: DeliveryChannel, key: string) => request<{ delivery: ArtifactDelivery }>(`/artifacts/${encodeURIComponent(id)}/deliveries`, { channel }, key),
  retry: (id: string) => request<{ delivery: ArtifactDelivery }>(`/deliveries/${encodeURIComponent(id)}/retry`, {}),
};
