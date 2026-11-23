// Local-only server with model and toolkit calls held at the crash boundaries.
import fs from 'node:fs';
import { mock } from 'node:test';
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: any, init: any) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected external request: ' + url.origin + url.pathname);
});
const { llmClient } = await import('../../server/src/lib/llm.js');
const { toolMap } = await import('../../server/src/agent/tools.js');
const { initDurableJobs } = await import('../../server/src/agent/loop.js');
const record = (kind: string) => fs.appendFileSync(process.env.RECOVERY_CALLS!, `${kind}\n`);
mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
  record('model');
  const text = JSON.stringify(body.input.findLast((item: any) => item.role === 'user')?.content);
  return (async function* () {
    if (text.includes('stream-fixture')) {
      yield { type: 'response.output_text.delta', delta: 'This reply is only partially written.' };
      await new Promise(() => {});
    }
    const output = text.includes('tool-fixture')
      ? ['completed', 'uncertain', 'queued'].map(id => ({ type: 'function_call', call_id: `fixture-${id}`, name: 'list_app_connections', arguments: '{}' }))
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'New request completed.', annotations: [] }] }];
    for (const item of output) {
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: 'New request completed.' };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output } };
  })();
});
let toolCalls = 0;
mock.method(toolMap.get('list_app_connections')!, 'impl', async () => {
  record('tool');
  if (++toolCalls === 2) await new Promise(() => {});
  return { output: 'Fixture result', summary: 'Fixture completed result' };
});
// Keep all unrelated background schedulers disabled while exercising startup recovery.
await import('../../server/src/index.js');
initDurableJobs();
