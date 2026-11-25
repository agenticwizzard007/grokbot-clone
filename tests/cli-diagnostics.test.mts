import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withCliDiagnostics } from '../server/src/cli/diagnostics.js';
import { ToolCallbacks } from '../server/src/cli/tool-callback.js';

test('CLI diagnostics classify manifest rejection, application denial and runner failure without bodies or secrets', async t => {
  const logs: any[] = [];
  t.mock.method(console, 'info', (_label: string, value: string) => logs.push(JSON.parse(value)));
  const params = { provider: 'codex', nativeTools: [{ name: 'SWARM_APPS_EXECUTE' }], prompt: 'private-prompt-sentinel' };
  await assert.rejects(withCliDiagnostics(params, 'server', async () => {
    const callbacks = new ToolCallbacks(params, async () => ({ output: 'The user declined this action. private-output-sentinel', isError: true }));
    assert.throws(() => callbacks.run({ id: 'request-token-sentinel', name: 'not_in_manifest', arguments: {} }), /Invalid native/);
    await callbacks.run({ id: 'request-token-sentinel', name: 'SWARM_APPS_EXECUTE', arguments: { tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', body: 'private-body-sentinel' } });
    callbacks.close();
    throw new Error('Provider timeout with secret-token-sentinel');
  }), /timeout/);
  assert.ok(logs.some(e => e.tool === 'not_in_manifest' && e.admission === 'rejected' && e.errorClass === 'tool_unavailable'));
  assert.ok(logs.some(e => e.tool === 'SWARM_APPS_EXECUTE' && e.action === 'GMAIL_CREATE_EMAIL_DRAFT' && e.admission === 'refused' && e.errorClass === 'policy_denied'));
  assert.ok(logs.some(e => e.event === 'failure' && e.errorClass === 'timeout'));
  assert.equal(new Set(logs.map(e => e.generationId)).size, 1);
  assert.ok(logs.every(e => e.manifestCount === 1 && /^[a-f0-9]{64}$/.test(e.manifestNamesHash)));
  assert.doesNotMatch(JSON.stringify(logs), /sentinel/);
});
