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
mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'fixture-github', toolkit: { slug: 'github' }, status: 'ACTIVE' }] }));
mock.method(client.connectedAccounts, 'get', async () => ({ id: 'fixture-github', toolkit: { slug: 'github' }, status: 'ACTIVE' }));
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
export let nextAction: { name: string; args: any } | undefined;
export function planAction(name: string, args: any) { nextAction = { name, args }; }
mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
  offeredTools.push(body.tools ?? []);
  if (!body.stream) return { output: [], output_text: 'Local fixture.', usage: {} };
  if (nextAction) { const action = nextAction; nextAction = undefined; return streamTool(action.name, action.args); }
  const last = body.input?.at(-1);
  if (last?.role === 'user') {
    const text = String(last.content);
    if (text.includes('JJ memory:')) return streamTool('remember', { text: text.split('JJ memory:')[1].trim() });
    if (text.includes('JJ file')) return streamTool('save_file', { filename: 'approval-fixture.txt', content: 'Local fixture file' });
    if (text.includes('JJ app')) return streamTool('SWARM_APPS_EXECUTE', appArgs);
  }
  return streamTool();
});
