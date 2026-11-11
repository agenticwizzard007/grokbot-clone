// Controlled stdio peer for lifecycle tests; contains no browser or credentials.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const output = process.argv[process.argv.indexOf('--output-dir') + 1];
if (output) fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ args: process.argv.slice(2), execPath: process.execPath, inheritedMcp: Object.keys(process.env).filter(name => name.startsWith('PLAYWRIGHT_MCP_')) }));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  if (msg.method === 'tools/call' && msg.params.name === 'browser_wait_for') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(output, 'child.pid'), String(child.pid));
    continue;
  }
  const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : { content: [{ type: 'text', text: 'fixture page' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}
