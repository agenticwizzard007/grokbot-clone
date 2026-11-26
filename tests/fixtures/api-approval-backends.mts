import { mock } from 'node:test';
export const appExecutions: unknown[] = [];
mock.method(globalThis, 'fetch', async input => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith('/realtime/client_secrets')) return Response.json({ value: 'fixture-voice', expires_at: 9999999999 });
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  throw Error(`External network disabled: ${url.hostname}`);
});
export const { db } = await import('../../server/src/db.js');
await import('../../server/src/db-config.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { composio } = await import('../../server/src/composio.js');
const client = composio();
mock.method(client.toolkits, 'get', async () => ({}));
mock.method(client.tools, 'proxyExecute', async () => ({ status: 200, data: { login: 'fixture-account' } }));
const appTools = ['GITHUB_PEEK', 'GITHUB_CREATE_ISSUE'].map(slug => ({ slug, name: slug, description: slug, toolkit: { slug: 'github' }, version: '20261101_00', tags: [slug === 'GITHUB_PEEK' ? 'readOnlyHint' : 'createHint'], inputParameters: { type: 'object', properties: {}, additionalProperties: false } }));
appTools.push({ slug: 'GMAIL_CREATE_EMAIL_DRAFT', name: 'Create email draft', description: 'Create a draft', toolkit: { slug: 'gmail' }, version: '20261101_00', tags: ['createHint'], inputParameters: { type: 'object', properties: {}, additionalProperties: false } });
const accounts = ['github', 'gmail'].map(slug => ({ id: `fixture-${slug}`, toolkit: { slug }, status: 'ACTIVE' }));
mock.method(client.connectedAccounts, 'list', async () => ({ items: accounts }));
mock.method(client.connectedAccounts, 'get', async id => accounts.find(account => account.id === id));
mock.method(client.tools, 'getRawComposioTools', async () => appTools);
mock.method(client.tools, 'getRawComposioToolBySlug', async slug => appTools.find(t => t.slug === slug));
mock.method(client.tools, 'execute', async (...args) => { appExecutions.push(args); return { successful: true, data: { receipt: 'local only' } }; });
export const appArgs = { connectionId: 'fixture-github', revision: 1, tool_slug: 'GITHUB_PEEK', arguments: {} };
const { llmClient } = await import('../../server/src/lib/llm.js');
let sequence = 0;
export const offeredTools: any[][] = [];
export function streamTool(name?: string, args = {}) {
  const item = name ? { type: 'function_call', call_id: `fixture-${++sequence}`, name, arguments: JSON.stringify(args) }
    : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture turn finished.', annotations: [] }] };
  return (async function* () {
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
}
const plannedActions: { name: string; args: any }[] = [];
export async function planDiscoveredAction(name: string, args: any) {
  const { functionSchemas } = await import('../../server/src/agent/tools.js');
  const { toolSchemaHash } = await import('../../server/src/agent/tool-catalog.js');
  plannedActions.push({ name: 'tool_search', args: { query: name } }, { name: 'tool_describe', args: { tool_name: name } },
    { name: 'tool_call', args: { tool_name: name, schema_hash: toolSchemaHash(functionSchemas().find(t => t.name === name)!), arguments: args } });
}
export let nextAction: { name: string; args: any } | undefined;
export function planAction(name: string, args: any) { nextAction = { name, args }; }
export function mockModelClient() { return mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
  offeredTools.push(body.tools ?? []);
  if (!body.stream) return { output: [], output_text: 'Local fixture.', usage: {} };
  if (plannedActions.length) { const action = plannedActions.shift()!; return streamTool(action.name, action.args); }
  if (nextAction) { const action = nextAction; nextAction = undefined; return streamTool(action.name, action.args); }
  const last = body.input?.at(-1);
  if (last?.role === 'user') {
    const text = String(last.content);
    if (text.includes('WW draft')) return streamTool('SWARM_APPS_EXECUTE', { ...appArgs, connectionId: 'fixture-gmail', tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT' });
    if (text.includes('JJ memory:')) return streamTool('remember', { text: text.split('JJ memory:')[1].trim() });
    if (text.includes('JJ wrapped file')) {
      const { functionSchemas } = await import('../../server/src/agent/tools.js');
      const { toolSchemaHash } = await import('../../server/src/agent/tool-catalog.js');
      return streamTool('tool_call', { tool_name: 'save_file', schema_hash: toolSchemaHash(functionSchemas().find(t => t.name === 'save_file')!), arguments: { filename: 'wrapped-fixture.txt', content: 'Local wrapped file' } });
    }
    if (text.includes('JJ file')) return streamTool('save_file', { filename: 'approval-fixture.txt', content: 'Local fixture file' });
    if (text.includes('JJ app')) return streamTool('SWARM_APPS_EXECUTE', appArgs);
  }
  return streamTool();
}); }
mockModelClient();
