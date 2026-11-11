import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function immutableImage(value) {
  assert.ok(typeof value === 'string' && !/\s|:\/\//.test(value), 'Use a registry reference without a scheme or whitespace.');
  assert.match(value, /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/, 'Supply a registry image pinned by digest.');
  return value;
}
export const alpine = Object.freeze({
  // docker-pull.txt recorded the index bc214871…; this is its linux/amd64 manifest.
  registry: 'docker.io/library/alpine@sha256:2d8a11041a92082ba21e364dec73559ce44f1de69b60fa68315f6d3774e59117',
  config: 'sha256:e50d940e9d2c4d81e5b3506b2ed87bfc7e91267b36ff016eb4b4cb21c39a3331',
});

export function machineDefinition(image, manifestHash, sourceRevision) {
  immutableImage(image);
  assert.match(manifestHash, /^[a-f0-9]{64}$/);
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  return {
    name: `containment-${manifestHash.slice(0, 12)}`, region: 'iad',
    config: {
      image, guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 },
      // Bypass the tenant entrypoint. No platform registration, credentials or workloads.
      // Exiting PID 1 stops billing for running compute, even if the caller disconnects.
      init: { exec: ['/bin/sh', '-ec', 'sleep 1800'] },
      env: { QUALIFICATION_MANIFEST_SHA256: manifestHash },
      metadata: { purpose: 'nested-container-containment', source_revision: sourceRevision },
      rootfs: { size_gb: 30, persist: 'restart' },
      restart: { policy: 'no' }, auto_destroy: false, services: [], mounts: [],
    },
  };
}

export function assertSuite(events) {
  const summaries = events.filter(e => e.type === 'test:summary');
  const summary = summaries.at(-1)?.data;
  assert.equal(summary?.success, true, 'Test runner did not report success.');
  assert.deepEqual(Object.fromEntries(['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'].map(k => [k, summary.counts[k]])),
    { tests: 6, passed: 6, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, 'All five containment subtests and their parent must pass without skips.');
  const passed = events.filter(e => e.type === 'test:pass');
  assert.equal(passed.length, 6);
  assert.ok(passed.every(e => !e.data.skip && !e.data.todo));
  assert.equal(passed.filter(e => e.data.nesting === 1).length, 5);
  assert.equal(events.some(e => e.type === 'test:fail'), false);
  return summary.counts;
}

export function assertKernelProbe(output) {
  const values = output.trim().split('\n');
  assert.deepEqual(values, ['10001', '0000000000000000', '1', '2', '512', '1610612736', '0', '200000 100000', 'readonly'],
    'App/desktop basic flags did not produce the expected kernel boundary.');
  return { uid: 10001, capabilities: values[1], noNewPrivileges: 1, seccomp: 2,
    pids: values[4], memory: values[5], swap: values[6], cpu: values[7], readOnly: true };
}

export function imageProvenance(record, image) {
  assert.equal(record.mode, 'publish', 'Dry-run image builds cannot satisfy release qualification.');
  assert.equal(record.hostImage, immutableImage(image));
  assert.match(record.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(record.desktopSeccompSha256, /^[a-f0-9]{64}$/, 'Published image provenance must pin the desktop profile.');
  for (const name of ['hostBase', 'desktopBase', 'app', 'desktop']) immutableImage(record.components[name]);
  return { sourceCommit: record.sourceCommit, hostImage: record.hostImage, desktopSeccompSha256: record.desktopSeccompSha256,
    components: Object.fromEntries(['hostBase', 'desktopBase', 'app', 'desktop'].map(name => [name, record.components[name]])),
    lockedInputs: record.lockedInputs };
}

export function assertDesktopProfile(bytes, manifest, release) {
  const actual = sha256(bytes);
  for (const declared of [manifest.desktopSeccompSha256, manifest.imageProvenance.desktopSeccompSha256, release.desktopSeccompSha256]) {
    assert.match(declared, /^[a-f0-9]{64}$/, 'Missing desktop profile identity.');
    assert.equal(declared, actual, 'Desktop profile differs between installed bytes, prepared bundle or published/release manifests.');
  }
  return actual;
}

export function chromeSandboxArguments() {
  return ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/home/agent/qualification-chrome', '--allow-chrome-scheme-url', '--dump-dom', 'chrome://sandbox'];
}

// Self-contained: this exact function is serialized into the real desktop
// canary, so fixture tests exercise the parser used by that process too.
export function chromeSandboxStatus(html) {
  if (typeof html !== 'string' || html.length > 1024 * 1024) throw Error('Invalid Chrome sandbox status document.');
  const tables = [...html.matchAll(/<table\b[^>]*\sid\s*=\s*["']sandbox-status["'][^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length !== 1) throw Error('Chrome did not return one sandbox status table.');
  const expected = { 'Layer 1 Sandbox': 'Namespace', 'PID namespaces': 'Yes', 'Network namespaces': 'Yes', 'Seccomp-BPF sandbox': 'Yes' };
  const observed = {};
  const text = value => value.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
  for (const row of tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => text(cell[1]));
    if (!Object.hasOwn(expected, cells[0])) continue;
    if (cells.length !== 2 || Object.hasOwn(observed, cells[0])) throw Error('Ambiguous Chrome sandbox status row.');
    observed[cells[0]] = cells[1];
  }
  for (const [name, value] of Object.entries(expected)) if (observed[name] !== value) throw Error('Chrome sandbox requirement failed: ' + name);
  return Object.fromEntries(Object.keys(expected).map(name => [name, observed[name]]));
}

export function observedMachine(machine, manifest, manifestHash, job) {
  assert.equal(machine.id, job.fly.machineId, 'Evidence came from another Machine.');
  assert.equal(machine.region, 'iad');
  assert.equal(machine.name, `containment-${manifestHash.slice(0, 12)}`);
  const config = machine.config;
  const expected = machineDefinition(manifest.hostImage, manifestHash, manifest.sourceRevision).config;
  assert.equal(config.image, expected.image, 'Actual Machine image differs from tested image claim.');
  for (const key of ['cpu_kind', 'cpus', 'memory_mb']) assert.equal(config.guest[key], expected.guest[key]);
  assert.deepEqual(config.init.exec, expected.init.exec);
  assert.equal(config.env.QUALIFICATION_MANIFEST_SHA256, manifestHash);
  assert.equal(config.metadata.purpose, expected.metadata.purpose);
  assert.equal(config.metadata.source_revision, manifest.sourceRevision);
  assert.equal(config.restart.policy, 'no');
  assert.equal(config.auto_destroy ?? false, false);
  assert.deepEqual(config.rootfs, expected.rootfs);
  assert.equal((config.services ?? []).length, 0);
  assert.equal((config.mounts ?? []).length, 0);
  return { id: machine.id, name: machine.name, region: machine.region, image: config.image,
    guest: config.guest, sourceRevision: manifest.sourceRevision, manifestSha256: manifestHash,
    services: 0, volumes: 0, restart: 'no', deadlineSeconds: 1800 };
}
