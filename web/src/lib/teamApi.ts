import { nativeRequest } from './learningApi';
export interface TeamTask {
  id: string; title: string; status: string; assignedBotId: string | null; workerBotId: string | null;
  dependsOn: string[]; reason: string; resultValidated: boolean; evidence: unknown[]; activeJobId: string | null;
}
export interface TeamState {
  userId: string; generatedAt: number; eventCursor: number; sourceVersions: Record<string, string>; primaryBotId: string | null;
  agents: { botId: string; name: string; isPrimary: boolean; setupStatus: string; setupRevision: number; status: string; pendingDecision: boolean; activeJobIds: string[] }[];
  jobs: { id: string; botId: string; state: string; createdAt: number; parentJobId: string | null; workflowId: string | null; taskId: string | null; goalId: string | null }[];
  workflows: { id: string; botId: string; goalId: string | null; title: string; status: string; reason: string; updatedAt: number; tasks: TeamTask[] }[];
  artifacts: { id: string; botId: string; status: string; title: string; revision: string }[];
  deliveries: { id: string; botId: string; artifactId: string | null; status: string; revision: string }[];
  requests: { queued: number; deferred: number; admitted: number; completed: number; failed: number };
  health: { runtime: string; lastTickAt: number | null; lastError: string | null; pendingWakes: number };
}
export interface InternalRequest {
  seq: number; id: string; fromBotId: string; toBotId: string; text: string;
  status: 'queued' | 'deferred' | 'admitted' | 'completed' | 'failed'; kind: 'request' | 'result';
  correlationId: string; parentRequestId: string | null; depth: number; audience: 'internal';
  jobId: string | null; result: string | null; reason: string; revision: number; createdAt: number; updatedAt: number;
}
export const teamApi = {
  state: () => nativeRequest<{ state: TeamState }>('/team/state'),
  requests: (after = 0, botId?: string) => nativeRequest<{ requests: InternalRequest[]; nextCursor: number; hasMore: boolean }>(`/team/requests?limit=50&after=${after}${botId ? `&botId=${encodeURIComponent(botId)}` : ''}`),
};
