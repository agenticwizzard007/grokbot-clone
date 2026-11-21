import { nativeRequest } from './learningApi';
import type { ArtifactDelivery } from './deliverablesApi';

export interface WorkCriterion { id: string; description: string; kind: 'row' | 'file' | 'result'; contains?: string }
export type WorkEvidence = { criterionId: string } & (
  | { kind: 'row'; rowSeq: number; botId: string; generation?: number }
  | { kind: 'file'; path: string; botId: string }
  | { kind: 'result'; taskId: string }
);
export type WorkControl = 'pause' | 'resume' | 'block' | 'stop';
export interface WorkGoal {
  id: string; userId: string; botId: string; title: string; status: 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled'; reason: string;
  criteria: WorkCriterion[]; maxTurns: number; turnsUsed: number; maxTokens: number | null; tokensUsed: number;
  maxSpendUsd: number | null; spendUsd: number; unknownTokenTurns: number; unknownSpendTurns: number; evidence: unknown[];
}
export interface WorkTask {
  id: string; key: string; title: string; instructions: string; status: 'waiting' | 'ready' | 'queued' | 'running' | 'blocked' | 'completed' | 'cancelled';
  reason: string; dependsOn: string[]; assignedBotId: string | null; workerBotId: string | null; activeJobId: string | null;
  correctionCount: number; result: unknown; resultValidated: boolean; criteria: WorkCriterion[]; evidence: unknown[];
}
export interface WorkWorkflow {
  id: string; userId: string; botId: string; goalId: string | null; title: string;
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled'; reason: string; tasks: WorkTask[];
}
export interface WorkRecords { goals: WorkGoal[]; workflows: WorkWorkflow[] }
interface GoalInput { botId: string; title: string; criteria: WorkCriterion[]; maxTurns?: number; maxTokens?: number; maxSpendUsd?: number; start: boolean }
interface WorkflowInput { botId: string; title: string; tasks: Array<{ key: string; title: string; instructions: string; dependsOn: string[]; delegate: boolean; workerBotId?: string; criteria: WorkCriterion[]; outputSchema: Record<string, unknown> }> }
const workflows = '/workflows';
const workflowPath = (id: string) => `${workflows}/${encodeURIComponent(id)}`;
const goalPath = (id: string) => `${workflows}/goals/${encodeURIComponent(id)}`;
const taskPath = (workflowId: string, taskId: string) => `${workflowPath(workflowId)}/tasks/${encodeURIComponent(taskId)}`;

export const workApi = {
  list: (botId?: string, signal?: AbortSignal) => nativeRequest<WorkRecords>(`${workflows}${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`, 'GET', undefined, signal),
  createGoal: (input: GoalInput) => nativeRequest<{ goal: WorkGoal }>(`${workflows}/goals`, 'POST', input),
  createWorkflow: (input: WorkflowInput) => nativeRequest<{ workflow: WorkWorkflow }>(workflows, 'POST', input),
  controlGoal: (id: string, action: WorkControl, reason?: string) => nativeRequest<{ goal: WorkGoal }>(`${goalPath(id)}/control`, 'POST', { action, reason }),
  controlWorkflow: (id: string, action: WorkControl, reason?: string) => nativeRequest<{ workflow: WorkWorkflow }>(`${workflowPath(id)}/control`, 'POST', { action, reason }),
  startWorkflow: (id: string) => nativeRequest<{ workflow: WorkWorkflow }>(`${workflowPath(id)}/start`, 'POST', {}),
  addDependency: (workflowId: string, taskId: string, dependsOnId: string) => nativeRequest<{ workflow: WorkWorkflow }>(`${workflowPath(workflowId)}/dependencies`, 'POST', { taskId, dependsOnId }),
  delegateTask: (workflowId: string, taskId: string, workerBotId?: string) => nativeRequest<{ childBotId: string; workerBotId: string | null }>(`${taskPath(workflowId, taskId)}/delegate`, 'POST', { workerBotId }),
  verifyGoal: (id: string, evidence: WorkEvidence[]) => nativeRequest<{ goal: WorkGoal }>(`${goalPath(id)}/verify`, 'POST', { evidence }),
  completeTask: (workflowId: string, taskId: string, evidence: WorkEvidence[]) => nativeRequest<{ workflow: WorkWorkflow }>(`${taskPath(workflowId, taskId)}/complete`, 'POST', { evidence }),
};

export interface SynopsisSettings { enabled: boolean; times: string[]; timezone: string; timezoneSource: string; quietHours: Array<{ start: string; end: string }> }
export interface SynopsisRecord {
  id: string; seq: number; slotKey: string; slotCount: number; timezone: string; windowStart: number; windowEnd: number;
  sourceCount: number; status: string; artifactId: string | null; gaps: string[];
  coverage: { snapshotComplete: boolean; summaryComplete: boolean; pages: number };
  delivery: ArtifactDelivery | null; generationNote: string | null; lastError: string | null;
}
export interface SynopsisDetail extends SynopsisRecord { content: string | null; pages: Array<{ page: number; artifactId: string }> }
export interface SynopsisSource { ordinal: number; id: string; revision: string; kind: string; state: string; title: string; owner: string; details: string; changed: boolean }
const synopsisPath = (id: string) => `/checkins/reports/${encodeURIComponent(id)}`;
export const synopsisApi = {
  settings: (signal?: AbortSignal) => nativeRequest<SynopsisSettings>('/checkins', 'GET', undefined, signal),
  save: (settings: Partial<Omit<SynopsisSettings, 'timezoneSource'>>) => nativeRequest<SynopsisSettings>('/checkins', 'PUT', settings),
  list: (after = 0, signal?: AbortSignal) => nativeRequest<{ reports: SynopsisRecord[]; nextCursor: number; hasMore: boolean }>(`/checkins/reports?after=${after}&limit=10`, 'GET', undefined, signal),
  report: (id: string, signal?: AbortSignal) => nativeRequest<{ report: SynopsisDetail }>(synopsisPath(id), 'GET', undefined, signal),
  sources: (id: string, after = 0, signal?: AbortSignal) => nativeRequest<{ sources: SynopsisSource[]; nextCursor: number; hasMore: boolean }>(`${synopsisPath(id)}/sources?after=${after}`, 'GET', undefined, signal),
  request: () => nativeRequest<{ ok: true; reportId: string }>('/checkins/now', 'POST'),
  retry: (id: string) => nativeRequest<{ report: SynopsisDetail }>(`${synopsisPath(id)}/retry`, 'POST'),
};
