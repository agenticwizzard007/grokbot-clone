import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';

/** Replay the actual companion generate result, not the widget's typed result.
 * Codex exec writes {text,tool_calls} to --output-last-message and reports
 * item.completed/turn.completed on stdout (companion/cli-bridge.mjs:generateCodex).
 * Claude's result.structured_output is the same envelope (generateClaude).
 * Both become this RPC result, then pass through cliResponsesClient unchanged.
 * No model process or remote provider is started. */
export async function widgetProviderReplay({ api, request, provider = 'codex' }) {
  const paired = await request('POST', '/cli/pair', {});
  assert.equal(paired.status, 200, JSON.stringify(paired));
  const token = /--token '([^']+)'$/.exec(paired.body.command)?.[1];
  assert.ok(token);
  const socket = new WebSocket(api.replace('http:', 'ws:') + '/api/cli-bridge');
  const requests = [], cancelled = [], held = [];
  let reply = 'Hello there, nice to meet you.', failure, delayMs = 300, hold = false;
  let welcome;
  const ready = new Promise(resolve => { welcome = resolve; });
  const finish = message => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ id: message.id, ...(failure ? { error: failure } : { result: {
      text: JSON.stringify({ text: reply, tool_calls: [] }), model: 'default', usage_status: 'unavailable',
    } }) }));
  };
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'welcome') { welcome(); return; }
    if (message.method === 'cancel') { cancelled.push(message); return; }
    if (!message.id) return;
    if (message.method === 'generate') {
      requests.push(message);
      assert.equal(message.params.provider, provider);
      assert.equal(message.params.nativeTools, undefined, 'widget never receives native tools');
      assert.ok(message.params.actionNames.every(name => name.startsWith('read_')));
      if (hold) held.push(message); else setTimeout(() => finish(message), delayMs);
    } else socket.send(JSON.stringify({ id: message.id, result: message.method === 'status' ? {
      codex: { installed: true, authenticated: true, subscription: true },
      claude: { installed: true, authenticated: true, subscription: true },
    } : { models: [], defaultModel: null, plan: null, usage: { available: false } } }));
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', version: 1, codexExecOnly: true, noGenerationDeadline: true, token, device: 'Local replay' }));
  await ready;
  assert.equal((await request('PUT', '/cli', { provider })).status, 200);
  return { requests, cancelled,
    set(options) { reply = options.text ?? ''; failure = options.error; delayMs = options.delayMs ?? 300; hold = options.hold ?? false; },
    release() { hold = false; for (const request of held.splice(0)) finish(request); },
    async close() { socket.terminate(); await once(socket, 'close'); },
  };
}
