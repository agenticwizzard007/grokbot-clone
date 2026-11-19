import type { DeliveryChannel } from './deliverablesApi';

export interface DeliveryDestination {
  target: { channel: DeliveryChannel; transport?: string; phone?: string | null; chatRef?: string | null; revision?: string };
  recipient: string; artifact_sha256: string; proof: string;
}
/** The exact approved body and key survive reloads and response loss. */
export type DeliveryAction = {
  key: string; artifactId: string; createdAt: number;
} & (
  | { kind: 'send'; body: { channel: DeliveryChannel; destination: DeliveryDestination } }
  | { kind: 'retry'; deliveryId: string; body: { destination: DeliveryDestination; expectedAttemptId: string } }
  | { kind: 'reconcile'; deliveryId: string; body: { outcome: 'delivered' | 'not_sent'; evidence: string; expectedAttemptId: string } }
);
export function deliveryJournalKey(userId: string, botId: string): string { return `swarm.delivery-actions.${userId}.${botId}`; }
export function readDeliveryActions(storageKey: string): DeliveryAction[] {
  const text = localStorage.getItem(storageKey);
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some(a => !a || typeof a !== 'object' || typeof a.key !== 'string' || typeof a.artifactId !== 'string' || !['send', 'retry', 'reconcile'].includes(a.kind) || !a.body)) throw new Error('Saved delivery requests could not be read. Resolve browser storage before sending.');
  return value as DeliveryAction[];
}
export function persistDeliveryAction(storageKey: string, action: DeliveryAction): void {
  const actions = readDeliveryActions(storageKey);
  const existing = actions.find(a => a.key === action.key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(action)) throw new Error('A saved delivery request cannot change.');
  const unresolved = actions.find(a => a.artifactId === action.artifactId && a.key !== action.key);
  if (unresolved) throw new Error('Resolve the saved request for this artifact before starting another action.');
  localStorage.setItem(storageKey, JSON.stringify(existing ? actions : [...actions, action]));
}
export function resolveDeliveryAction(storageKey: string, key: string): void {
  localStorage.setItem(storageKey, JSON.stringify(readDeliveryActions(storageKey).filter(a => a.key !== key)));
}
