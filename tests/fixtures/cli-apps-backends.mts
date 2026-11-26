import { mock } from 'node:test';
export const state = { connectionScenario: 'all', connected: true, disabled: false, unavailable: false, accountStatus: 'ACTIVE', executions: [] as any[], external: [] as string[] };
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
  if (state.connectionScenario !== 'all') {
    const base = { createdAt: '2026-11-01T00:00:00Z', data: { email: 'fixture@example.test' } };
    const gmail = { ...base, id: 'fixture-gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' };
    const slack = { ...base, id: 'fixture-slack', toolkit: { slug: 'slack' }, status: 'EXPIRED' };
    return { items: state.connectionScenario === 'zero' ? [] : state.connectionScenario === 'expired' ? [gmail, slack]
      : [gmail, { ...slack, statusReason: 'Authorization was started but not completed within 10 minutes' },
        { ...base, id: 'fixture-notion', toolkit: { slug: 'notion' }, status: 'INITIATED' },
        { ...base, id: 'fixture-whatsapp', toolkit: { slug: 'whatsapp' }, status: 'FAILED' }] };
  }
  return { items: state.connected ? toolkits.map(toolkit => ({ id: `fixture-${toolkit}`, toolkit: { slug: toolkit }, status: state.accountStatus, isDisabled: state.disabled, data: { email: 'fixture@example.test' } })) : [] };
});
mock.method(client.connectedAccounts, 'get', async (id: string) => ({ id, toolkit: { slug: id.replace('fixture-', '') }, status: 'ACTIVE', data: { email: 'fixture@example.test' } }));
mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => tools.find(tool => tool.slug === slug));
mock.method(client.tools, 'getRawComposioTools', async (query: any) => tools.filter(tool => query.toolkits.includes(tool.toolkit.slug)));
mock.method(client.tools, 'execute', async (slug: string, input: any) => { state.executions.push({ slug, input }); return { successful: true, data: { receipt: 'fake-only' } }; });
mock.method(client.toolkits, 'get', async () => ({}));
mock.method(client.tools, 'proxyExecute', async () => ({ status: 200, data: { email: 'fixture@example.test', team: 'Fixture workspace' } }));
