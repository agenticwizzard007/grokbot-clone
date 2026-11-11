import { db } from '../db.js';
import { legacyAccountHeld, legacyHeldOwners } from '../platform/legacy-database-fence.js';
import { LegacyActivityGate } from './legacy-activity.js';

// Background callbacks have a separate counter from request/agent usage. Neither
// counter serializes work or limits subscription concurrency.
const activities = new LegacyActivityGate(db);
export const legacyWorkHeld = (owner: string | null | undefined) => !!owner && legacyAccountHeld(db, owner);
export const heldLegacyOwners = () => legacyHeldOwners(db);
export function legacyPhoneOwner(phone: string): string | undefined {
  const owners = db.prepare("SELECT id FROM users WHERE phone=? AND phone!=''").all(phone.replace(/\D/g, '')) as { id: string }[];
  if (owners.length > 1) throw new Error('Phone account ownership is ambiguous.');
  return owners[0]?.id;
}
export function assertLegacyWorkOpen(owner: string | null | undefined) {
  if (legacyWorkHeld(owner)) throw new Error('This account is being migrated.');
}
export const withLegacyWork = <T>(owner: string | null | undefined, work: () => T): T => activities.run(owner, work);
export async function drainLegacyBackground(owner: string, timeoutMs?: number) {
  await activities.drain(owner, timeoutMs);
  return { tenant: owner, active: 0, boundary: 'tracked-background-only' as const };
}
