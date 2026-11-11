#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertDesktopProfile, assertKernelProbe, assertSuite, immutableImage, sha256 } from './policy.mjs';
import { checkDesktop } from './desktop-check.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
process.umask(0o077);
const output = path.join(root, 'results');
fs.mkdirSync(output); // Never overwrite or combine evidence from separate runs.
const result = { schemaVersion: 1, gate: 'nested-container-containment', status: 'failed',
  startedAt: new Date().toISOString(), fly: { app: process.env.FLY_APP_NAME, machineId: process.env.FLY_MACHINE_ID, region: process.env.FLY_REGION },
  kernel: os.release(), architecture: process.arch, node: process.version, memoryTotalBytes: os.totalmem(), checks: {}, cleanup: false };
let daemon, phase = 'prerequisites';
const execute = promisify(execFile);
const exec = (file, args, timeout = 30000) => execute(file, args, { timeout, maxBuffer: 1024 * 1024,
  env: { ...process.env, DOCKER_HOST: 'unix:///run/docker.sock', DOCKER_CONTEXT: 'default' } });
const docker = (args, timeout) => exec('docker', args, timeout);
// A blocked child also has a per-command timeout. This watchdog bounds the
// entire job; the independent VM PID 1 deadline bounds a killed/stuck job too.
const watchdog = setTimeout(() => { result.failurePhase = phase; finish(); process.exit(124); }, 12 * 60 * 1000);
function finish() {
  result.finishedAt = new Date().toISOString();
  result.artifacts = Object.fromEntries(fs.readdirSync(output).filter(name => name !== 'job.json' && name !== 'job.json.sha256')
    .map(name => [name, sha256(fs.readFileSync(path.join(output, name)))]));
  const bytes = JSON.stringify(result, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'job.json'), bytes);
  fs.writeFileSync(path.join(output, 'job.json.sha256'), `${sha256(bytes)}  job.json\n`);
}
try {
  assert.equal(process.getuid(), 0, 'Host mount probes require root in the disposable VM.');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  assert.equal(result.fly.region, 'iad'); assert.ok(result.fly.machineId && result.fly.app);
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'FLY_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'PLATFORM_REGISTRATION_SECRET', 'TENANT_DATA_KEY', 'SESSION_SECRET']) assert.ok(!process.env[key], `Use an empty, disposable Fly app; unexpected ${key}.`);
  const manifestBytes = fs.readFileSync('manifest.json');
  const hash = sha256(manifestBytes);
  assert.equal(hash, process.env.QUALIFICATION_MANIFEST_SHA256, 'Bundle is not the one configured on this Machine.');
  const manifest = JSON.parse(manifestBytes);
  immutableImage(manifest.hostImage);
  result.hostImage = manifest.hostImage; result.sourceRevision = manifest.sourceRevision; result.manifestSha256 = hash;
  result.imageProvenance = manifest.imageProvenance;
  result.scope = manifest.scope;
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    assert.equal(sha256(fs.readFileSync(file)), expected, `Bundle changed: ${file}`);
  }
  for (const [file, expected] of Object.entries(manifest.hostFiles)) assert.equal(sha256(fs.readFileSync(file)), expected, `Candidate host/source build mismatch: ${file}`);
  // Existing daemon/socket/data would invalidate the empty-host assumption.
  assert.equal(fs.existsSync('/run/docker.sock'), false);
  assert.ok(!fs.existsSync('/var/lib/docker') || fs.readdirSync('/var/lib/docker').length === 0);
  assert.ok(!fs.existsSync('/var/lib/containerd') || fs.readdirSync('/var/lib/containerd').length === 0);
  fs.mkdirSync('/run/swarm-host', { recursive: true, mode: 0o700 });
  phase = 'dockerd';
  const daemonLog = fs.openSync(path.join(output, 'dockerd.log'), 'wx', 0o600);
  daemon = spawn('dockerd', manifest.daemonArguments, { stdio: ['ignore', daemonLog, daemonLog] });
  fs.closeSync(daemonLog);
  let daemonError;
  daemon.on('error', error => { daemonError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (daemonError) throw daemonError;
    if (daemon.exitCode !== null) throw new Error('dockerd exited before readiness.');
    try { await docker(['info', '--format', '{{json .}}'], 2000); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Nested dockerd did not become ready.');
  const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  result.docker = Object.fromEntries(['ServerVersion', 'Driver', 'CgroupDriver', 'CgroupVersion', 'MemoryLimit', 'SwapLimit', 'PidsLimit', 'CPUCfsQuota', 'SecurityOptions']
    .map(key => [key, info[key]]));
  assert.equal(info.CgroupVersion, '2');
  for (const key of ['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CPUCfsQuota']) assert.equal(info[key], true);
  assert.ok(info.SecurityOptions?.some(value => value.includes('seccomp') && value.includes('profile=builtin')), 'Non-desktop default must be Docker builtin seccomp.');
  phase = 'immutable-alpine';
  await docker(['pull', '--platform=linux/amd64', manifest.alpine.registry], 120000);
  const inspected = JSON.parse((await docker(['image', 'inspect', manifest.alpine.registry])).stdout)[0];
  assert.equal(inspected.Id, manifest.alpine.config, 'Pulled Alpine config differs from recorded containment-image.txt.');
  assert.equal(inspected.Architecture, 'amd64'); assert.equal(inspected.Os, 'linux');
  result.alpine = { registry: manifest.alpine.registry, config: inspected.Id, architecture: inspected.Architecture };
  phase = 'containment-suite';
  const eventsFile = fs.openSync(path.join(output, 'tests.ndjson'), 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=./reporter.mjs', 'tests/container-containment.test.mts'],
        { cwd: root, env: { ...process.env, DOCKER_HOST: 'unix:///run/docker.sock', DOCKER_CONTEXT: 'default', RUN_CONTAINER_TESTS: '1', CONTAINMENT_TEST_IMAGE: inspected.Id },
          stdio: ['ignore', eventsFile, eventsFile], timeout: 300000, killSignal: 'SIGKILL' });
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('Containment suite failed or timed out.')));
    });
  } finally { fs.closeSync(eventsFile); }
  result.checks.suite = assertSuite(fs.readFileSync(path.join(output, 'tests.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  phase = 'host-basic-policy';
  // Keep the exact detached/log-driver=none policy. Copy a tmpfs output file
  // while the canary is alive; stopping it would unmount that tmpfs.
  const probeName = `swarm-basic-${randomUUID()}`;
  try {
    const script = 'id -u; awk \'/^CapEff:|^NoNewPrivs:|^Seccomp:/{print $2}\' /proc/self/status; cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpu.max; if touch /etc/escape 2>/dev/null; then exit 1; fi; echo readonly';
    await docker([...manifest.hostBasicArguments, `--name=${probeName}`, '--network=none', inspected.Id, '/bin/sh', '-ec', `{ ${script}; } > /tmp/kernel.txt; sleep 120`]);
    // Wait for output without docker exec (which would bypass the tested entry process).
    let copied = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await docker(['cp', `${probeName}:/tmp/kernel.txt`, path.join(output, 'kernel.txt')]);
        result.checks.hostBasic = assertKernelProbe(fs.readFileSync(path.join(output, 'kernel.txt'), 'utf8')); copied = true; break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(copied, 'App/desktop kernel probe did not finish.');
  } finally { await docker(['rm', '-f', probeName]); }
  phase = 'production-preflight';
  const release = JSON.parse(fs.readFileSync('/opt/swarm/release.json'));
  assert.equal(release.buildMode, 'verified', 'Dry-run releases cannot qualify for release gates.');
  assert.equal(release.sourceCommit, manifest.imageProvenance.sourceCommit);
  assert.equal(release.appImage, manifest.imageProvenance.components.app);
  assert.equal(release.desktopImage, manifest.imageProvenance.components.desktop);
  assertDesktopProfile(fs.readFileSync('/opt/swarm/chromium-seccomp.json'), manifest, release);
  immutableImage(release.mcpImage);
  await docker(['load', '--input', '/opt/swarm/images/MCP_IMAGE.tar'], 120000);
  // docker save/load drops RepoDigests; the signed release maps them to config IDs.
  assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', release.imageIds.mcpImage])).stdout.trim(), release.imageIds.mcpImage);
  process.env.DOCKER_HOST = 'unix:///run/docker.sock'; process.env.DOCKER_CONTEXT = 'default';
  const { verifyHostContainment } = await import('/app/server/dist/runtime/host-preflight.js');
  await verifyHostContainment(release.imageIds.mcpImage);
  result.checks.productionPreflight = { passed: true, mcpImage: release.mcpImage, config: release.imageIds.mcpImage };
  phase = 'scoped-desktop';
  result.checks.desktop = await checkDesktop({ docker, exec, manifest, release, output });
  phase = 'cleanup';
  assert.equal((await docker(['container', 'ls', '-aq'])).stdout.trim(), '', 'Container leak.');
  assert.equal((await docker(['network', 'ls', '--filter', 'type=custom', '-q'])).stdout.trim(), '', 'Network leak.');
  assert.equal((await docker(['volume', 'ls', '-q'])).stdout.trim(), '', 'Anonymous volume leak.');
  assert.ok(!fs.readFileSync('/proc/self/mountinfo', 'utf8').includes('/run/swarm-host/mcp-folders/'), 'MCP folder mount leak.');
  result.cleanup = true;
  result.status = 'passed';
} catch (error) {
  result.failurePhase = phase;
  // Keep diagnostics bounded and avoid exporting environment or arbitrary error properties.
  result.error = String(error.message).slice(0, 2000);
} finally {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10000))]);
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); result.status = 'failed'; result.cleanup = false; result.failurePhase = 'daemon-shutdown'; }
  }
  clearTimeout(watchdog);
  finish();
}
console.log(JSON.stringify({ status: result.status, evidence: output, failurePhase: result.failurePhase }));
process.exitCode = result.status === 'passed' ? 0 : 1;
