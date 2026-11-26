// Official hosted CLIs, local model responses, isolated accounts and files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mockCliProvider, modelOutputs, codeModeAction, officialExecutable } from './real-cli-provider.mjs';

const directory = path.join(process.env.CLI_PROFILES_DIR!, 'real-runner');
fs.mkdirSync(directory, { recursive: true });
const replies = new Map<string, () => void>();
const released = new Set<string>();
const fixture = await mockCliProvider(directory, async (provider: string, body: any) => {
  const text = (provider === 'codex' ? body.input : body.messages).flatMap((item: any) => Array.isArray(item.content) ? item.content : typeof item.content === 'string' ? [{ text: item.content }] : [])
    .find((part: any) => typeof part.text === 'string' && part.text.includes('\n\nConversation:\n'))?.text;
  if (!text) return { text: 'Fixture auxiliary response.' };
  const conversation = JSON.parse(text.split('\n\nConversation:\n')[1]);
  const request = JSON.stringify(conversation.filter((item: any) => item.role === 'user').at(-1));
  const repeated = request.includes('repeat link');
  const filename = repeated ? 'repeated-fixture.txt' : 'saved-fixture.txt';
  const outputs = modelOutputs(provider, body);
  const unpack = (value: any): any[] => {
    if (typeof value === 'string') { try { return unpack(JSON.parse(value)); } catch { return [value]; } }
    if (!value || typeof value !== 'object') return [];
    return [value, ...Object.values(value).flatMap(unpack)];
  };
  const found = outputs.flatMap(unpack);
  const described = found.find((value: any) => value.name === 'save_file' && value.schema_hash);
  const saved = found.find((value: any) => typeof value === 'string' && value.startsWith(`Saved ${filename} to Files.`));
  if (saved) {
    // Let Playwright verify the app confirmation before the assistant has replied.
    if (!released.has(`${provider}:${filename}`)) await new Promise<void>(resolve => replies.set(`${provider}:${filename}`, resolve));
    return { text: repeated ? saved : `Saved ${filename} to Files.` };
  }
  const action = described ? { name: 'tool_call', args: { tool_name: 'save_file', schema_hash: described.schema_hash, arguments: { filename, content: 'Local saved file fixture.' } } }
    : { name: 'tool_describe', args: { tool_name: 'save_file' } };
  return provider === 'codex' ? codeModeAction(action) : { ...action, name: `mcp__swarm__${action.name}` };
});
process.env.SWARM_CLI_CODEX_PATH = fixture.install('codex', { codexModel: null });
process.env.SWARM_CLI_CLAUDE_PATH = fixture.install('claude');
const versions = Object.fromEntries(['codex', 'claude'].map(provider => [provider, execFileSync(officialExecutable(provider), ['--version'], { encoding: 'utf8' }).trim()]));

const { state } = await import('./cli-apps-backends.mjs');
await import('../../server/src/db-config.js');
const { db } = await import('../../server/src/db.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../../server/src/routes.js');
const { configApi } = await import('../../server/src/routes-config.js');
const { deliverablesApi } = await import('../../server/src/routes-deliverables.js');
const { coordinationApi } = await import('../../server/src/routes-coordination.js');
const { usageApi } = await import('../../server/src/routes-usage.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const { selectCli } = await import('../../server/src/cli/store.js');
const { refreshHosted } = await import('../../server/src/cli/hosted.js');
const { runInBotQueue } = await import('../../server/src/agent/loop.js');
const { listRows } = await import('../../server/src/store.js');
const { securityHeaders, withHeadSupport } = await import('../../server/src/security/request.js');
const app = new Hono(); app.use('*', securityHeaders);
app.get('/api/health', c => c.json({ ok: true, versions }));
app.post('/api/fixture/cli', async c => {
  const { botId, provider } = await c.req.json();
  released.delete(`${provider}:saved-fixture.txt`); released.delete(`${provider}:repeated-fixture.txt`);
  const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
  selectCli(bot.user_id, provider);
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, botId);
  await refreshHosted(bot.user_id);
  return c.json({ ok: true });
});
app.post('/api/fixture/reply', async c => {
  const { botId, provider, filename } = await c.req.json();
  for (let n = 0; n < 300 && !replies.has(`${provider}:${filename}`); n++) await new Promise(resolve => setTimeout(resolve, 100));
  const release = replies.get(`${provider}:${filename}`);
  assert.ok(release, 'The real CLI consumed the saved tool output');
  replies.delete(`${provider}:${filename}`); released.add(`${provider}:${filename}`); release();
  await runInBotQueue(botId, async () => {});
  assert.deepEqual(fixture.errors, []); assert.deepEqual(state.external, []);
  return c.json({ rows: listRows(botId), versions, args: fixture.args(provider), events: fixture.events(provider) });
});
app.route('/api/cli', cliApi); app.route('/api/deliverables', deliverablesApi); app.route('/api/team', coordinationApi); app.route('/api/usage', usageApi); app.route('/api', configApi); app.route('/api', api);
serve({ fetch: withHeadSupport(app.fetch), port: Number(process.env.PORT), hostname: '127.0.0.1' });
