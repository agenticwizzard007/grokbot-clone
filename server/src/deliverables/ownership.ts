import fs from 'node:fs';
import { db } from '../db.js';
import { assertTenant } from '../deployment.js';
import { assertLegacyWorkOpen } from '../security/legacy-work.js';
import { DeliverableError } from './types.js';

export function ownBot(userId: string, botId: string) {
  assertTenant(userId);
  const row = db.prepare('SELECT id,user_id FROM bots WHERE id=? AND user_id=?').get(botId, userId) as { id: string; user_id: string } | undefined;
  if (!row) throw new DeliverableError('Not found.', 404);
  return row;
}
export function writeOwner(userId: string, botId: string) { ownBot(userId, botId); assertLegacyWorkOpen(userId); }

export function processBirth(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}
export const ownerBirth = processBirth(process.pid) ?? `process-${Date.now()}`;
export function ownerAlive(pid: number | null, birth: string | null) {
  if (!pid || !birth) return false;
  if (pid === process.pid) return birth === ownerBirth;
  const current = processBirth(pid);
  if (current !== null) return current === birth;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; }
}
