// Local HTTP only. No credentials and no calls to real providers.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
export function creditsProvider() {
  const runs = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') return res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [
      { id: 'openai/gpt-4.1', supported_parameters: ['tools'], top_provider: { max_completion_tokens: 4096 } },
    ] } : runs));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = JSON.stringify(body.input.findLast(item => item.role === 'user')?.content);
    const attempt = runs.filter(run => run.prompt === prompt).length + 1;
    const run = { prompt, attempt, cap: body.max_output_tokens, closed: false }; runs.push(run);
    res.on('close', () => { run.closed = true; });
    const fail = message => { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 402, message } })); };
    if (req.url.endsWith('/responses/compact')) {
      if (/stop-compact/.test(prompt)) return;
      if (/compact-credit/.test(prompt)) return fail('can only afford 2000');
      res.writeHead(404); return res.end('Summary required');
    }
    if (/exhausted/.test(prompt)) return fail('This request would exceed your available credits given your current in-flight requests.');
    if (attempt === 1 && !/compact-credit-recover/.test(prompt)) return fail('This request requires more credits. You can only afford 2000 tokens.');
    if (/stop-retry/.test(prompt)) return; // hold the actual HTTP request until Stop
    if (/tool-loop/.test(prompt) && !body.input.some(item => item.type === 'function_call_output')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'credits-tool', name: 'list_app_connections', arguments: '{}' }] } })}\n\n`);
    }
    const text = 'Normal reply after credit recovery.';
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ output: [item], output_text: text })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.output_text.delta', delta: text });
    event({ type: 'response.output_item.done', item });
    event({ type: 'response.completed', response: { output: [item] } }); res.end();
  });
  return { server, runs };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) creditsProvider().server.listen(Number(process.argv[2]), '127.0.0.1');
