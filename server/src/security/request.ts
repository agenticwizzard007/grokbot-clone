import type { Context, MiddlewareHandler } from 'hono';
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

/**
 * Content Security Policy for the web app shell (MF-002). Built from what web/src actually loads:
 * - scripts: Vite bundles from 'self'; the voice AudioWorklet is loaded from a blob: URL.
 * - styles: React style attributes and xterm inject inline styles, so 'unsafe-inline' stays for styles only.
 * - connect: same origin API, SSE and the noVNC viewer socket (wss://<host>/api/bots/:id/screen), plus the
 *   realtime voice socket, whose host comes from server configuration (so any https:/wss: endpoint).
 * - images: Composio app logos and MCP icons come from many hosts, plus data: and blob: previews.
 * - media: voice samples play from blob: URLs.
 * Sign-in and app connections use redirects and popups, never frames, so nothing may frame the app.
 */
export function contentSecurityPolicy(secure = true): string {
  // Plain http deployments (local development) also load images and sockets over http: and ws:.
  const http = secure ? '' : ' http:';
  const ws = secure ? '' : ' ws:';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:" + http,
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https: wss:" + http + ws,
    "frame-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}
/** For server rendered HTML under /api (OAuth popups with a tiny inline script): framing rules only. */
export const API_HTML_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

const isSecure = (c: Context) => { try { if (new URL(env.serverUrl).protocol === 'https:') return true; } catch { /* default below */ } return c.req.header('x-forwarded-proto') === 'https'; };

/** Set headers on a finished response; responses with immutable headers (proxied fetches) are copied first. */
function setResponseHeaders(c: Context, headers: Record<string, string>) {
  try { for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v); }
  catch {
    const copy = new Response(c.res.body, c.res);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    c.res = copy;
  }
}

/**
 * Baseline headers for every response of the tenant app (MF-002). Public routes stay public: there is no
 * origin check here, so health, version and the companion and CLI scripts remain fetchable.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
  const secure = isSecure(c);
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  const api = c.req.path === '/api' || c.req.path.startsWith('/api/');
  const html = /text\/html/i.test(c.res.headers.get('Content-Type') ?? '');
  if (!c.res.headers.has('Referrer-Policy')) headers['Referrer-Policy'] = api ? 'no-referrer' : 'strict-origin-when-cross-origin';
  if (api && !c.res.headers.has('Cache-Control')) headers['Cache-Control'] = 'no-store';
  if (html && !c.res.headers.has('Content-Security-Policy')) headers['Content-Security-Policy'] = api ? API_HTML_POLICY : contentSecurityPolicy(secure);
  setResponseHeaders(c, headers);
};

/**
 * HEAD support for the node adapter (MF-063). Hono answers HEAD by running GET and dropping the body,
 * which leaves a keep-alive response with no length, so some proxies wait for the connection to close.
 * Run GET, measure the body and answer with an explicit Content-Length and no body. Event streams are
 * cancelled instead of read.
 */
export function withHeadSupport<Args extends unknown[]>(fetch: (req: Request, ...rest: Args) => Response | Promise<Response>) {
  return async (req: Request, ...rest: Args): Promise<Response> => {
    if (req.method !== 'HEAD') return fetch(req, ...rest);
    const res = await fetch(new Request(req.url, { method: 'GET', headers: req.headers }), ...rest);
    const headers = new Headers(res.headers);
    if (res.body) {
      if (headers.has('Content-Length') || /text\/event-stream/i.test(headers.get('Content-Type') ?? '')) await res.body.cancel().catch(() => {});
      else headers.set('Content-Length', String((await res.arrayBuffer()).byteLength));
    } else if (!headers.has('Content-Length')) headers.set('Content-Length', '0');
    return new Response(null, { status: res.status, statusText: res.statusText, headers });
  };
}

/** Public health check (MF-001): only liveness, never provider, model, key or feature details. */
export const publicHealth = (c: Context) => { c.header('Cache-Control', 'no-store'); return c.json({ ok: true as const }); };

/** Handler timing only for signed-in requests (MF-002); public routes do not reveal it. */
export const serverTimingForUsers: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  if (c.req.path !== '/api/events' && c.get('user')) c.header('Server-Timing', `app;dur=${(performance.now() - start).toFixed(1)}`);
};
