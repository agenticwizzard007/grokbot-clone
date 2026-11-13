export type RoutineRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'unknown' | 'cancelled';
export type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown';
export type DeliveryChannel = 'library' | 'imessage' | 'sms' | 'whatsapp';

export interface RoutineRun {
  id: string; botId: string; routineId: string; routineName: string; jobId: string | null;
  kind: string; status: RoutineRunStatus; error: string | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface Artifact {
  id: string; botId: string; runId: string | null; jobId: string | null;
  filename: string; mimeType: string; size: number; sha256: string; createdAt: number;
  libraryPath: string; downloadUrl: string;
}
export interface DeliveryAttempt {
  id: string; number: number; status: DeliveryStatus; error: string | null;
  startedAt: number; finishedAt: number | null; externalId: string | null;
}
export interface ArtifactDelivery {
  id: string; artifactId: string; channel: DeliveryChannel; status: DeliveryStatus;
  error: string | null; createdAt: number; updatedAt: number; attempts: DeliveryAttempt[];
  acknowledgement?: 'provider'|'owner'|'library'|null;
  reconciliations?: {id:string;outcome:'delivered'|'not_sent';evidence:string;attemptId:string;createdAt:number}[];
}
export class DeliverableError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 503 = 400) { super(message); }
}
/** Only use before any external send has been invoked. Generic/network errors are uncertain. */
export class DeliveryNotSentError extends Error {}
