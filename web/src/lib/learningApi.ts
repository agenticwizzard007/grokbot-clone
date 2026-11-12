import { ApiError } from './api';
import type { KnowledgeMemory, KnowledgeSkill, MessageSource } from './configApi';

/** Wire contracts published in the native build's learning-api.md. */
export interface LearningSettings {
  enabled: boolean; automaticReview: boolean; memoryReview: boolean; skillReview: boolean;
  memoryTurnInterval: number; skillIterationInterval: number; skillApproval: boolean;
  maxIterations: number; maxInputTokens: number | null; auxiliaryModel: string | null; auxiliaryProvider: string | null;
  curatorEnabled: boolean; curatorIntervalHours: number; curatorMinIdleHours: number;
  curatorStaleDays: number; curatorArchiveDays: number; curatorConsolidate: boolean;
}
export interface LearningSettingsView {
  settings: LearningSettings; account: LearningSettings; overrides: Partial<LearningSettings> | null;
  revision: number; accountRevision: number; botId: string | null;
}
export interface LearningReview {
  id: string; userId: string; botId: string; jobId: string | null; parentJobId: string | null;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'; reason: string;
  reviewMemory: boolean; reviewSkills: boolean; model: string | null; provider: string | null;
  settingsRevision: string; foregroundEpoch: number; generation: number;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
  iterations: number; inputTokens: number; outputTokens: number; summary: string | null; error: string | null;
}
export type KnowledgeScope = 'private' | 'project' | 'account';
export interface ScopedKnowledge { scope: KnowledgeScope; projectId: string | null }
export interface LearningSkill extends KnowledgeSkill, ScopedKnowledge {
  resources: Record<string, string>; locked: boolean; pinned: boolean; managed: boolean; lastUsedAt: number | null;
}
export interface LearningMemory extends Omit<KnowledgeMemory, 'scope' | 'projectId'>, ScopedKnowledge {
  target: 'user' | 'environment'; evidenceKind: 'human' | 'tool' | 'hypothesis';
}
export interface MemoryChange {
  id: string; botId: string; memoryId: string | null; baseRevision: number; generation: number;
  action: 'replace' | 'remove' | 'add'; text: string | null; target: 'user' | 'environment';
  evidence: MessageSource[]; runId: string | null; status: 'pending' | 'approved' | 'rejected';
  createdAt: number; resolvedAt: number | null;
}
export async function nativeRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'include', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.error || `Could not load ${path.split('/')[1]}.`);
  if (value === null) throw new Error('The server returned an unreadable response. Refresh to try again.');
  return value as T;
}
const id = encodeURIComponent;
export const learningApi = {
  settings: (botId?: string) => nativeRequest<LearningSettingsView>(`/learning/settings${botId ? `?botId=${id(botId)}` : ''}`),
  saveSettings: (expectedRevision: number, settings: Partial<LearningSettings>, botId?: string) => nativeRequest<LearningSettingsView>('/learning/settings', 'PATCH', { expectedRevision, settings, ...(botId ? { botId } : {}) }),
  reviews: (botId?: string, before?: number) => nativeRequest<{ reviews: LearningReview[]; nextBefore: number | null }>(`/learning/reviews?limit=20${botId ? `&botId=${id(botId)}` : ''}${before === undefined ? '' : `&before=${before}`}`),
  refine: (botId: string) => nativeRequest<{ review: LearningReview }>(`/learning/bots/${id(botId)}/refine`, 'POST', {}),
  cancel: (reviewId: string) => nativeRequest<{ review: LearningReview }>(`/learning/reviews/${id(reviewId)}/cancel`, 'POST', {}),
  memoryChanges: (botId: string) => nativeRequest<{ changes: MemoryChange[] }>(`/learning/bots/${id(botId)}/memory-changes`),
  reviewMemory: (change: MemoryChange, decision: 'approve' | 'reject') => nativeRequest<{ status: string; memory: LearningMemory | null }>(`/learning/memory-changes/${id(change.id)}/review`, 'POST', { decision, expectedBaseRevision: change.baseRevision }),
  skills: (botId: string, archive = false) => nativeRequest<{ skills: LearningSkill[] }>(`/learning/bots/${id(botId)}/skills${archive ? '?archive=1' : ''}`),
  skill: (skillId: string) => nativeRequest<{ skill: LearningSkill }>(`/learning/skills/${id(skillId)}`),
  updateSkill: (skillId: string, patch: Partial<Pick<LearningSkill, 'name' | 'description' | 'body' | 'resources' | 'locked' | 'pinned' | 'managed'>> & { expectedRevision: number }) => nativeRequest<{ skill: LearningSkill }>(`/learning/skills/${id(skillId)}`, 'PATCH', patch),
  archive: (skillId: string, expectedRevision: number) => nativeRequest<{ skill: LearningSkill }>(`/learning/skills/${id(skillId)}/archive`, 'POST', { expectedRevision }),
  scope: (kind: 'skills' | 'memories', itemId: string, expectedRevision: number, scope: KnowledgeScope, projectId?: string, botIds?: string[]) => nativeRequest<{ item: LearningSkill | LearningMemory }>(`/learning/${kind}/${id(itemId)}/scope`, 'PATCH', { expectedRevision, scope, ...(scope === 'project' ? { projectId, botIds } : {}) }),
  curate: (botId: string) => nativeRequest<{ archived: string[]; stale: string[]; deferred: boolean }>(`/learning/bots/${id(botId)}/curate`, 'POST', {}),
};
