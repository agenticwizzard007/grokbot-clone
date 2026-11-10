import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateCli, cliRuntime, selectedCli, type CliProvider } from './store.js';
import { hostedGenerate, hostedStatus, refreshHosted, serverLoginAvailable } from './hosted.js';

export interface CliAuthStatus { installed: boolean; authenticated: boolean; subscription: boolean; error?: string }
export type CliProviders = Record<CliProvider, CliAuthStatus>;
interface Pending { finish: (error?: Error, value?: unknown) => void }
interface Connection { ws: WebSocket; device: string; providers: CliProviders; pending: Map<string, Pending> }
const connections = new Map<string, Connection>();
const missing = (): CliProviders => ({
  codex: { installed: false, authenticated: false, subscription: false },
  claude: { installed: false, authenticated: false, subscription: false },
});
export const CLI_OFFLINE = 'Your subscription CLI bridge is offline. Connect it in Settings → Subscriptions. No API fallback was used.';

export function cliStatus(userId: string) {
  const runtime = cliRuntime(userId);
  if (runtime === 'server') return { selected: selectedCli(userId), runtime, serverLoginAvailable: serverLoginAvailable(), device: 'Swarm server', ...hostedStatus(userId) };
  const c = connections.get(userId);
  return { selected: selectedCli(userId), runtime, serverLoginAvailable: serverLoginAvailable(), connected: !!c, device: c?.device ?? null, providers: c?.providers ?? missing() };
}

export function disconnectCli(userId: string) {
  const c = connections.get(userId);
  if (c) {
    connections.delete(userId);
    for (const p of [...c.pending.values()]) p.finish(new Error(CLI_OFFLINE));
    c.ws.close(4401, 'pairing revoked');
  }
}

export function cliRequest(userId: string, method: 'status' | 'generate', params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  if (cliRuntime(userId) === 'server') return method === 'status' ? refreshHosted(userId, signal) : hostedGenerate(userId, params, signal);
  const c = connections.get(userId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(CLI_OFFLINE));
  if (signal?.aborted) return Promise.reject(new Error('CLI request cancelled.'));
  if (c.pending.size >= 4) return Promise.reject(new Error('Your CLI bridge is busy. Try again when a running task finishes.'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ method: 'cancel', id }));
    };
    const abort = () => { cancel(); finish(new Error('CLI request cancelled.')); };
    const timer = setTimeout(() => { cancel(); finish(new Error('CLI request timed out. No API fallback was used.')); }, timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      if (!c.pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    c.pending.set(id, { finish });
    signal?.addEventListener('abort', abort, { once: true });
    try { c.ws.send(JSON.stringify({ id, method, params }), (error) => { if (error) finish(new Error(CLI_OFFLINE)); }); }
    catch { finish(new Error(CLI_OFFLINE)); }
  });
}

export async function refreshCli(userId: string) {
  if (cliRuntime(userId) === 'server') { await refreshHosted(userId); return cliStatus(userId); }
  const c = connections.get(userId);
  if (!c) return cliStatus(userId);
  const result = await cliRequest(userId, 'status', {}, 25_000);
  const providers = missing();
  for (const p of ['codex', 'claude'] as const) {
    const s = result?.[p];
    if (!s || typeof s.installed !== 'boolean' || typeof s.authenticated !== 'boolean' || typeof s.subscription !== 'boolean') throw new Error('CLI bridge returned an invalid authentication status. Update your bridge.');
    providers[p] = { installed: s.installed, authenticated: s.authenticated, subscription: s.subscription, ...(typeof s.error === 'string' ? { error: s.error.slice(0, 500) } : {}) };
  }
  if (connections.get(userId) === c) c.providers = providers;
  return cliStatus(userId);
}

export function attachCliSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/cli-bridge') return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      let userId: string | null = null;
      let connection: Connection | undefined;
      let alive = true;
      const handshake = setTimeout(() => ws.close(4400, 'expected hello'), 5_000);
      const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 25_000);
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => { ws.terminate(); });
      ws.on('message', (raw, binary) => {
        if (binary) return ws.close(4400, 'JSON required');
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return ws.close(4400, 'invalid JSON'); }
        if (!connection) {
          if (msg?.type !== 'hello' || msg.version !== 1 || typeof msg.token !== 'string') return ws.close(4400, 'update bridge');
          userId = authenticateCli(msg.token);
          if (!userId) return ws.close(4401, 'invalid or expired pairing token');
          clearTimeout(handshake);
          disconnectCli(userId);
          connection = { ws, device: String(msg.device ?? 'My computer').slice(0, 100), providers: missing(), pending: new Map() };
          connections.set(userId, connection);
          ws.send(JSON.stringify({ type: 'welcome' }));
          void refreshCli(userId).catch(() => {});
          return;
        }
        if (!msg || typeof msg.id !== 'string') return;
        const pending = connection.pending.get(msg.id);
        if (!pending) return;
        pending.finish(typeof msg.error === 'string' ? new Error(msg.error.slice(0, 1000)) : undefined, msg.result);
      });
      ws.on('close', () => {
        clearTimeout(handshake);
        clearInterval(heartbeat);
        if (userId && connections.get(userId) === connection) connections.delete(userId);
        if (connection) for (const p of [...connection.pending.values()]) p.finish(new Error(CLI_OFFLINE));
      });
    });
  });
  server.on('close', () => { for (const c of connections.values()) c.ws.terminate(); wss.close(); });
}
