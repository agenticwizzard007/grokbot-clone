import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostActivation } from './host-activation.js';

interface Application {
  tenant: string;
  generation: string;
  desktopToken: string;
  database: string;
  activation: Pick<HostActivation, 'policy' | 'report'>;
}
interface Transport {
  request?: typeof fetch;
  pause?: () => Promise<void>;
}
const origin = 'http://172.30.0.2:8787';

/** Every request checks live socket state. A success is not a durable qualification receipt. */
export async function desktopReady(app: Application, transport: Transport = {}): Promise<boolean> {
  try {
    const response = await (transport.request ?? fetch)(`${origin}/internal/desktop-ready`, {
      redirect: 'error', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${app.desktopToken}` },
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 1024) return false;
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    return value.ready === true && value.mode === 'multi' && value.tenant === app.tenant && value.generation === app.generation;
  } catch { return false; }
}

/** Recheck after the asynchronous policy lookup; backup holds invalidate in-flight refreshes. */
export async function reportApplicationRunning(app: Application, transport: Transport = {}, current = () => true): Promise<boolean> {
  const policy = await app.activation.policy();
  if (policy.desired !== 'run') throw new Error('Workload authorization changed during readiness.');
  if (!current()) return false;
  const ready = await desktopReady(app, transport);
  if (!current()) return false;
  if (!ready) throw new Error('Tenant desktop companion readiness failed.');
  await app.activation.report(policy, 'running');
  return true;
}

/** Used for initial startup and every backup resume, before publishing running state. */
export async function confirmApplicationReady(app: Application, transport: Transport = {}, current = () => true) {
  const pause = transport.pause ?? (() => delay(1000));
  let healthy = false;
  for (let attempt = 0; attempt < 30 && current(); attempt++) {
    try {
      const response = await (transport.request ?? fetch)(`${origin}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      healthy = response.ok; await response.body?.cancel();
    } catch { /* Bounded startup retries. */ }
    if (healthy) break; await pause();
  }
  if (!healthy) throw new Error('Tenant application readiness failed.');
  const database = new Database(app.database, { readonly: true, fileMustExist: true });
  try {
    if ((database.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as { tenant_id?: string })?.tenant_id !== app.tenant) throw new Error('Tenant database owner mismatch.');
  } finally { database.close(); }
  let connected = false;
  for (let attempt = 0; attempt < 30 && current(); attempt++) {
    connected = await desktopReady(app, transport);
    if (connected) break; await pause();
  }
  if (!connected) throw new Error('Tenant desktop companion readiness failed.');
  if (!await reportApplicationRunning(app, transport, current)) throw new Error('Tenant application startup was interrupted.');
}
