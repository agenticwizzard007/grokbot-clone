// A stand-in for the xAI and OpenRouter Responses APIs, for testing Grokbot without real keys.
// Usage: node tests/mock-xai.mjs [port]   (default 8790), then start the server with
//   XAI_BASE_URL=http://localhost:8790/v1  and/or  OPENROUTER_BASE_URL=http://localhost:8790/api/v1
// GET /_requests returns the last requests the model endpoints received (for tests).
//
// The "model" follows a script written in the chat message:
//   mock: open_browser {"url":"https://example.com"} | computer_screenshot {} | say Opened it
// Each step is a tool call (`name {json args}`) or a final reply (`say text`); one step per turn
// of the agent loop. Without a "mock:" script, a message containing a URL opens it and reports
// back; anything else gets a short canned reply.
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8790);
const recent = [];
const OPENROUTER_MODELS = [
  { id: 'x-ai/grok-4.7', name: 'xAI: Grok 4.7', vision: true, reasoning: true, prompt: '0.000003', completion: '0.000015' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', vision: true, reasoning: true, prompt: '0.000003', completion: '0.000015' },
  { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', vision: true, reasoning: false, prompt: '0.0000003', completion: '0.0000025' },
  { id: 'deepseek/deepseek-v4', name: 'DeepSeek: V4', vision: false, reasoning: true, prompt: '0.0000005', completion: '0.000002' },
].map((m) => ({
  id: m.id, name: m.name, context_length: 200000,
  architecture: { input_modalities: m.vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'tool_choice', ...(m.reasoning ? ['reasoning'] : [])],
  pricing: { prompt: m.prompt, completion: m.completion },
}));
let n = 0;
const id = (p) => `${p}_mock${++n}`;

function parseScript(text) {
  const m = text.match(/mock:\s*([\s\S]+)$/i);
  if (!m) return null;
  return m[1].split(/\s+\|\s+/).map((step) => {
    const s = step.trim();
    if (/^say\b/i.test(s)) return { say: s.replace(/^say\s*/i, '') };
    const mm = s.match(/^([a-zA-Z_][\w]*)\s*(\{[\s\S]*\})?\s*$/);
    if (!mm) return { say: `(mock) could not parse step: ${s}` };
    let args = {};
    try { args = mm[2] ? JSON.parse(mm[2]) : {}; } catch { return { say: `(mock) bad JSON in step: ${s}` }; }
    return { tool: mm[1], args };
  });
}

function plan(input) {
  const items = Array.isArray(input) ? input : [];
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === 'user') { lastUser = i; break; }
  }
  const userText = lastUser >= 0 ? (typeof items[lastUser].content === 'string' ? items[lastUser].content : JSON.stringify(items[lastUser].content)) : '';
  const after = items.slice(lastUser + 1);
  const outputs = after.filter((it) => it.type === 'function_call_output');
  const step = outputs.length;
  const lastOutput = outputs.at(-1);
  const lastText = typeof lastOutput?.output === 'string' ? lastOutput.output : (lastOutput?.output ?? []).filter((o) => o.type === 'input_text').map((o) => o.text).join(' ');

  let steps = parseScript(userText);
  if (!steps) {
    const url = userText.match(/https?:\/\/[^\s)"']+/)?.[0];
    steps = url
      ? [{ tool: 'open_browser', args: { url } }, { say: `(mock model) I opened ${url} in my browser. ${lastText ? `Tool said: ${lastText.slice(0, 200)}` : ''}` }]
      : [{ say: `(mock model) Got it: "${userText.slice(0, 160)}". Include a URL and I'll open it, or send a "mock:" script.` }];
  }
  const s = steps[step];
  if (!s) return { say: `(mock model) Done. Last tool result: ${lastText.slice(0, 300) || 'none'}` };
  if (s.say !== undefined) return { say: s.say.replace('{last}', lastText.slice(0, 300)) };
  return s;
}

function respond(body) {
  const p = plan(body.input);
  if (p.say !== undefined) {
    return { kind: 'message', item: { type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: p.say, annotations: [] }] } };
  }
  return { kind: 'call', item: { type: 'function_call', id: id('fc'), call_id: id('call'), name: p.tool, arguments: JSON.stringify(p.args), status: 'completed' } };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    // Key check for Settings → API keys: the key "invalid-key" is rejected, anything else is accepted.
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      const bad = (req.headers.authorization ?? '') === 'Bearer invalid-key';
      res.writeHead(bad ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bad ? { error: 'Incorrect API key provided' } : { object: 'list', data: [{ id: 'grok-4.7', object: 'model' }, { id: 'grok-4.7-fast', object: 'model' }] }));
      return;
    }
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const auth = req.headers.authorization ?? '';
    if (req.method === 'GET' && req.url === '/_requests') return json(200, recent);
    // OpenRouter: key check, model catalog (tool-capable models plus a :batch variant that should be filtered out)
    if (req.method === 'GET' && req.url.startsWith('/api/v1/key')) return auth === 'Bearer invalid-key' ? json(401, { error: { message: 'User not found.', code: 401 } }) : json(200, { data: { label: 'mock-key', usage: 0, limit: null } });
    if (req.method === 'GET' && req.url.startsWith('/api/v1/models')) return json(200, { data: [...OPENROUTER_MODELS, { ...OPENROUTER_MODELS[0], id: 'x-ai/grok-4.7:batch' }] });
    if (req.method === 'POST' && req.url.startsWith('/api/v1/responses')) req.url = '/v1/responses';
    if (req.method !== 'POST' || !req.url.startsWith('/v1/responses') || req.url.includes('compact')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not mocked' } }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* empty */ }
    recent.push({ at: Date.now(), auth: auth.slice(0, 20), referer: req.headers['http-referer'] ?? null, title: req.headers['x-title'] ?? null, body });
    if (recent.length > 20) recent.shift();
    const r = respond(body);
    const response = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed', output: [r.item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
    console.log(`[mock-xai] ${r.kind === 'call' ? `call ${r.item.name} ${r.item.arguments}` : `say ${r.item.content[0].text.slice(0, 80)}`}`);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let seq = 0;
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
    ev('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    ev('response.output_item.added', { output_index: 0, item: r.kind === 'message' ? { ...r.item, content: [], status: 'in_progress' } : r.item });
    if (r.kind === 'message') {
      const text = r.item.content[0].text;
      for (let i = 0; i < text.length; i += 24) ev('response.output_text.delta', { item_id: r.item.id, output_index: 0, content_index: 0, delta: text.slice(i, i + 24) });
    }
    ev('response.output_item.done', { output_index: 0, item: r.item });
    ev('response.completed', { response });
    res.end();
  });
});
server.listen(PORT, () => console.log(`[mock-xai] listening on http://localhost:${PORT}/v1`));
