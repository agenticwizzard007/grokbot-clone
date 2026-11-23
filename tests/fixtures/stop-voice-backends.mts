// Local fixtures only. Block all vendor traffic and fake Composio at its SDK boundary.
import { mock } from 'node:test';
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: any, init: any) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  throw new Error('Unexpected external backend request');
});
const { composio } = await import('../../server/src/composio.js');
const client = composio();
export const executions: string[] = [];
mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'fixture-gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] }));
const tool = { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', toolkit: { slug: 'gmail' }, version: '20260101_00', tags: ['readOnlyHint'], inputParameters: { type: 'object', properties: { scenario: { type: 'string' } } } };
mock.method(client.tools, 'getRawComposioToolBySlug', async () => tool);
mock.method(client.tools, 'getRawComposioTools', async () => [tool]);
mock.method(client.tools, 'execute', async (_slug: string, body: any, options: any) => {
  const scenario = body.arguments.scenario;
  executions.push(scenario);
  if (!options?.signal || options.maxRetries !== 0) throw new Error('Execution must be bounded and must not replay');
  await new Promise(resolve => setTimeout(resolve, 700));
  if (scenario === 'failed') return { successful: false, error: 'private fixture provider detail' };
  if (scenario === 'expired') throw Object.assign(new Error('private fixture provider detail'), { status: 401 });
  if (scenario === 'gateway-timeout') throw Object.assign(new Error('private fixture provider detail'), { status: 504 });
  if (scenario === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError');
  return { successful: true, data: { result: 'Local fixture read completed.' } };
});
