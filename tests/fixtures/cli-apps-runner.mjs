// Fake official CLI process. Only the local Swarm MCP endpoint is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const emailBody = Array.from({ length: 16 }, (_, i) => `Email line ${i + 1}`).join('\n');
export const emailArgs = { recipient_email: 'test@example.com', subject: 'Recheck', body: emailBody, is_html: false };

export async function runFixture(directory) {
  const args = process.argv.slice(2);
  const provider = args[0] === 'exec' || args[0] === 'login' ? 'codex' : 'claude';
  const audit = record => fs.appendFileSync(path.join(directory, 'audit.jsonl'), JSON.stringify({ provider, ...record }) + '\n');
  if (args[0] === 'login' || args[0] === 'auth') {
    console.log(provider === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
    return;
  }
  if (provider === 'claude' && !args.includes('--json-schema')) {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const response = request.request.subtype === 'initialize'
        ? { account: { subscriptionType: 'max', apiProvider: 'firstParty' }, models: [{ value: 'default', displayName: 'Fixture', supportsEffort: false }] } : {};
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } }));
    }
    return;
  }
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const conversation = JSON.parse(prompt.split('\n\nConversation:\n')[1]);
  const last = conversation.at(-1);
  let config;
  if (provider === 'claude') config = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.swarm;
  else {
    const raw = args.find(arg => arg.startsWith('mcp_servers='));
    config = { url: JSON.parse(/url=("(?:[^"\\]|\\.)*")/.exec(raw)[1]), headers: { Authorization: JSON.parse(/Authorization=("(?:[^"\\]|\\.)*")/.exec(raw)[1]) } };
  }
  assert.equal(new URL(config.url).hostname, '127.0.0.1');
  const client = new Client({ name: 'cli-apps-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  const listing = await client.listTools();
  audit({ kind: 'manifest', names: listing.tools.map(t => t.name), tools: listing.tools, args, prompt });
  const call = async (name, arguments_) => {
    const reply = await client.callTool({ name, arguments: arguments_ });
    audit({ kind: 'result', name, reply });
    const text = reply.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
  let text = emailBody;
  if (last?.type === 'function_call_output') {
    text = /declined/i.test(last.output) ? 'The action was not allowed. Nothing was sent or saved.' : 'The fake app action completed.';
  } else if (JSON.stringify(last).includes('text only')) {
    const description = await call('tool_describe', { tool_name: 'present_draft' });
    await call('tool_call', { tool_name: description.name, schema_hash: description.schema_hash,
      arguments: { channel: 'email', to: emailArgs.recipient_email, subject: emailArgs.subject, text: emailBody } });
    text = 'The copyable draft is ready. Nothing was sent or saved in Gmail.';
  } else if (JSON.stringify(last).includes('stale account')) {
    const result = await call('SWARM_APPS_EXECUTE', { connectionId: 'stale-gmail', revision: 1, tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: emailArgs });
    if (result.status === 'pending') await new Promise(() => {});
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } else if (JSON.stringify(last).includes('fixture mcp')) {
    const found = await call('tool_search', { query: 'fixture lookup' });
    assert.ok(found.length);
    const description = await call('tool_describe', { tool_name: found[0].name });
    await call('tool_call', { tool_name: description.name, schema_hash: description.schema_hash, arguments: { key: 'fixture' } });
    await new Promise(() => {});
  } else if (!JSON.stringify(last).includes('plain reply')) {
    const connections = await call('list_app_connections', {});
    const requested = JSON.stringify(last);
    // The original live request must have an explicit route in the system
    // instructions, not rely on the fixture knowing a hidden Gmail action.
    const originalRequest = requested.includes('Draft a Gmail email to test@example.com with subject Recheck and two paragraphs');
    const system = conversation.find(item => item.role === 'system')?.content ?? '';
    const hintedDraft = originalRequest ? /Gmail routing for this account: for an email draft, use (GMAIL_[A-Z_]+)/.exec(system)?.[1] : undefined;
    if (originalRequest) assert.ok(hintedDraft, 'Connected Gmail draft action must be named in the supplied system instructions');
    const toolkit = /fixture slack/.test(requested) ? 'slack' : /fixture calendar/.test(requested) ? 'googlecalendar' : 'gmail';
    const connection = connections.connections.find(c => c.toolkit === toolkit);
    const discovery = await call('SWARM_APPS_SEARCH', { toolkit, query: requested.includes('send email') ? 'send email' : 'create draft', ...(connection ? { connectionId: connection.id } : {}) });
    if (discovery.status === 'pending') {
      // The pending Connect result must reach the actual CLI before shutdown.
      await new Promise(() => {});
    }
    const chosen = hintedDraft ? discovery.tools.find(t => t.slug === hintedDraft)
      : discovery.tools.find(t => t.slug.includes(requested.includes('send email') ? 'SEND' : 'DRAFT')) ?? discovery.tools[0];
    assert.ok(chosen, 'The hinted action must be discovered with its current schema');
    const action = { connectionId: discovery.connectionId, revision: discovery.revision, tool_slug: chosen.slug,
      arguments: originalRequest ? { ...emailArgs, body: 'First paragraph.\n\nSecond paragraph.' } : emailArgs };
    const result = await call('SWARM_APPS_EXECUTE', action);
    if (result.status === 'pending_approval') {
      // Deliberately attempt another write after the stop result. It must never
      // reach the application, even during the response delivery window.
      await call('SWARM_APPS_EXECUTE', action);
      throw Error('A stopped generation admitted another action');
    }
    text = 'No action approval was requested.';
  }
  await client.close();
  const output = { text, tool_calls: [] };
  if (provider === 'codex') {
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(output));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }));
  } else console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: output, usage: { input_tokens: 3, output_tokens: 2 } }));
}

export function installFakeCli(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'cli.mjs');
  fs.writeFileSync(filename, `#!${process.execPath}\nimport { runFixture } from ${JSON.stringify(import.meta.url)};\nawait runFixture(${JSON.stringify(directory)});\n`, { mode: 0o700 });
  process.env.SWARM_CLI_CODEX_PATH = filename;
  process.env.SWARM_CLI_CLAUDE_PATH = filename;
  return filename;
}
