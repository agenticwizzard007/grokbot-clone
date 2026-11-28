import { Hono } from 'hono';
import type { RuntimeIdentity } from './runtime-identity.js';
import type { TenantMeter } from './meter.js';

async function readReport(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('JSON required.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing meter body.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Meter body timeout.')), 2000); });
  try {
    let bytes = 0; const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await Promise.race([reader.read(),timeout]);
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 8192) throw new Error('Meter body oversized.');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
export function meterRoutes(meter: TenantMeter, runtime: RuntimeIdentity, enabled: boolean) {
  const app = new Hono(); let pending = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control','no-store');
    if (!enabled) return c.json({ error: 'Tenant metering is disabled.' },404);
    if (pending >= 32) return c.json({ error: 'Meter collector is busy.' },503);
    pending++;
    try {
      const token = (c.req.header('authorization') ?? '').replace(/^Bearer /,'');
      try { await runtime.verify(token); } catch { return c.json({ error: 'Runtime authorization required.' },401); }
      await next();
    } finally { pending--; }
  });
  app.post('/', async c => {
    let report;
    try { report = await readReport(c.req.raw); } catch { return c.json({ error: 'Invalid bounded meter report.' },400); }
    try {
      await meter.accept((c.req.header('authorization') ?? '').replace(/^Bearer /,''),report);
      return c.body(null,204);
    } catch { return c.json({ error: 'Meter report refused.' },409); }
  });
  app.get('/allowance', async c => {
    // This path has no caller-selected tenant or month.
    if (new URL(c.req.url).search) return c.json({ error: 'Allowance query is unsupported.' },400);
    try { return c.json(await meter.allowance((c.req.header('authorization') ?? '').replace(/^Bearer /,''))); }
    catch { return c.json({ error: 'Runtime authorization changed.' },401); }
  });
  return app;
}
