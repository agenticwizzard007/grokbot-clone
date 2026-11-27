import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { providerAdapter, scriptedBody } from '../fixtures/provider-adapter.mjs';
import { runSuite } from '../fixtures/harness.mjs';

await runSuite('provider-adapter', [
  { name: 'script mapping never mutates persisted prompt or previous turns', run: () => {
    const input = { input: [{ role: 'user', content: 'Build my week' }, { role: 'assistant', content: 'Ready' }, { role: 'user', content: 'Open Tasks' }] };
    const original = structuredClone(input), scripts = new Map([['Build my week', 'first'], ['Open Tasks', 'second']]);
    const result = scriptedBody(input, scripts);
    assert.deepEqual(input, original);
    assert.equal(result.input[0].content, 'Build my week');
    assert.equal(result.input[1].content, 'Ready');
    assert.equal(result.input[2].content, 'Open Tasks\nmock: second');
  } },
  { name: 'unmatched turns and explicit hostile provider scripts remain intact', run: () => {
    for (const content of ['Unrelated question', 'mock: hostile <script>']) {
      const body = { input: [{ role: 'user', content }] };
      assert.deepEqual(scriptedBody(body, new Map([['question elsewhere', 'wrong']])), body);
    }
    assert.deepEqual(scriptedBody({ model: 'local' }, new Map()), { model: 'local' });
  } },
  { name: 'local HTTP transport forwards scripts and streams response without changing natural prompt', run: async () => {
    let received;
    const target = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"output":"Ready"}\n\n'); res.end('data: [DONE]\n\n');
    });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const proxy = await providerAdapter(`http://127.0.0.1:${target.address().port}`);
    try {
      proxy.script('Build my week', 'preview_ui_patch {}');
      assert.throws(() => proxy.script('mock: test', 'hidden'));
      const body = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Build my week' }] }] };
      const response = await fetch(`${proxy.base}/v1/responses`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal(await response.text(), 'data: {"output":"Ready"}\n\ndata: [DONE]\n\n');
      assert.match(received.input[0].content, /mock: preview_ui_patch/);
      assert.equal(body.input[0].content[0].text, 'Build my week');
    } finally { await proxy.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
  } },
  { name: 'remote provider target is refused', run: async () => {
    await assert.rejects(() => providerAdapter('https://example.com'));
  } },
], { server: false });
