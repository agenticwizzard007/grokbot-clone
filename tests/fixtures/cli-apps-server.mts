import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { installFakeCli } from './cli-apps-runner.mjs';
import fs from 'node:fs';
if (process.env.SWARM_TEST_REAL_CLI === '1') {
  const { mockCliProvider, modelOutputs, codeModeAction } = await import('./real-cli-provider.mjs');
  const { emailBody, emailArgs } = await import('./cli-apps-runner.mjs');
  const directory = path.join(process.env.CLI_PROFILES_DIR!, 'real-runner'); fs.mkdirSync(directory, { recursive: true });
  const fixture = await mockCliProvider(directory, (provider: string, body: any) => {
    const text = (provider === 'codex' ? body.input : body.messages).flatMap((item: any) => Array.isArray(item.content) ? item.content : typeof item.content === 'string' ? [{ text: item.content }] : []).find((part: any) => typeof part.text === 'string' && part.text.includes('\n\nConversation:\n'))?.text;
    if (!text) return { text: 'Fixture auxiliary response.' };
    const conversation = JSON.parse(text.split('\n\nConversation:\n')[1]);
    const decision = conversation.at(-1)?.type === 'function_call_output';
    if (decision && process.env.SWARM_TEST_DECISION_TOOLS !== '1') return { text: 'Nothing was sent or saved.' };
    const request = conversation.filter((item: any) => item.role === 'user').at(-1);
    if (JSON.stringify(request).includes('plain reply')) return { text: emailBody };
    const outputs = modelOutputs(provider, body);
    const requested = JSON.stringify(request);
    const internal = decision ? { name: 'read_team_job', args: { jobId: (db.prepare("SELECT id FROM agent_jobs WHERE state='completed' ORDER BY created_at DESC LIMIT 1").get() as any).id } }
      : requested.includes('fixture memory') ? { name: 'remember', args: { text: 'I prefer fixture memory checks.' } }
      : requested.includes('fixture file') ? { name: 'save_file', args: { filename: 'fixture.txt', content: 'Local fixture file.' } }
      : requested.includes('fixture task') ? { name: 'create_task', args: { title: 'Local fixture task' } } : null;
    if (internal) {
      const unpack = (value: any): any[] => {
        if (typeof value === 'string') { try { return unpack(JSON.parse(value)); } catch { return []; } }
        if (!value || typeof value !== 'object') return [];
        return [value, ...Object.values(value).flatMap(unpack)];
      };
      const found = outputs.flatMap(unpack).find((value: any) => value.name === internal.name && value.schema_hash);
      const action = !outputs.length ? { name: 'tool_describe', args: { tool_name: internal.name } }
        : found && outputs.length === 1 ? { name: 'tool_call', args: { tool_name: internal.name, schema_hash: found.schema_hash, arguments: internal.args } }
        : { text: 'Internal fixture completed.' };
      return provider === 'codex' ? codeModeAction(action) : action.name ? { ...action, name: `mcp__swarm__${action.name}` } : action;
    }
    if (outputs.length >= 2) return { text: 'Approval is waiting in the main chat.' };
    const toolkit = requested.includes('fixture app write') ? 'slack' : 'gmail';
    const name = outputs.length ? 'SWARM_APPS_EXECUTE' : 'SWARM_APPS_SEARCH';
    const action = { name: provider === 'claude' ? `mcp__swarm__${name}` : name, args: outputs.length
      ? { connectionId: `fixture-${toolkit}`, revision: 1, tool_slug: toolkit === 'slack' ? 'SLACK_SEND_MESSAGE' : 'GMAIL_CREATE_EMAIL_DRAFT', arguments: emailArgs }
      : { toolkit, query: toolkit === 'slack' ? 'send message' : 'create email draft', connectionId: `fixture-${toolkit}` } };
    return provider === 'codex' ? codeModeAction(action) : action;
  });
  process.env.SWARM_CLI_CODEX_PATH = fixture.install('codex', { codexModel: null });
  process.env.SWARM_CLI_CLAUDE_PATH = fixture.install('claude');
} else installFakeCli(path.join(process.env.CLI_PROFILES_DIR!, 'fake-runner'));
const { state } = await import('./cli-apps-backends.mjs');
await import('../../server/src/db-config.js');
const { db } = await import('../../server/src/db.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../../server/src/routes.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const { selectCli } = await import('../../server/src/cli/store.js');
const { refreshHosted } = await import('../../server/src/cli/hosted.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/fixture/cli', async c => {
  const { botId, provider } = await c.req.json();
  const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
  selectCli(bot.user_id, provider);
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, botId);
  await refreshHosted(bot.user_id);
  return c.json({ ok: true });
});
app.post('/api/fixture/connections', async c => { state.connectionScenario = (await c.req.json()).scenario; return c.json({ ok: true }); });
app.post('/api/fixture/internal', async c => {
  const { botId } = await c.req.json();
  const owner = db.prepare('SELECT user_id,model FROM bots WHERE id=?').get(botId) as any;
  const { createBot } = await import('../../server/src/bots.js');
  const { enqueue, runInBotQueue } = await import('../../server/src/agent/loop.js');
  const bot = createBot(owner.user_id, { name: 'Background fixture', isPrimary: true });
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(owner.model, bot.id);
  enqueue(bot.id, { type: 'user', text: 'Create a fixture task.' });
  await runInBotQueue(bot.id, async () => {});
  if (process.env.SWARM_TEST_DECISION_TOOLS === '1') db.prepare('UPDATE bots SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE user_id=?').run(botId, owner.user_id);
  return c.json(db.prepare('SELECT result,last_tool FROM cli_last_runs WHERE user_id=?').get(owner.user_id));
});
app.get('/api/fixture/state', c => c.json(state));
app.route('/api/cli', cliApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
