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
import { loadSettings } from './settings.js';
import { resumeThisComputer } from './computers/this-computer.js';
import { startMemoryConsolidation } from './agent/memory.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
loadSettings();
initSubagents();
initRooms();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, model: env.xaiModel, computers: computers.kind, xai: !!env.xaiKey, apps: env.composioEnabled }));
// The companion program for local computers (public: it holds no secrets; the pairing token does).
const companionScript = new URL('../../companion/grokbot-companion.mjs', import.meta.url);
app.get('/api/companion/script', (c) => {
  if (computers.kind !== 'local' || !fs.existsSync(companionScript)) return c.json({ error: 'not available' }, 404);
  return c.body(fs.readFileSync(companionScript, 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
});
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[grokbot] server on http://localhost:${info.port} (model ${env.xaiModel}, computers: ${computers.kind})`));
attachComputerSockets(server as unknown as Server);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
computers.start?.();
if (computers.kind === 'local') resumeThisComputer();
startMemoryConsolidation();
