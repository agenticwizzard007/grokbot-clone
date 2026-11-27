import http from 'node:http';
import { adaptInput } from './mock-iter.mjs';
import { gullibleScript } from './gullible-persona.mjs';
const port = Number(process.argv[2]), upstream = `http://127.0.0.1:${Number(process.argv[3])}`;
const requests = [];
http.createServer(async (req, res) => {
  try {
    if (req.url === '/_handoff_requests') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(requests)); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (raw && req.url.includes('/responses')) {
      const body = JSON.parse(raw), adapted = adaptInput(body, gullibleScript);
      requests.push({ original: body.input, adapted: adapted.input });
      raw = JSON.stringify(adapted);
    }
    const reply = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' }, ...(raw ? { body: raw } : {}) });
    res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of reply.body) res.write(chunk);
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(port, '127.0.0.1');
