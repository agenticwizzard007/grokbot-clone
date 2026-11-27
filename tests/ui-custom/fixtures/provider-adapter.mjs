// Script the local model transport, never the persisted conversation or rendered DOM.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

export function scriptedBody(body, scripts) {
  const copy = structuredClone(body);
  const message = copy.input?.findLast(item => item.role === 'user');
  if (!message) return copy;
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  if (text.includes('mock:')) return copy; // Explicit hostile security scripts stay unchanged.
  const entry = [...scripts].reverse().find(([prompt]) => text.includes(prompt));
  if (entry) message.content = `${text}\nmock: ${entry[1]}`;
  return copy;
}

export async function providerAdapter(target) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname));
  const scripts = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size < 4 * 1024 * 1024); chunks.push(chunk); }
      let body = Buffer.concat(chunks).toString();
      if (body && req.url.includes('/responses')) body = JSON.stringify(scriptedBody(JSON.parse(body), scripts));
      const response = await fetch(new URL(req.url, target), { method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json', authorization: req.headers.authorization || '' },
        ...(body ? { body } : {}) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      for await (const chunk of response.body || []) res.write(chunk);
      res.end();
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`,
    script(prompt, script) { assert.ok(prompt.trim() && !/mock:|Fixture|PRIVATE|QA-/i.test(prompt)); scripts.set(prompt, script); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
