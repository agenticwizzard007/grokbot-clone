import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const context = new AsyncLocalStorage<{ tenant_hash: string | null }>();
export const tenantHash = (tenant: string) => createHash('sha256').update(tenant).digest('hex');
/** Call only after identity verification. Never infer identity from request input. */
export function bindTenantLog(tenant: string) {
  const current = context.getStore();
  if (current) current.tenant_hash = tenantHash(tenant);
}
type Role = 'platform' | 'provisioner' | 'composio-gateway';
export function tenantRequestLog(role: Role, write = (line: string) => console.log(line)): MiddlewareHandler {
  return async (c, next) => context.run({ tenant_hash: null }, async () => {
    const start = performance.now();
    try { await next(); }
    finally {
      // No URL, query, headers, body, provider response or error text enters logs.
      write(JSON.stringify({ event: 'request', role, tenant_hash: context.getStore()!.tenant_hash,
        method: ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(c.req.method) ? c.req.method : 'OTHER',
        status: c.error ? 500 : c.res.status, duration_ms: Math.round(performance.now() - start) }));
    }
  });
}
export async function tenantWorkerLog<T>(operation: 'lifecycle' | 'environment' | 'meter', work: () => Promise<T>, write = (line: string) => console.log(line)) {
  return context.run({ tenant_hash: null }, async () => {
    let ok = false;
    try { const result = await work(); ok = result !== 'retry'; return result; }
    finally {
      if (context.getStore()!.tenant_hash) write(JSON.stringify({ event: 'worker', role: 'provisioner', operation,
        tenant_hash: context.getStore()!.tenant_hash, ok }));
    }
  });
}
