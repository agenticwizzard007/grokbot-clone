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
    if (conversation.at(-1)?.type === 'function_call_output') return { text: 'Nothing was sent or saved.' };
    const request = conversation.filter((item: any) => item.role === 'user').at(-1);
    if (JSON.stringify(request).includes('plain reply')) return { text: emailBody };
    const outputs = modelOutputs(provider, body);
    if (outputs.length >= 2) return { text: 'Approval is waiting in the main chat.' };
    const name = outputs.length ? 'SWARM_APPS_EXECUTE' : 'SWARM_APPS_SEARCH';
    const action = { name: provider === 'claude' ? `mcp__swarm__${name}` : name, args: outputs.length
      ? { connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: emailArgs }
      : { toolkit: 'gmail', query: 'create email draft', connectionId: 'fixture-gmail' } };
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
app.get('/api/fixture/state', c => c.json(state));
app.route('/api/cli', cliApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
