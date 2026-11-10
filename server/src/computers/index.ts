import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { db } from '../db.js';
import { env } from '../env.js';
import { userFromCookieHeader } from '../lib/auth.js';
import { attachCompanionSocket, localProvider } from './local.js';
import { orgoProvider } from './orgo.js';
import type { ComputerProvider } from './types.js';

export { ComputerError } from './types.js';
export type { BotScreen, ComputerProvider, Shot } from './types.js';

/** The active computer provider, chosen with COMPUTER_PROVIDER (see env.ts). */
export const computers: ComputerProvider = env.computerProvider === 'local' ? localProvider : orgoProvider;

export const computerState = (userId: string) => computers.state(userId);

/** WebSocket endpoints: the live viewer (/api/bots/:id/screen) and, for local computers, the companion (/api/companion). */
export function attachComputerSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => { void computers.viewer(client, user.id, bot.id, mode); });
  });
  if (computers.kind === 'local') attachCompanionSocket(server);
}
