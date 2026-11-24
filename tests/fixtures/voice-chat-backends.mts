// Local-only fake providers. Every external request is intercepted or rejected.
import { mock } from 'node:test';
export const emailArgs = {
  recipient_email: ['Review team <review@example.test>', `${'long-address-'.repeat(8)}@example.test`],
  cc: ['copy@example.test'], bcc: ['private@example.test'], subject: 'Release review ✓',
  body: `Hello review team,\n\nPlease review the release notes.\n${'Full content with Unicode 🌍 and a long URL https://example.test/'.repeat(16)}\n\nFinal paragraph.`,
  include_signature: true, thread_id: 'fixture-thread', thread_subject: 'Release planning', timezone: 'Europe/Paris', is_html: false,
};
export const executionArgs = { connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: emailArgs };
export const executions: unknown[] = [];
let serial = 0;
mock.method(globalThis, 'fetch', async (input: any, init: any) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.pathname.endsWith('/realtime/client_secrets')) return Response.json({ value: 'local-voice-fixture', expires_at: 9999999999 });
  if (url.pathname.endsWith('/responses') && url.hostname === 'model.fixture') {
    const body = JSON.parse(init.body);
    if (!body.stream) return Response.json({ id: 'summary', output: [], output_text: '', usage: {} });
    const last = body.input?.at(-1);
    const prompt = JSON.stringify(last);
    const id = `fixture-${++serial}`;
    const connect = /connect Slack/i.test(prompt);
    const action = last?.type !== 'function_call_output' && (/prepare.*email/i.test(prompt) || connect);
    const text = 'Request finished in chat. No real provider was contacted.';
    const item = action
      ? { type: 'function_call', id, call_id: id, name: connect ? 'request_app_connection' : 'SWARM_APPS_EXECUTE', arguments: JSON.stringify(connect ? { toolkit: 'slack', reason: 'Connect Slack for the requested work.' } : executionArgs) }
      : { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response([{ type: 'response.output_item.added', item }, ...(!action ? [{ type: 'response.output_text.delta', delta: text }] : []), { type: 'response.output_item.done', item }, { type: 'response.completed', response }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [{ slug: 'slack', name: 'Slack', meta: { categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] }], next_cursor: null });
  throw Error(`External requests disabled in fixture: ${url.origin}${url.pathname}`);
});
const { composio } = await import('../../server/src/composio.js');
const client = composio();
const tool = { slug: executionArgs.tool_slug, name: 'Create email draft', toolkit: { slug: 'gmail' }, version: '20261101_00', tags: ['createHint'], inputParameters: { type: 'object', additionalProperties: true } };
mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'fixture-gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] }));
mock.method(client.tools, 'getRawComposioToolBySlug', async () => tool);
mock.method(client.tools, 'getRawComposioTools', async () => [tool]);
mock.method(client.tools, 'execute', async (_slug, input) => { executions.push(input); return { successful: true, data: { result: 'Fake draft only' } }; });
