import path from 'node:path';
import { Inkbox } from '@inkbox/sdk';
import { connect, type TunnelListener } from '@inkbox/sdk/tunnels/connect';
import { env } from '../../env.js';

/**
 * The line's own public address, through Inkbox's tunnel: every identity owns https://<handle>.inkboxwire.com.
 * The connection goes out from this server (HTTPS only), so texting works on a laptop or a sandbox with no public URL.
 * Only the webhook is served through it; every other path answers 404, so the app itself is never exposed.
 *
 * On by default. Set INKBOX_TUNNEL=0 when SERVER_URL is publicly reachable and you'd rather Inkbox post there.
 */

export const WEBHOOK_PATH = '/api/messaging/inkbox/webhook';
export const tunnelEnabled = () => process.env.INKBOX_TUNNEL !== '0';

let listener: TunnelListener | null = null;
let starting: Promise<string> | null = null;
let lastError: string | null = null;

type Webhook = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

/** Open the tunnel (once) and return its public URL. Requests other than the webhook POST get 404. */
export function startTunnel(webhook: Webhook): Promise<string> {
  if (listener) return Promise.resolve(listener.publicUrl);
  if (starting) return starting;
  starting = (async () => {
    try {
      const inkbox = new Inkbox({ apiKey: env.inkboxIdentityKey, baseUrl: env.inkboxBaseUrl });
      listener = await connect(inkbox, {
        name: env.inkboxHandle,
        stateDir: path.join(path.dirname(env.dbPath), 'inkbox-tunnel'),
        installSignalHandlers: false,
        maxInboundBodyBytes: 1024 * 1024,
        onStatus: (s) => console.log(`[inkbox] tunnel ${s}`),
        handler: async (req) => {
          const url = new URL(req.url);
          if (req.method !== 'POST' || url.pathname !== WEBHOOK_PATH) return new Response('not found', { status: 404 });
          return webhook.request('/', { method: 'POST', headers: req.headers, body: await req.text() });
        },
      });
      lastError = null;
      console.log(`[inkbox] tunnel open at ${listener.publicUrl}`);
      void listener.wait().catch((e) => { lastError = String(e?.message ?? e); console.warn('[inkbox] tunnel closed:', lastError); listener = null; });
      return listener.publicUrl;
    } catch (e: any) {
      lastError = String(e?.message ?? e);
      throw e;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export async function stopTunnel() {
  const l = listener;
  listener = null;
  await l?.close().catch(() => {});
}

export const tunnelStatus = () => ({ enabled: tunnelEnabled(), url: listener?.publicUrl ?? null, connected: !!listener?.isConnected, error: lastError });

/** Where Inkbox should post: the tunnel when it's on, else SERVER_URL. */
export const tunnelWebhookUrl = () => (listener ? `${listener.publicUrl.replace(/\/$/, '')}${WEBHOOK_PATH}` : null);
