import type { MiddlewareHandler } from 'hono';
import { env } from '../env.js';
export function allowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return [env.appUrl, env.serverUrl].some(url => { try { return new URL(url).origin === origin; } catch { return false; } });
}
/** Native clients use JSON without an Origin; browser mutations must be same-origin. */
export const requestBoundary: MiddlewareHandler = async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Invalid request origin.' }, 403);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && !allowedBrowserOrigin(origin)) return c.json({ error: 'Invalid request origin.' }, 403);
    // These streams are authenticated by a host-audience JWT at the destination;
    // the normal JSON browser API must not accept arbitrary binary bodies.
    const backupStream=c.req.method==='PUT'&&/^\/internal\/host\/backups\/[a-f0-9]{32}\/(?:manifest|\d{1,6})\.bin$/.test(c.req.path)&&c.req.header('content-type')==='application/octet-stream'&&/^Bearer \S+$/.test(c.req.header('authorization')??'');
    if (!backupStream && c.req.header('content-type') && !/^(application\/json|multipart\/form-data)(;|$)/i.test(c.req.header('content-type')!)) return c.json({ error: 'Unsupported request format.' }, 415);
  }
  await next();
};
