import { Hono } from 'hono';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { env } from '../env.js';
import { getLive } from '../store.js';
import { db } from '../db.js';
import { hub } from '../lib/hub.js';
import { localAccess, setLocalAccess } from './local-access.js';
import { nativeLocal } from './local.js';
import { closeComputerViewers, computers } from './index.js';

export function localComputerStatus(userId: string) {
  const state = nativeLocal.localProvider.state(userId);
  return {
    enabled: localAccess(userId).enabled,
    paired: nativeLocal.pairingInfo(userId).paired,
    connected: nativeLocal.companionConnected(userId),
    device: state.device ?? null,
    desktop: true,
    browser: nativeLocal.browserAvailable(userId),
  };
}

export const localComputerApi = new Hono<AuthVars>();
localComputerApi.use('*', requireUser);
localComputerApi.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  // Native requests have no Origin. Web requests must be same-origin.
  const origin = c.req.header('origin');
  if (origin && ![env.serverUrl, env.appUrl].some(url => new URL(url).origin === origin)) return c.json({ error: 'Origin not allowed.' }, 403);
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Cross-site request not allowed.' }, 403);
  await next();
});

localComputerApi.get('/', (c) => c.json(localComputerStatus(c.get('user').id)));
localComputerApi.post('/pair', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.desktop !== true) return c.json({ error: 'Explicit approval to control this Mac is required.' }, 400);
  const userId = c.get('user').id;
  const bots = db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[];
  if (bots.some((b) => getLive(b.id).isRunning)) return c.json({ error: 'Stop your running tasks before selecting or pairing a computer.' }, 409);
  closeComputerViewers(userId);
  nativeLocal.revokePairings(userId);
  setLocalAccess(userId, true);
  const token = nativeLocal.createPairing(userId);
  hub.emit(userId, { type: 'computer', state: computers.state(userId) });
  return c.json({ token, server: new URL(env.serverUrl).origin });
});

localComputerApi.delete('/', (c) => {
  const userId = c.get('user').id;
  // Revocation is always available, even while a task is running.
  closeComputerViewers(userId);
  setLocalAccess(userId, false);
  const revoked = nativeLocal.revokePairings(userId);
  hub.emit(userId, { type: 'computer', state: computers.state(userId) });
  return c.json({ ok: true, revoked });
});
