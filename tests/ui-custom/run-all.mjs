import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
const all = files(path.join(root, 'tests/ui-custom')).sort();
const tests = all.filter(file => file.endsWith('.test.mts'));
const ui = all.filter(file => file.endsWith('-ui.mjs'));
let failures = 0;
function run(args) { const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }); if (result.error) console.error(result.error); if (result.status !== 0) failures++; }
if (tests.length) run(['--import', 'tsx', '--test', '--test-concurrency=1', ...tests]);
for (const file of ui) run([file]);
console.log(`UI customization: ${tests.length} test files, ${ui.length} UI scripts, ${failures} failed commands`);
process.exitCode = failures ? 1 : 0;
