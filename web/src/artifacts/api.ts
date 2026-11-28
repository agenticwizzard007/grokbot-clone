import { ApiError } from '../lib/api';
import type { CollaborativeArtifact, ArtifactMember, ArtifactComment } from '@shared/deliverables/types';
export type { CollaborativeArtifact, ArtifactMember, ArtifactComment };
export type ArtifactDetail = { artifact: CollaborativeArtifact; members: ArtifactMember[]; comments: ArtifactComment[] };
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/deliverables${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(response.status, error?.error ?? 'Could not load artifacts. Please try again.');
  }
  return response.json();
}
export const artifactApi = {
  library: (botId?: string, offset = 0, signal?: AbortSignal) => request<{ artifacts: CollaborativeArtifact[]; total: number }>(`/library?offset=${offset}${botId ? `&botId=${encodeURIComponent(botId)}` : ''}`, undefined, signal),
  detail: (id: string, signal?: AbortSignal) => request<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}`, undefined, signal),
  content: (id: string, signal?: AbortSignal) => request<{ text: string | null }>(`/artifacts/${encodeURIComponent(id)}/content`, undefined, signal),
  member: (id: string, email: string, role: 'viewer' | 'commenter' | 'remove') => request<{ members: ArtifactMember[] }>(`/artifacts/${encodeURIComponent(id)}/members`, { email, role }),
  comment: (id: string, body: string, requestId: string) => request<{ comments: ArtifactComment[] }>(`/artifacts/${encodeURIComponent(id)}/comments`, { body, requestId }),
};
export const artifactUrl = (id: string) => `${location.origin}/artifacts/${encodeURIComponent(id)}`;
