import { Hono } from 'hono';
import { env } from '../env.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { cliStatus, disconnectCli, refreshCli } from './bridge.js';
import { cliRuntime, createCliPairing, isCliProvider, revokeCliPairing, selectCli } from './store.js';
import { deleteHostedProfile, hostedStatus, serverLoginAvailable, stopHostedJobs } from './hosted.js';
import { cancelLoginSession, cancelUserLogins, CliLoginError, readLoginSession, resizeLoginSession, startLoginSession, writeLoginSession } from './login.js';
import { withCliMutation } from './lock.js';

export const cliApi = new Hono<AuthVars>();
cliApi.use('*', requireUser);
cliApi.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
cliApi.get('/', (c) => c.json(cliStatus(c.get('user').id)));
cliApi.onError((error, c) => {
  if (error instanceof CliLoginError) return c.json({ error: error.message }, error.status);
  return c.json({ error: 'The CLI connection could not complete this request. Please try again.' }, 500);
});

const terminalSize = (body: any) => Number.isInteger(body?.cols) && body.cols >= 20 && body.cols <= 300 && Number.isInteger(body?.rows) && body.rows >= 5 && body.rows <= 120;
cliApi.post('/login', async (c) => {
  if (!serverLoginAvailable()) return c.json({ error: 'Server CLI login requires an enabled Linux host. Ask the server owner to enable it, or use the computer bridge under Advanced.' }, 503);
  const body = await c.req.json().catch(() => null);
  if (!body || !isCliProvider(body.provider) || !terminalSize(body)) return c.json({ error: 'Choose Claude or Codex and a valid terminal size.' }, 400);
  const userId = c.get('user').id;
  return withCliMutation(userId, async () => {
    const session = await startLoginSession(userId, body.provider, body.cols, body.rows);
    disconnectCli(userId);
    revokeCliPairing(userId);
    return c.json(session);
  });
});
cliApi.get('/login/:id', (c) => {
  const cursor = Number(c.req.query('cursor') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return c.json({ error: 'Invalid terminal cursor.' }, 400);
  return c.json(readLoginSession(c.get('user').id, c.req.param('id'), cursor));
});
cliApi.post('/login/:id/input', async (c) => {
  const body = await c.req.json().catch(() => null);
  writeLoginSession(c.get('user').id, c.req.param('id'), body?.data);
  return c.json({ ok: true });
});
cliApi.post('/login/:id/resize', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!terminalSize(body)) return c.json({ error: 'Invalid terminal size.' }, 400);
  resizeLoginSession(c.get('user').id, c.req.param('id'), body.cols, body.rows);
  return c.json({ ok: true });
});
cliApi.delete('/login/:id', async (c) => {
  await cancelLoginSession(c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});
cliApi.post('/refresh', async (c) => {
  try { return c.json(await refreshCli(c.get('user').id)); }
  catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
cliApi.put('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || (body.provider !== null && !isCliProvider(body.provider))) return c.json({ error: 'Choose codex, claude, or null for API mode.' }, 400);
  const userId = c.get('user').id;
  return withCliMutation(userId, async () => {
    await cancelUserLogins(userId);
    if (body.provider) {
      try {
        if (cliRuntime(userId) === 'server' && !hostedStatus(userId).connected) return c.json({ error: 'Log in using the embedded terminal, or refresh your saved CLI connection first.' }, 409);
        const status = await refreshCli(userId);
        const auth = status.providers[body.provider as 'codex' | 'claude'];
        if (!status.connected || !auth.installed || !auth.authenticated || !auth.subscription || auth.error) return c.json({ error: 'Sign in with your subscription account first, then refresh the CLI connection.' }, 409);
      } catch (e) { return c.json({ error: (e as Error).message }, 502); }
    }
    selectCli(userId, body.provider);
    return c.json(cliStatus(userId));
  });
});

// Quote shell arguments, including a configured public URL. Never interpolate them as shell code.
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
cliApi.post('/pair', async (c) => {
  const userId = c.get('user').id;
  return withCliMutation(userId, async () => {
    await cancelUserLogins(userId);
    stopHostedJobs(userId);
    disconnectCli(userId);
    const secret = createCliPairing(userId);
    const server = env.serverUrl.replace(/\/+$/, '');
    return c.json({ command: `curl -fsSL ${quote(`${server}/api/cli/script`)} -o swarm-cli-bridge.mjs && node swarm-cli-bridge.mjs --server ${quote(server)} --token ${quote(secret)}` });
  });
});
cliApi.delete('/pair', async (c) => {
  const userId = c.get('user').id;
  return withCliMutation(userId, async () => {
    await cancelUserLogins(userId);
    if (cliRuntime(userId) === 'server') await deleteHostedProfile(userId);
    revokeCliPairing(userId);
    disconnectCli(userId);
    // Retain subscription selection: an offline bridge must never enable API billing.
    return c.json(cliStatus(userId));
  });
});
