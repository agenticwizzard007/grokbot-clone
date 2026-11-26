import { Hono } from 'hono';
import { serve } from '@hono/node-server';
const { db, appExecutions, planAction } = await import('./api-approval-backends.mjs');
const { api } = await import('../../server/src/routes.js');
const { preferencesApi } = await import('../../server/src/routes-preferences.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const { selectCli } = await import('../../server/src/cli/store.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/fixture/cli', async c => {
  const { botId, provider } = await c.req.json();
  const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any;
  selectCli(bot.user_id, provider); return c.json({ ok: true });
});
app.post('/api/fixture/helper', async c => {
  const { botId } = await c.req.json();
  const { createSubagent } = await import('../../server/src/agent/subagents.js');
  const { enqueue } = await import('../../server/src/agent/loop.js');
  const helper = createSubagent(botId, 'Inspect local fixture memory', 'Fixture helper');
  planAction('recall', { query: 'fixture' }); enqueue(helper.id, { type: 'user', text: 'Inspect fixture memory' });
  return c.json({ ok: true });
});
app.get('/api/fixture/state', c => c.json({ executions: appExecutions.length,
  files: (db.prepare('SELECT count(*) n FROM output_artifacts').get() as any).n,
  memories: (db.prepare('SELECT count(*) n FROM memories').get() as any).n,
  pending: (db.prepare("SELECT count(*) n FROM approvals WHERE status='pending'").get() as any).n }));
app.route('/api/account', preferencesApi); app.route('/api/cli', cliApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
