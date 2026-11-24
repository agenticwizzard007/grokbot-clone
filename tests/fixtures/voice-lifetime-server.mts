// Temporary local accounts only. No vendor traffic or real credentials.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mock } from 'node:test';
mock.method(globalThis, 'fetch', async (url: any) => {
  if (String(url).endsWith('/realtime/client_secrets')) return Response.json({ value: 'provider-secret-fixture', expires_at: 9999999999 });
  throw Error('External requests are disabled in this fixture');
});
await import('../../server/src/db-config.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../../server/src/routes.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true }));
app.route('/api/cli', cliApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
