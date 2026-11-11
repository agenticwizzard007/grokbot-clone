import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// These are credential-free validator tests. They do not generate qualification
// receipts or claim any kernel/real-Fly coverage.
import { alpine, assertDesktopProfile, assertKernelProbe, assertSuite, chromeSandboxArguments, chromeSandboxStatus, imageProvenance, immutableImage, machineDefinition, observedMachine, sha256 } from '../infra/tenant-host/qualification/policy.mjs';
import { assertDefaultWorkloadPolicy, daemonArguments, desktopArguments, hostBasicArguments, networkArguments } from '../infra/tenant-host/qualification/source-policy.mjs';
import reporter from '../infra/tenant-host/qualification/reporter.mjs';
import { copyLoaderPackages } from '../infra/tenant-host/qualification/bundle.mjs';
const image = `registry.example.invalid/qualification@sha256:${'a'.repeat(64)}`;
const hash = 'b'.repeat(64), revision = 'c'.repeat(40);
const source = file => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

test('preparation binds the extracted readiness source and hashes its installed implementation', () => {
  const tree = ts.createSourceFile('prepare.mjs', source('infra/tenant-host/qualification/prepare.mjs'), ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  const code = ['sourceFiles', 'hostFiles'].map(name => {
    const matches = declarations.filter(declaration => declaration.name.getText(tree) === name);
    assert.equal(matches.length, 1, `Review changes to the ${name} preparation binding.`);
    return `const ${matches[0].getText(tree)};`;
  }).join('\n');
  const reads: string[] = [];
  // Execute only the real binding declarations, using synthetic compiled bytes. No preparation, host or receipt.
  const bindings = vm.runInNewContext(`${code}\n({sourceFiles, hostFiles})`, {
    repo: '/fixture', path, sha256,
    fs: { readFileSync(file: string) { reads.push(file); return Buffer.from(`compiled-fixture:${file}`); } },
  });
  assert.ok(bindings.sourceFiles.includes('server/src/runtime/application-readiness.ts'));
  const compiled = '/fixture/server/dist/runtime/application-readiness.js';
  assert.ok(reads.includes(compiled));
  assert.equal(bindings.hostFiles['/app/server/dist/runtime/application-readiness.js'], sha256(`compiled-fixture:${compiled}`));
});

test('machine has bounded lifetime, no service/volume, performance-2x iad, and an immutable image', () => {
  const machine = machineDefinition(image, hash, revision);
  assert.equal(machine.region, 'iad');
  assert.deepEqual(machine.config.guest, { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 });
  assert.deepEqual(machine.config.init.exec, ['/bin/sh', '-ec', 'sleep 1800']);
  assert.deepEqual(machine.config.services, []); assert.deepEqual(machine.config.mounts, []);
  assert.equal(machine.config.restart.policy, 'no'); assert.equal(machine.config.auto_destroy, false);
  assert.deepEqual(Object.keys(machine.config.env), ['QUALIFICATION_MANIFEST_SHA256']);
  for (const bad of ['alpine:latest', alpine.config, image + '\n', 'https://example.invalid@sha256:' + 'a'.repeat(64)]) {
    assert.throws(() => immutableImage(bad));
  }
  assert.match(alpine.registry, /@sha256:[a-f0-9]{64}$/);
  assert.equal(alpine.config, 'sha256:e50d940e9d2c4d81e5b3506b2ed87bfc7e91267b36ff016eb4b4cb21c39a3331');
});

test('adapter reads actual host and daemon flags and rejects unreviewed source shapes', () => {
  const flags = hostBasicArguments(source('server/src/runtime/host.ts'));
  for (const flag of ['run', '--detach', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--memory-swap=1536m', '--memory=1536m', '--pids-limit=512', '--cpus=2', '--log-driver=none']) assert.ok(flags.includes(flag));
  assert.ok(!flags.includes('--privileged'));
  assert.deepEqual(daemonArguments(source('infra/tenant-host/entrypoint.sh')), ['--host=unix:///run/docker.sock', '--data-root=/var/lib/docker', '--dns=1.1.1.1', '--dns=1.0.0.1', '--ipv6=false']);
  for (const input of ["const basic=getFlags()", "const basic=['run',...other]", "const basic=[`--label=${untrusted}`]", "const basic=[];function f(){const basic=[]}"]) assert.throws(() => hostBasicArguments(input));
  assert.throws(() => daemonArguments('dockerd $(unsafe) > /run/swarm-host/docker.log 2>&1 &'));
  assertDefaultWorkloadPolicy(source('server/src/runtime/container-policy.ts'), flags);
  assert.throws(() => assertDefaultWorkloadPolicy("const args=['--cap-drop=ALL','--security-opt=seccomp=unconfined']", flags));
  assert.throws(() => assertDefaultWorkloadPolicy(source('server/src/runtime/container-policy.ts'), [...flags, '--security-opt=seccomp=profile']));
  const networks = networkArguments(source('infra/tenant-host/entrypoint.sh'));
  assert.equal(networks.length, 3); assert.ok(networks[0].includes('com.docker.network.bridge.enable_icc=false'));
  assert.throws(() => networkArguments('docker network create custom-network'));
});

test('desktop-only profile adapter fails closed before profile integration or on broadened privileges', () => {
  const fixture = options => `exec('docker',[...basic,'--tmpfs=/dev/shm:rw,nosuid,nodev,size=256m',${options},release.desktopImage,'node']);`;
  const scoped = "'--security-opt=seccomp=/opt/swarm/chromium-seccomp.json'";
  assert.deepEqual(desktopArguments(fixture(scoped)), ['--security-opt=seccomp=/opt/swarm/chromium-seccomp.json', '--tmpfs=/dev/shm:rw,nosuid,nodev,size=256m']);
  for (const flags of ["'--name=desktop'", "'--security-opt=seccomp=unconfined'", scoped + ",'--cap-add=SYS_ADMIN'", scoped + ",'--privileged'"]) assert.throws(() => desktopArguments(fixture(flags)));
  const actual = source('server/src/runtime/host.ts');
  if (actual.includes('--security-opt=seccomp=/opt/swarm/chromium-seccomp.json')) desktopArguments(actual);
  else assert.throws(() => desktopArguments(actual), /scoped profile/);
});

test('published provenance pins both bases and refuses dry-run or another host image', () => {
  const fixture = { mode: 'publish', hostImage: image, sourceCommit: revision, desktopSeccompSha256: hash,
    components: { hostBase: image, desktopBase: image, app: image, desktop: image } };
  assert.equal(imageProvenance(fixture, image).components.hostBase, image);
  assert.equal(imageProvenance(fixture, image).desktopSeccompSha256, hash);
  for (const change of [{ mode: 'dry-run' }, { hostImage: 'sha256:' + 'a'.repeat(64) }, { sourceCommit: 'main' },
    { desktopSeccompSha256: undefined }, { desktopSeccompSha256: 'invalid' },
    { components: { ...fixture.components, desktopBase: 'latest' } }]) assert.throws(() => imageProvenance({ ...fixture, ...change }, image));
});

test('desktop profile must agree across installed bytes, prepared bundle, published report and release', () => {
  const bytes = Buffer.from('profile validator fixture');
  const digest = sha256(bytes);
  const manifest = { desktopSeccompSha256: digest, imageProvenance: { desktopSeccompSha256: digest } };
  const release = { desktopSeccompSha256: digest };
  assert.equal(assertDesktopProfile(bytes, manifest, release), digest);
  for (const value of [undefined, 'invalid', 'a'.repeat(64)]) {
    assert.throws(() => assertDesktopProfile(bytes, { ...manifest, desktopSeccompSha256: value }, release));
    assert.throws(() => assertDesktopProfile(bytes, { ...manifest, imageProvenance: { desktopSeccompSha256: value } }, release));
    assert.throws(() => assertDesktopProfile(bytes, manifest, { desktopSeccompSha256: value }));
  }
  assert.throws(() => assertDesktopProfile(Buffer.from('changed bytes'), manifest, release));
});

test('Chrome157 probe requires modern namespace and seccomp rows and explicit chrome scheme flag', () => {
  const values = { 'Layer 1 Sandbox': 'Namespace', 'PID namespaces': 'Yes', 'Network namespaces': 'Yes', 'Seccomp-BPF sandbox': 'Yes' };
  const document = rows => `<html><table id="sandbox-status">${Object.entries(rows).map(([name, value]) => `<tr><td class="good">${name}</td><td class="good"><span>${value}</span></td></tr>`).join('')}</table></html>`;
  const html = document(values);
  assert.deepEqual(chromeSandboxStatus(html), values);
  // This exact parser is injected into a separate Node process with the desktop probe.
  const serialized = Function('return (' + chromeSandboxStatus.toString() + ')')();
  assert.deepEqual(serialized(html), values);
  for (const name of Object.keys(values)) {
    assert.throws(() => chromeSandboxStatus(document({ ...values, [name]: 'No' })));
    const missing = { ...values }; delete missing[name]; assert.throws(() => chromeSandboxStatus(document(missing)));
  }
  assert.throws(() => chromeSandboxStatus('<html><title>NewTab</title></html>'));
  assert.throws(() => chromeSandboxStatus(document({ 'Namespace sandbox': 'Yes', 'Seccomp-BPF sandbox': 'Yes' })));
  assert.throws(() => chromeSandboxStatus(html.replace('</table>', '<tr><td>PID namespaces</td><td>No</td></tr></table>')));
  assert.throws(() => chromeSandboxStatus(html + html));
  assert.throws(() => chromeSandboxStatus(html.replace(' id=', ' data-id=')));
  assert.throws(() => chromeSandboxStatus(document({ ...values, 'Seccomp-BPF sandbox': 'No', 'Seccomp-BPF sandbox supports TSYNC': 'Yes' })));
  const args = chromeSandboxArguments();
  assert.ok(args.includes('--allow-chrome-scheme-url'));
  assert.equal(args.at(-1), 'chrome://sandbox');
  assert.ok(!args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox'].includes(arg)));
});

test('suite rejects skipped, partial, failed and cancelled executions even on exit zero', () => {
  const passing = () => [
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'test:pass', data: { name: `validator fixture ${i}`, nesting: i === 5 ? 0 : 1 } })),
    { type: 'test:summary', data: { success: true, counts: { tests: 6, passed: 6, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } },
  ];
  assert.equal(assertSuite(passing()).passed, 6);
  for (const [field, value] of [['tests', 0], ['passed', 5], ['skipped', 1], ['todo', 1], ['cancelled', 1], ['failed', 1]]) {
    const events = passing(); events.at(-1)!.data.counts![field] = value; assert.throws(() => assertSuite(events));
  }
  assert.throws(() => assertSuite(passing().slice(0, -1)));
  const events = passing(); events[0].type = 'test:fail'; assert.throws(() => assertSuite(events));
  const incomplete = passing(); incomplete[0].data.nesting = 0; assert.throws(() => assertSuite(incomplete));
});

test('effective kernel probe rejects swap, root, capabilities, missing seccomp and ignored cgroup limits', () => {
  const values = ['10001', '0000000000000000', '1', '2', '512', '1610612736', '0', '200000 100000', 'readonly'];
  assert.equal(assertKernelProbe(values.join('\n')).swap, '0');
  for (const [i, bad] of [[0, '0'], [1, '0000000000000001'], [2, '0'], [3, '0'], [4, 'max'], [5, 'max'], [6, 'max'], [7, 'max 100000'], [8, 'writable']] as const) {
    const changed = [...values]; changed[i] = bad; assert.throws(() => assertKernelProbe(changed.join('\n')));
  }
});

test('final evidence must match actual Fly Machine configuration, not an env image claim', () => {
  const manifest = { hostImage: image, sourceRevision: revision };
  const observed = { ...machineDefinition(image, hash, revision), id: 'fixture-machine' };
  const job = { fly: { machineId: 'fixture-machine' } };
  assert.equal(observedMachine(observed, manifest, hash, job).image, image);
  for (const mutate of [m => { m.id = 'other'; }, m => { m.region = 'sjc'; }, m => { m.config.image = image.replace('a'.repeat(64), 'd'.repeat(64)); },
    m => { m.config.guest.cpu_kind = 'shared'; }, m => { m.config.services = [{}]; }, m => { m.config.mounts = [{}]; },
    m => { m.config.init.exec = ['sh']; }, m => { m.config.env.QUALIFICATION_MANIFEST_SHA256 = 'wrong'; }, m => { m.config.restart.policy = 'always'; }]) {
    const changed = structuredClone(observed); mutate(changed); assert.throws(() => observedMachine(changed, manifest, hash, job));
  }
});

test('reporter exports only bounded test outcome fields', async () => {
  async function* events() {
    yield { type: 'test:diagnostic', data: { message: 'sensitive' } };
    yield { type: 'test:fail', data: { name: 'fixture', nesting: 1, details: { error: { message: 'sensitive', stack: 'sensitive' } } } };
  }
  let output = ''; for await (const line of reporter(events())) output += line;
  assert.ok(!output.includes('sensitive'));
  assert.deepEqual(JSON.parse(output), { type: 'test:fail', data: { name: 'fixture', nesting: 1 } });
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('copied Linux loader graph executes the unchanged real suite and skipped execution is refused', () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'containment-loader-test-'));
  try {
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const packages = copyLoaderPackages(repo, directory);
    assert.ok(packages.tsx && packages.zod && packages['@esbuild/linux-x64']);
    for (const file of ['tests/container-containment.test.mts', 'server/src/runtime/container-policy.ts', 'server/src/runtime/mcp-folders.ts', 'server/src/security/mcp-folders.ts']) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.copyFileSync(path.join(repo, file), path.join(directory, file));
    }
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(path.join(repo, 'infra/tenant-host/qualification/reporter.mjs'), path.join(directory, 'reporter.mjs'));
    const childEnv = { ...process.env, RUN_CONTAINER_TESTS: '0' }; delete childEnv.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=./reporter.mjs', 'tests/container-containment.test.mts'],
      { cwd: directory, encoding: 'utf8', timeout: 30000, env: childEnv });
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).data.counts.skipped, 1);
    assert.throws(() => assertSuite(events));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual job refuses a non-Fly context, emits only failed diagnostics, and finalizer refuses it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'containment-failed-job-test-'));
  try {
    const repo = fileURLToPath(new URL('../', import.meta.url));
    for (const file of ['job.mjs', 'policy.mjs', 'desktop-check.mjs']) fs.copyFileSync(path.join(repo, 'infra/tenant-host/qualification', file), path.join(directory, file));
    const run = spawnSync(process.execPath, ['job.mjs'], { cwd: directory, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
    assert.equal(run.status, 1);
    const bytes = fs.readFileSync(path.join(directory, 'results/job.json'));
    const job = JSON.parse(bytes);
    assert.equal(job.status, 'failed'); assert.equal(job.cleanup, false); assert.equal(job.failurePhase, 'prerequisites');
    assert.equal(fs.readFileSync(path.join(directory, 'results/job.json.sha256'), 'utf8'), `${sha256(bytes)}  job.json\n`);
    fs.writeFileSync(path.join(directory, 'manifest.json'), '{}');
    const finalized = spawnSync(process.execPath, [path.join(repo, 'infra/tenant-host/qualification/finalize.mjs'),
      path.join(directory, 'manifest.json'), path.join(directory, 'results'), 'no-machine-observation.json', path.join(directory, 'evidence')],
      { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(finalized.status, 0); assert.equal(fs.existsSync(path.join(directory, 'evidence')), false);
    assert.match(finalized.stderr, /failed\/incomplete job/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
