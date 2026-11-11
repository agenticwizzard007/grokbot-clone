import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { isTenant, tenantId } from '../deployment.js';
import { env } from '../env.js';
import { sha256 } from '../lib/ids.js';
import { tenantCompanionReady } from './local.js';

/** Mounted only by tenant-app. It exposes no token and accepts only this host boot's token. */
export function tenantDesktopReadiness(desktopToken: string) {
  if (!isTenant || env.computerProvider !== 'local' || !desktopToken || !process.env.SWARM_RUNTIME_GENERATION) throw new Error('Tenant desktop readiness identity missing.');
  const expectedHash = sha256(desktopToken), generation = process.env.SWARM_RUNTIME_GENERATION;
  return new Hono().get('/', c => {
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.startsWith('Bearer ') || !timingSafeEqual(Buffer.from(sha256(authorization.slice(7))), Buffer.from(expectedHash))) return c.json({ error: 'Unauthorized' }, 401);
    const ready = tenantCompanionReady(expectedHash);
    return c.json({ ready, tenant: tenantId, generation, mode: 'multi' }, ready ? 200 : 503);
  });
}
