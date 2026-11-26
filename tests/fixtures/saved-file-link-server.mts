import { Hono } from 'hono';
import { serve } from '@hono/node-server';
await import('./api-approval-backends.mjs');
const { db } = await import('../../server/src/db.js');
const { api } = await import('../../server/src/routes.js');
const { configApi } = await import('../../server/src/routes-config.js');
const { deliverablesApi } = await import('../../server/src/routes-deliverables.js');
const { toolMap } = await import('../../server/src/agent/tools.js');
const { appendRow } = await import('../../server/src/store.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/fixture/file', async c => {
  const { botId, absolute } = await c.req.json();
  const { user_id: userId } = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any;
  const result = await toolMap.get('save_file')!.impl({ filename: 'library-fixture.md', content: '# Saved fixture report' }, { userId, botId, depth: 0, enqueueBotMessage() {} });
  // Older transcripts may contain an origin-qualified version of the same link.
  const output = absolute ? String(result.output).replace(/\]\((#[^)]+)\)/, `](${process.env.APP_URL}/$1)`) : String(result.output);
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text: output + '\n\n[Fixture reference](https://example.test/reference)' });
  return c.json({ output });
});
app.route('/api/deliverables', deliverablesApi); app.route('/api', configApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
