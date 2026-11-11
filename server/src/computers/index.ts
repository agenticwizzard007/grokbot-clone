import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { db } from '../db.js';
import { env } from '../env.js';
import { userFromCookieHeader, sessionFromCookie, sessionHash } from '../lib/auth.js';
import { onSessionRevoked } from '../security/session-lifecycle.js';
import { allowedBrowserOrigin } from '../security/request.js';
import { attachCompanionSocket, localProvider, nativeLocal, setComputerStateSource } from './local.js';
import { cloudvmProvider } from './cloudvm.js';
import { orgoProvider } from './orgo.js';
import { ComputerError, type BotScreen, type ComputerProvider } from './types.js';
import { currentUserId, currentComputerRevision } from '../usage-context.js';
import { localAccess } from './local-access.js';

export { ComputerError } from './types.js';
export type { BotScreen, ComputerProvider, Shot } from './types.js';

const serverProvider = env.computerProvider === 'local' ? localProvider : env.computerProvider === 'cloudvm' ? cloudvmProvider : orgoProvider;
const providerFor = (userId: string | null = currentUserId()) => {
  const revision = currentComputerRevision();
  if (userId && revision !== undefined && userId === currentUserId()) unchanged(userId, revision);
  return userId && localAccess(userId).enabled ? nativeLocal.localProvider : serverProvider;
};

function unchanged(userId: string, revision: number) {
  if (localAccess(userId).revision !== revision) throw new ComputerError('Your selected computer changed. Start a new action on the selected computer.', 409);
}

/** User identity comes from explicit ownership for actions and AsyncLocalStorage for tool metadata. */
export const computers: ComputerProvider = {
  get kind() { return providerFor().kind; },
  get capabilities() { return providerFor().capabilities; },
  get promptLine() { return providerFor().promptLine; },
  get toolDescriptions() { return providerFor().toolDescriptions; },
  promptFor: (userId) => { const p = providerFor(userId); return p.promptFor?.(userId) ?? p.promptLine; },
  state: (userId) => providerFor(userId).state(userId),
  refresh: (userId) => providerFor(userId).refresh(userId),
  ensure: async (userId) => {
    const revision = localAccess(userId).revision;
    await providerFor(userId).ensure(userId);
    unchanged(userId, revision);
  },
  suspend: (userId) => providerFor(userId).suspend(userId),
  async screen(userId, botId) {
    const revision = localAccess(userId).revision;
    const screen = await providerFor(userId).screen(userId, botId);
    unchanged(userId, revision);
    // A cached screen must never cross a consent/provider change, including away-and-back.
    return new Proxy(screen, {
      get(target, key: keyof BotScreen) {
        const fn = target[key];
        if (typeof fn !== 'function') return fn;
        return (...args: unknown[]) => { unchanged(userId, revision); return Reflect.apply(fn, target, args); };
      },
    });
  },
  peek: (userId, botId) => providerFor(userId).peek(userId, botId),
  resetScreen: (userId, botId) => providerFor(userId).resetScreen(userId, botId),
  screens: (userId) => providerFor(userId).screens(userId),
  files: {
    save: (userId, ...args) => providerFor(userId).files.save(userId, ...args),
    list: (userId, ...args) => providerFor(userId).files.list(userId, ...args),
    download: (userId, ...args) => providerFor(userId).files.download(userId, ...args),
  },
  async viewer(client, userId, botId, mode) {
    let clients = viewers.get(userId);
    if (!clients) viewers.set(userId, clients = new Set());
    clients.add(client);
    client.once('close', () => { clients.delete(client); if (!clients.size) viewers.delete(userId); });
    return providerFor(userId).viewer(client, userId, botId, mode);
  },
  start: () => serverProvider.start?.(),
};

const viewers = new Map<string, Set<import('ws').WebSocket>>();
export function closeComputerViewers(userId: string) {
  for (const client of viewers.get(userId) ?? []) client.close(1012, 'Selected computer changed');
  viewers.delete(userId);
}

// A background VM connection must not overwrite the selected Mac's status in the UI.
setComputerStateSource((userId) => computers.state(userId));
nativeLocal.setComputerStateSource((userId) => computers.state(userId));

export const computerState = (userId: string) => computers.state(userId);

/** WebSocket endpoints: the live viewer (/api/bots/:id/screen) and, for local computers, the companion (/api/companion). */
export function attachComputerSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    if ((req.headers.origin && !allowedBrowserOrigin(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') { socket.destroy(); return; }
    const user = userFromCookieHeader(req.headers.cookie);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => {
      const close = () => client.close(4401, 'Session expired or revoked');
      const unsubscribe = onSessionRevoked(sessionHash(sessionFromCookie(req.headers.cookie) ?? ''), close);
      const timer = setInterval(() => { if (!userFromCookieHeader(req.headers.cookie)) close(); }, 15_000).unref();
      client.once('close', () => { clearInterval(timer); unsubscribe(); });
      void computers.viewer(client, user.id, bot.id, mode);
    });
  });
  if (serverProvider.kind === 'local' || serverProvider.kind === 'cloudvm') attachCompanionSocket(server);
  nativeLocal.attachCompanionSocket(server);
}
