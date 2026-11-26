import { Hono } from 'hono';
import { serve } from '@hono/node-server';
const { db } = await import('./api-approval-backends.mjs');
const { api } = await import('../../server/src/routes.js');
const { configApi } = await import('../../server/src/routes-config.js');
const { knowledgeApi } = await import('../../server/src/routes-knowledge.js');
const { learningApi } = await import('../../server/src/routes-learning.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const { selectCli } = await import('../../server/src/cli/store.js');
const { toolMap } = await import('../../server/src/agent/tools.js');
const { appendRow } = await import('../../server/src/store.js');
const { acceptJob } = await import('../../server/src/agent/jobs.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true }));
// This endpoint exists only in the local UI fixture. It uses the same skill tool
// and durable user job as the separately tested official hosted CLI path.
app.post('/api/fixture/skill', async c => {
  const { botId, provider, name, skillId, revision } = await c.req.json();
  const { user_id: userId } = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any;
  selectCli(userId, provider);
  const source = appendRow(botId, 'message', { type: 'message', role: 'user', text: `Save the ${name} skill to verify and cite original sources.` });
  const job = acceptJob(botId, { type: 'user', text: 'Save this skill.' });
  const ctx = { userId, botId, jobId: job.id, depth: 0, enqueueBotMessage() {} };
  if (skillId) await toolMap.get('read_skill')!.impl({ skill_id: skillId }, ctx);
  const result = await toolMap.get('propose_skill')!.impl({ expected_revision: revision ?? 0, skill_id: skillId, name, description: 'Verify and cite sources', body: '1. Read original sources.\n2. Cite the source for each claim.', reason: 'Requested in chat.', evidence: [{ botId, generation: source.generation, seq: source.seq }] }, ctx);
  return c.json(JSON.parse(String(result.output)));
});
app.route('/api/learning', learningApi); app.route('/api/cli', cliApi); app.route('/api', configApi); app.route('/api', knowledgeApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
