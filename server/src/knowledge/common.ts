import { db } from '../db.js';
import './schema.js';

export class KnowledgeError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 = 400) { super(message); }
}
export function ownedBot(userId: string, botId: string): { id: string; user_id: string; generation: number } {
  const bot = db.prepare('SELECT id,user_id,generation FROM bots WHERE id=? AND user_id=?').get(botId, userId) as any;
  if (!bot) throw new KnowledgeError('Not found', 404);
  return bot;
}
export function expectedRevision(actual: number, expected: unknown) {
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) throw new KnowledgeError('expectedRevision must be an integer');
  if (actual !== expected) throw new KnowledgeError('This item changed. Refresh before applying the change.', 409);
}
export function boundedText(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new KnowledgeError(`${label} must be ${empty ? 'at most' : '1–'}${max} characters`);
  return value.trim();
}
export function checkedRun(userId: string, botId: string, runId?: string): string | null {
  if (!runId) return null;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_jobs'").get();
  if (!exists || !db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND bot_id=? AND user_id=?').get(runId, botId, userId)) throw new KnowledgeError('Run evidence does not belong to this agent', 422);
  return runId;
}
