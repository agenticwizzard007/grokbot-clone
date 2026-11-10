import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { api } from './routes.js';
import { attachComputerSockets, computers } from './computers/index.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { usageApi } from './routes-usage.js';
import { withUsage } from './usage.js';
import { userFromCookieHeader } from './lib/auth.js';
import { loadSettings } from './settings.js';
import { defaultModel } from './lib/llm.js';
import { mcpApi } from './mcp/routes.js';
import { resumeThisComputer } from './computers/this-computer.js';
import { startMemoryConsolidation } from './agent/memory.js';
import { initMessaging, inkboxWebhook, messagingApi, messagingPublic } from './messaging/index.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
loadSettings();
initSubagents();
initRooms();

const app = new Hono();
// Usage attribution: model calls made while handling a signed-in request are billed to that account.
app.use('/api/*', (c, next) => withUsage({ resolveUser: () => userFromCookieHeader(c.req.header('cookie'))?.id }, () => next()));
app.get('/api/health', (c) => c.json({ ok: true, provider: env.llmProvider, model: defaultModel(), computers: computers.kind, desktop: env.localDesktop, direct: !!env.directKey, openrouter: !!env.openrouterKey, apps: env.composioEnabled, features: { botCreation: true, botSetupVersion: 2, guidedSetup: true, messaging: true } }));
// The companion program for local computers (public: it holds no secrets; the pairing token does).
const companionScript = new URL('../../companion/swarm-companion.mjs', import.meta.url);
app.get('/api/companion/script', (c) => {
  if ((computers.kind !== 'local' && computers.kind !== 'cloudvm') || !fs.existsSync(companionScript)) return c.json({ error: 'not available' }, 404);
  return c.body(fs.readFileSync(companionScript, 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
});
// Messaging (iMessage/SMS via Inkbox). Public routes first: the Inkbox webhook (verified by signature), the invite
// join page and sign-in by text. They are registered before the session check.
app.route('/api/messaging/inkbox/webhook', inkboxWebhook);
app.route('/api', messagingPublic);
app.route('/api/messaging', messagingApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);
app.route('/api/usage', usageApi);
app.route('/api/mcp/servers', mcpApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[swarm] server on http://localhost:${info.port} (models: ${env.llmProvider} ${defaultModel()}, computers: ${computers.kind})`));
attachComputerSockets(server as unknown as Server);
// SWARM_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.SWARM_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
  initProactive(enqueue);
} else console.log('[swarm] scheduler disabled (SWARM_NO_SCHEDULER=1)');
// Extra servers sharing a database don't process the messaging inbox, so events aren't handled twice.
initMessaging({ process: process.env.SWARM_NO_SCHEDULER !== '1' });
computers.start?.();
if (computers.kind === 'local') resumeThisComputer();
startMemoryConsolidation();
