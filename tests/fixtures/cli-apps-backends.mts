import { mock } from 'node:test';
export const state = { connected: true, unavailable: false, executions: [] as any[], external: [] as string[] };
const toolkits = ['gmail', 'slack', 'googlecalendar'];
mock.method(globalThis, 'fetch', async (input: any) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.pathname.endsWith('/realtime/client_secrets')) return Response.json({ value: 'local-voice-fixture', expires_at: 9999999999 });
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname === '/api/v3.1/toolkits') return Response.json({ items: toolkits.map(slug => ({ slug, name: slug === 'gmail' ? 'Gmail' : slug === 'slack' ? 'Slack' : 'Google Calendar', meta: { categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] })), next_cursor: null });
  state.external.push(url.origin + url.pathname);
  throw Error('External requests disabled in CLI app fixture');
});
const { composio } = await import('../../server/src/composio.js');
const client = composio();
const tools = [
  ['gmail', 'GMAIL_CREATE_EMAIL_DRAFT'], ['gmail', 'GMAIL_SEND_EMAIL'],
  ['slack', 'SLACK_SEND_MESSAGE'], ['googlecalendar', 'GOOGLECALENDAR_CREATE_EVENT'],
].map(([toolkit, slug]) => ({ slug, name: slug, description: slug, toolkit: { slug: toolkit }, version: '20261101_00', tags: ['createHint'], inputParameters: { type: 'object', additionalProperties: true } }));
mock.method(client.connectedAccounts, 'list', async () => {
  if (state.unavailable) throw Error('Fixture provider unavailable');
  return { items: state.connected ? toolkits.map(toolkit => ({ id: `fixture-${toolkit}`, toolkit: { slug: toolkit }, status: 'ACTIVE', data: { email: 'fixture@example.test' } })) : [] };
});
mock.method(client.connectedAccounts, 'get', async (id: string) => ({ id, toolkit: { slug: id.replace('fixture-', '') }, status: 'ACTIVE', data: { email: 'fixture@example.test' } }));
mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => tools.find(tool => tool.slug === slug));
mock.method(client.tools, 'getRawComposioTools', async (query: any) => tools.filter(tool => query.toolkits.includes(tool.toolkit.slug)));
mock.method(client.tools, 'execute', async (slug: string, input: any) => { state.executions.push({ slug, input }); return { successful: true, data: { receipt: 'fake-only' } }; });
mock.method(client.toolkits, 'get', async () => ({}));
mock.method(client.tools, 'proxyExecute', async () => ({ status: 200, data: { email: 'fixture@example.test', team: 'Fixture workspace' } }));
