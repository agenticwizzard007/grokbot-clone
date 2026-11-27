import http from 'node:http';
import { once } from 'node:events';

export const goals = {
  converge: 'CONVERGE: Write release notes with a version, fewer than 60 words, and a final call to action.',
  cap: 'CAP: Review an evolving draft that still lacks a final call to action.',
};

// Read the real handoff packet, including the iteration and assigned role.
export function planIteration(body) {
  const input = body.input ?? [];
  const userIndex = input.findLastIndex(item => item.role === 'user');
  const text = JSON.stringify(input[userIndex]?.content ?? '');
  const iteration = Number(text.match(/This is iteration (\d+)/)?.[1] ?? 1);
  const checker = text.includes('Submit your verdict with submit_verdict.');
  const cap = text.includes('CAP:');
  const outputs = input.slice(userIndex + 1).filter(item => item.type === 'function_call_output');
  const draft = `Version ${iteration}.0. ${iteration === 1 ? 'Release detail. '.repeat(65) : 'Search and setup improved.'} ${iteration >= 3 && !cap ? 'Try the release.' : 'More details soon.'}`;
  const summary = checker ? `Review pass ${iteration}.` : draft;
  const verdict = {
    pass: !cap && iteration === 3,
    checklist: ['version', 'short', 'action'].map((id, index) => ({
      id, pass: index < iteration && !(cap && id === 'action'), note: `Checked ${id} on pass ${iteration}.`,
    })),
    feedback: !cap && iteration === 3 ? 'All checks passed.' : `Pass ${iteration}: fix the missing checklist items.`,
  };
  if (!outputs.length) return { name: 'submit_output', args: { summary } };
  if (checker && outputs.length === 1) return { name: 'submit_verdict', args: verdict };
  return { text: summary };
}

export async function mockIterationProvider() {
  let sequence = 0;
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const step = planIteration(body), id = `fixture-${++sequence}`;
    const item = step.name
      ? { type: 'function_call', id, call_id: `call-${id}`, name: step.name, arguments: JSON.stringify(step.args), status: 'completed' }
      : { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
    if (step.name) calls.push(item);
    const result = { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.output_item.added', { item });
    if (step.text) emit('response.output_text.delta', { delta: step.text });
    emit('response.output_item.done', { item });
    emit('response.completed', { response: result });
    response.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}/v1`, calls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
