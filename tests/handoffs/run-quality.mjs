// Run every executable handoff/flow test. Helpers and data seeds are imports,
// not standalone tests. Logs and exact exit codes are always retained.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const out = path.resolve(process.env.HANDOFFS_CHECK_DIR || '.context/handoffs/quality-h'); fs.mkdirSync(out, { recursive: true });
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const tests = [...walk('tests/handoffs'), ...walk('tests/flow'), ...fs.readdirSync('tests').filter(name => /^((?:native-)?coordination.*|agent-.*|composio|readiness-kk)\.test\.mts$/.test(name)).map(name => `tests/${name}`)].filter(file => file.endsWith('.test.mts'));
const ui = [
  'tests/handoffs/ui-d-behavior.mjs', 'tests/handoffs/ui-d-loop-compat.mjs', 'tests/handoffs/ui-d-layout.mjs',
  'tests/handoffs/ui-e-behavior.mjs', 'tests/handoffs/ui-e-layout.mjs', 'tests/handoffs/ui-f-server.mjs', 'tests/handoffs/ui-f-layout.mjs',
  'tests/handoffs/integration-routes-ui.mjs', 'tests/flow/demo-g.mjs',
  'tests/handoffs/activity-quality.mjs',
];
const demos = ['a', 'b', 'c', 'd', 'e', 'f', 'i'].map(letter => `tests/handoffs/demo-${letter}.mjs`);
const commands = process.argv.includes('--existing-ui') ? ui.map(file => [process.execPath, [file]]) : [
  ['npm', ['run', 'typecheck']], [process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests]],
  ['npm', ['run', 'build', '-w', 'web']], ...ui.map(file => [process.execPath, [file]]),
  ...demos.map(file => [process.execPath, [file]]),
  [process.execPath, ['--import', 'tsx', 'tests/handoffs/e2e-loop-real.mjs']],
  [process.execPath, ['tests/handoffs/e2e/journeys.mjs']], [process.execPath, ['tests/handoffs/layout-ui.mjs']],
  [process.execPath, ['scripts/handoffs-demo.mjs']], [process.execPath, ['tests/handoffs/perf/server.mjs']], [process.execPath, ['tests/handoffs/perf/browser.mjs']],
  [process.execPath, ['tests/handoffs/polish-shots.mjs']],
  [process.execPath, ['tests/layout-alignment-ui.mjs']], [process.execPath, ['--import', 'tsx', 'tests/navigation-every-route-ui.mjs']],
];
const results = [];
for (const [command, args] of commands) {
  const name = args.find(arg => /\.(mjs|mts)$/.test(arg))?.replaceAll('/', '_') || args.join('-');
  const log = path.join(out, `${name}.log`), fd = fs.openSync(log, 'w');
  console.log(`RUN ${command} ${args.join(' ')}`);
  const exit = await new Promise(resolve => { const child = spawn(command, args, { stdio: ['ignore', fd, fd], env: { ...process.env, HO_POLISH_OUTPUT: process.env.HO_POLISH_OUTPUT || path.join(out, 'polish-shots') } }); child.on('error', error => resolve(String(error))); child.on('exit', code => resolve(code)); }); fs.closeSync(fd);
  const text = fs.readFileSync(log, 'utf8');
  const summaries = [...text.matchAll(/^(?:HO-H (?:journeys|layout): |(?:PASS|FAIL) demo of record: |PASS |FLOW DEMO |UI QUALITY |HO-I integration UI: |HO-C demo: |PASS HO-E (?:behavior|layout): )(\d+)(?:\/\d+| pass| checks| views)/gm)];
  const pass = Number(text.match(/(?:ℹ |# )pass (\d+)/)?.[1] ?? summaries.at(-1)?.[1] ?? [...text.matchAll(/^PASS\b/gm)].length);
  const failures = [...text.matchAll(/^(?:HO-H (?:journeys|layout): \d+ pass, |(?:PASS|FAIL) demo of record: \d+ checks, |(?:FLOW DEMO|UI QUALITY) \d+ passed, )(\d+) fail/gm)];
  const fail = Number(text.match(/(?:ℹ |# )fail (\d+)/)?.[1] ?? failures.at(-1)?.[1] ?? ([...text.matchAll(/^FAIL\b/gm)].length || (exit === 0 ? 0 : 1)));
  results.push({ command: [command, ...args].join(' '), exit, passed: pass, failed: fail, log });
  console.log(`${exit === 0 ? 'PASS' : 'FAIL'} command: ${pass} reported passes, ${fail} reported failures; ${log}`);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2));
}
console.log(`Quality commands: ${results.filter(r => r.exit === 0).length} pass, ${results.filter(r => r.exit !== 0).length} fail`);
if (results.some(r => r.exit !== 0)) process.exitCode = 1;
