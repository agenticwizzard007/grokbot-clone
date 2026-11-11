import { isTenant, tenantId } from './deployment.js';
import { startTenantTunnel } from './runtime/tunnel-client.js';
import { initRuntimeEvents } from './runtime/events.js';
import { createAccount } from './accounts.js';
import { db } from './db.js';
import { assertLegacyDatabaseFences } from './platform/legacy-database-fence.js';
import { token as newToken, sha256 } from './lib/ids.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { cliApi } from './cli/routes.js';
import { attachCliSocket } from './cli/bridge.js';
import { api } from './routes.js';
import { attachComputerSockets, computers } from './computers/index.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, initDurableJobs } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { usageApi } from './routes-usage.js';
import { modelsApi } from './routes-models.js';
import { withUsage } from './usage.js';
import { startVmMeter } from './usage-vm.js';
import { userFromCookieHeader } from './lib/auth.js';
import { loadSettings } from './settings.js';
import { defaultModel, openrouterModels } from './lib/llm.js';
import { mcpApi } from './mcp/routes.js';
import { resumeThisComputer } from './computers/this-computer.js';
import { startMemoryConsolidation } from './agent/memory.js';
import { initMessaging, inkboxWebhook, messagingApi, messagingPublic } from './messaging/index.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
loadSettings();
initSubagents();
initRooms();
assertLegacyDatabaseFences(db);
if (isTenant && !db.prepare('SELECT 1 FROM users WHERE id=?').get(tenantId)) {
  const profile = JSON.parse(fs.readFileSync('/run/swarm/profile.json', 'utf8'));
  if (profile.id !== tenantId) throw new Error('Tenant bootstrap mismatch.');
  createAccount({ preferId: tenantId, email: profile.verified_email || `${tenantId}@tenant.invalid`, name: profile.display_name });
}
if (isTenant) {
  const desktopToken = fs.readFileSync('/run/swarm/desktop-token', 'utf8').trim();
  db.prepare('INSERT OR IGNORE INTO companion_tokens(token_hash,user_id,created_at) VALUES(?,?,?)').run(sha256(desktopToken), tenantId, Date.now());
}

const app = new Hono();
app.use('/api/*', async (c, next) => {
  const start = performance.now();
  await next();
  if (c.req.path !== '/api/events') c.header('Server-Timing', `app;dur=${(performance.now() - start).toFixed(1)}`);
});
// Usage attribution: model calls made while handling a signed-in request are billed to that account.
app.use('/api/*', (c, next) => withUsage({ resolveUser: () => userFromCookieHeader(c.req.header('cookie'))?.id }, () => next()));
app.get('/api/health', (c) => c.json({ ok: true, provider: env.llmProvider, model: defaultModel(), computers: computers.kind, desktop: env.localDesktop, direct: !!env.directKey, openrouter: !!env.openrouterKey, apps: env.composioEnabled, features: { botCreation: true, botSetupVersion: 2, guidedSetup: true, messaging: true } }));
// The companion program for local computers (public: it holds no secrets; the pairing token does).
const companionScript = new URL('../../companion/swarm-companion.mjs', import.meta.url);
app.get('/api/companion/script', (c) => {
  if ((computers.kind !== 'local' && computers.kind !== 'cloudvm') || !fs.existsSync(companionScript)) return c.json({ error: 'not available' }, 404);
  return c.body(fs.readFileSync(companionScript, 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
});
const cliScript = new URL('../../companion/cli-bridge.mjs', import.meta.url);
app.get('/api/cli/script', (c) => {
  if (!fs.existsSync(cliScript)) return c.json({ error: 'CLI bridge script not installed.' }, 404);
  return c.body(fs.readFileSync(cliScript, 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
});
app.route('/api/cli', cliApi);
// Messaging (iMessage/SMS/WhatsApp via Inkbox). Public routes first: the Inkbox webhook (verified by signature), the invite
// join page and sign-in by text. They are registered before the session check.
app.route('/api/messaging/inkbox/webhook', inkboxWebhook);
app.route('/api', messagingPublic);
app.route('/api/messaging', messagingApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);
app.route('/api/usage', usageApi);
app.route('/api', modelsApi);
app.route('/api/mcp/servers', mcpApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/assets/*', async (c, next) => {
    await next();
    // Only Vite's fingerprinted bundles are immutable (not icons with stable names).
    const type = c.res.headers.get('Content-Type') ?? '';
    if (c.res.status === 200 && /javascript|text\/css/.test(type) && /-[\w-]{8,}\.(js|css)$/.test(c.req.path)) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port, ...(isTenant ? { hostname: '0.0.0.0' } : {}) }, (info) => console.log(`[swarm] server on http://localhost:${info.port} (models: ${env.llmProvider} ${defaultModel()}, computers: ${computers.kind})`));
attachComputerSockets(server as unknown as Server);
attachCliSocket(server as unknown as Server);
// Warm optional model metadata without delaying the HTTP listener.
if (env.llmProvider === 'openrouter') void openrouterModels().catch(() => {});
// SWARM_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.SWARM_NO_SCHEDULER !== '1') {
  initDurableJobs();
  initRoutines(enqueue);
  void initTriggers(enqueue);
  initProactive(enqueue);
} else console.log('[swarm] scheduler disabled (SWARM_NO_SCHEDULER=1)');
// Extra servers sharing a database don't process the messaging inbox, so events aren't handled twice.
initMessaging({ process: process.env.SWARM_NO_SCHEDULER !== '1' });
computers.start?.();
startVmMeter();
if (computers.kind === 'local') resumeThisComputer();
startMemoryConsolidation();

if (isTenant) { await startTenantTunnel(env.port); initRuntimeEvents(); }
