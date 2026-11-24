// Local-only fake Responses API. The first request stays open until cancelled.
import http from 'node:http';
const runs = [];
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [] } : runs)); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.input.findLast(item => item.role === 'user');
  const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  const bees = /bees/i.test(prompt);
  const run = { prompt, bees, closed: false, completed: false, startedAt: Date.now() }; runs.push(run);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const finish = text => {
    const item = message(text);
    event({ type: 'response.output_text.delta', delta: text });
    event({ type: 'response.output_item.done', item });
    event({ type: 'response.completed', response: { output: [item] } });
    run.completed = true; res.end();
  };
  event({ type: 'response.output_item.added', item: message('') });
  if (!bees) {
    const closed = body.input.some(item => typeof item.content === 'string' && item.content.includes('This request was cancelled.'));
    finish(closed ? 'Tea is a warm drink made from leaves.' : 'THE STOPPED BEES ESSAY Tea is a warm drink made from leaves.');
    return;
  }
  // Setup turns expose partial text; active turns validate the full response first.
  event({ type: 'response.output_text.delta', delta: 'Bees have a long history.' });
  const timer = setTimeout(() => finish('THE STOPPED BEES ESSAY'), 30_000);
  res.on('close', () => { clearTimeout(timer); run.closed = true; });
});
server.listen(Number(process.argv[2]), '127.0.0.1');
