import { db } from '../db.js';
import { env } from '../env.js';
import { deploymentRole } from '../deployment.js';
import { driver, vmFor } from '../computers/cloudvm.js';
import type { VmInfo } from '../computers/vm/driver.js';
import { assertLegacyFenceCurrent, type DatabaseFence } from './legacy-database-fence.js';
import { drainLegacyProcess } from './legacy-process-drain.js';

/** Observe an owned legacy desktop stopped after draining this application's
 * callbacks. A directory adapter must supply a live lease/fence check, repeated
 * before each provider effect. This is NOT a full source/file checkpoint.
 * Ambiguous creations/deletions/archives require separate provider reconciliation. */
export async function stopLegacyCloud(receipt: DatabaseFence, authorize: () => Promise<void>, timeoutMs = 15000) {
  if (deploymentRole !== 'standalone' || env.computerProvider !== 'cloudvm') throw new Error('Unsupported legacy source layout.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid legacy stop deadline.');
  const check = async () => {
    if (Date.now() >= deadline) throw new Error('Legacy cloud drain timed out; account remains held.');
    await authorize(); assertLegacyFenceCurrent(db, receipt);
    if (Date.now() >= deadline) throw new Error('Legacy cloud drain timed out; account remains held.');
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + timeoutMs;
  const work = async () => {
    await check();
    await drainLegacyProcess(receipt, Math.max(1, deadline - Date.now()));
    await check();
    const row = vmFor(receipt.tenant);
    // A durable running job can represent a lost provider response, including
    // a create that hasn't appeared in inventory yet. Never infer absence.
    const uncertain = db.prepare("SELECT 1 FROM provision_jobs WHERE (user_id=? OR vm_id=?) AND (status='running' OR (attempts>0 AND status!='done')) LIMIT 1").get(receipt.tenant, row?.vm_id ?? '');
    if (uncertain || row && (!row.ext_id || !['running', 'stopped', 'suspended'].includes(row.status))) throw new Error('Legacy provider operations require reconciliation before stopping.');
    const inventory = await driver.list(); await check();
    const owned = inventory.filter(v => v.userId === receipt.tenant || row && (v.vmId === row.vm_id || v.id === row.ext_id));
    if (!row) {
      if (owned.length) throw new Error('Unrecorded legacy machine requires reconciliation.');
      return { tenant: receipt.tenant, operation: receipt.operation, fence: receipt.fence, machine: null, state: 'absent' as const, boundary: 'legacy-desktop-only' as const };
    }
    const exact = (v: VmInfo | null | undefined) => !!v && v.id === row.ext_id && v.vmId === row.vm_id && v.userId === receipt.tenant;
    if (owned.length !== 1 || !exact(owned[0])) throw new Error('Legacy provider ownership does not match.');
    let info = await driver.get(row.ext_id!); await check();
    if (!exact(info)) throw new Error('Legacy provider ownership changed.');
    if (info!.state !== 'stopped') {
      await check();
      assertLegacyFenceCurrent(db, receipt);
      await driver.stop(row.ext_id!); await check();
      for (;;) {
        await check();
        info = await driver.get(row.ext_id!); await check();
        if (!exact(info)) throw new Error('Legacy provider ownership changed while stopping.');
        if (info!.state === 'stopped') break;
        if (Date.now() >= deadline) throw new Error('Legacy machine stop has not been observed.');
        await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
      }
    }
    const finalInventory = await driver.list(); await check();
    const finalOwned = finalInventory.filter(v => v.userId === receipt.tenant || v.vmId === row.vm_id || v.id === row.ext_id);
    if (finalOwned.length !== 1 || !exact(finalOwned[0]) || finalOwned[0].state !== 'stopped') throw new Error('Legacy stopped inventory requires reconciliation.');
    return { tenant: receipt.tenant, operation: receipt.operation, fence: receipt.fence, machine: row.ext_id!, state: 'stopped' as const, boundary: 'legacy-desktop-only' as const };
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Legacy cloud drain timed out; account remains held.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
