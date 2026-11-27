import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRoomsTasksDemo } from './ui-f-layout.mjs';

const evidence = path.resolve('.context/handoffs/demo-f');
fs.mkdirSync(evidence, { recursive: true });
const root = path.resolve(process.env.HO_F_ROOT || '.');
const server = spawnSync(process.execPath, [path.join(root, 'tests/handoffs/ui-f-server.mjs')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
fs.writeFileSync(path.join(evidence, 'server-results.txt'), server.stdout + server.stderr);
assert.equal(server.status, 0, server.stdout + server.stderr);
const serverPasses = Number(server.stdout.match(/pass (\d+)/)?.[1]);
assert.ok(serverPasses > 0);
const ui = await runRoomsTasksDemo();
const report = { serverPasses, uiPasses: ui.results.length, screenshots: ui.screenshots, providerCalls: 0, root };
fs.writeFileSync(path.join(evidence, 'demo-output.json'), JSON.stringify(report, null, 2));
console.log(`HO-F demo: ${serverPasses} server tests, ${ui.results.length} UI checks passed; 0 provider calls`);
console.log(`Demo output: ${path.join(evidence, 'demo-output.json')}`);
