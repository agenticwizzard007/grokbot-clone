import { db } from '../db.js';
import { assertLegacyFenceCurrent, type DatabaseFence } from './legacy-database-fence.js';
import { drainLegacyUsage } from '../usage-context.js';
import { drainLegacyBackground } from '../security/legacy-work.js';
import { sessionRevoked } from '../security/session-lifecycle.js';
import { dropCompanion, nativeLocal } from '../computers/local.js';
import { disconnectCli } from '../cli/bridge.js';
import { cancelUserLogins } from '../cli/login.js';
import { stopHostedJobsAndWait } from '../cli/hosted.js';
import { withCliMutation } from '../cli/lock.js';
import { closeMcpSessions } from '../mcp/client.js';
import { interrupt } from '../agent/loop.js';
import { drain as drainMessages } from '../messaging/bridge.js';

/** Trusted in-process maintenance, after the database hold. No HTTP entry point.
 * This cannot attest other application processes, remote CLIs, desktop processes
 * or filesystem descriptors. It must never be promoted to SourceCheckpoint.
 * Import the reviewed source's complete schema before taking the database hold. */
export async function drainLegacyProcess(receipt: DatabaseFence, timeoutMs = 15000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid legacy drain deadline.');
  const check = () => assertLegacyFenceCurrent(db, receipt);
  check();
  const owner = receipt.tenant;
  const sessions = db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').all(owner) as { token: string }[];
  const bots = db.prepare('SELECT id FROM bots WHERE user_id=?').all(owner) as { id: string }[];
  const connections = db.prepare('SELECT id FROM mcp_servers WHERE user_id=?').all(owner) as { id: string }[];
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const drain = async () => {
    // No database deletes: the durable hold already invalidates these sessions
    // and tokens, and frozen rows belong in the source checkpoint.
    const closing = await Promise.allSettled([
      ...sessions.map(s => Promise.resolve().then(() => sessionRevoked(s.token))),
      ...bots.map(b => Promise.resolve().then(() => interrupt(b.id))),
      Promise.resolve().then(() => dropCompanion(owner, 'account migration')),
      Promise.resolve().then(() => nativeLocal.dropCompanion(owner, 'account migration')),
      Promise.resolve().then(() => disconnectCli(owner)),
      ...connections.map(c => closeMcpSessions(c.id)),
      withCliMutation(owner, async () => {
        check();
        await cancelUserLogins(owner);
        check();
        await stopHostedJobsAndWait(owner);
      }),
    ]);
    if (closing.some(r => r.status === 'rejected')) throw new Error('Legacy connection or runner cleanup requires retry; account remains held.');
    check();
    await Promise.all([drainLegacyUsage(owner, remaining()), drainLegacyBackground(owner, remaining()), drainMessages(owner)]);
    check();
    return { tenant: owner, operation: receipt.operation, fence: receipt.fence, boundary: 'current-process-only' as const };
  };
  try {
    return await Promise.race([drain(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Legacy process drain timed out; account remains held.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
