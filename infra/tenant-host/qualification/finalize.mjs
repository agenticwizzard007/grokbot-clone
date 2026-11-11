#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertKernelProbe, assertSuite, observedMachine, sha256 } from './policy.mjs';

const [manifestFile, resultDirectory, machineFile, output] = process.argv.slice(2);
assert.ok(output, 'Usage: node infra/tenant-host/qualification/finalize.mjs <prepared-manifest.json> <downloaded-results-directory> <machine-get.json> <new-output-directory>');
const manifestBytes = fs.readFileSync(manifestFile);
const manifest = JSON.parse(manifestBytes);
const jobBytes = fs.readFileSync(path.join(resultDirectory, 'job.json'));
assert.equal(fs.readFileSync(path.join(resultDirectory, 'job.json.sha256'), 'utf8'), `${sha256(jobBytes)}  job.json\n`, 'Downloaded job JSON checksum differs.');
const job = JSON.parse(jobBytes);
assert.equal(job.status, 'passed', 'A failed/incomplete job cannot become qualification evidence.');
assert.equal(job.cleanup, true);
assert.equal(job.manifestSha256, sha256(manifestBytes));
assert.equal(job.hostImage, manifest.hostImage);
assert.equal(job.sourceRevision, manifest.sourceRevision);
assert.equal(job.alpine.registry, manifest.alpine.registry);
assert.equal(job.alpine.config, manifest.alpine.config);
assert.equal(job.checks.productionPreflight.passed, true);
assert.deepEqual(job.imageProvenance, manifest.imageProvenance);
assert.equal(job.checks.desktop.status, 'passed');
assert.equal(job.checks.desktop.profileSha256, manifest.desktopSeccompSha256);
assert.equal(job.checks.desktop.nonDesktopDefaultSeccomp, true);
assert.equal(job.checks.desktop.firewallRestored, true);
assert.equal(job.checks.desktop.firewallSha256, manifest.hostFiles['/opt/swarm/firewall.sh']);
for (const check of ['filesystem', 'kernel', 'namespaceContained', 'companionRoute', 'invalidCompanionTokenRejected', 'chromeNamespaceSandbox', 'chromeSeccompSandbox', 'chromePidNamespace', 'chromeNetworkNamespace']) assert.equal(job.checks.desktop.checks[check], true);
assert.equal(job.checks.desktop.blockedTargets.length, 7);
assert.equal(job.fly.region, 'iad');
assert.match(job.fly.app, /^[a-z0-9-]+$/);
assert.ok(Date.parse(job.finishedAt) >= Date.parse(job.startedAt));
assert.ok(Date.parse(job.finishedAt) - Date.parse(job.startedAt) < 12 * 60 * 1000);
for (const [file, expected] of Object.entries(job.artifacts)) {
  assert.equal(file, path.basename(file));
  assert.equal(sha256(fs.readFileSync(path.join(resultDirectory, file))), expected, `Downloaded artifact changed: ${file}`);
}
assert.ok(job.artifacts['tests.ndjson'] && job.artifacts['kernel.txt'] && job.artifacts['dockerd.log']);
assert.ok(job.artifacts['desktop.json']);
assert.equal(JSON.parse(fs.readFileSync(path.join(resultDirectory, 'desktop.json'))).status, 'passed');
assertSuite(fs.readFileSync(path.join(resultDirectory, 'tests.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
assertKernelProbe(fs.readFileSync(path.join(resultDirectory, 'kernel.txt'), 'utf8'));
const machine = observedMachine(JSON.parse(fs.readFileSync(machineFile)), manifest, sha256(manifestBytes), job);
const evidence = { schemaVersion: 1, gate: 'nested-container-containment', status: 'passed',
  approval: 'unreviewed', hostImage: manifest.hostImage, scope: manifest.scope,
  sourceRevision: manifest.sourceRevision, machine, job, provenance: {
    manifestSha256: sha256(manifestBytes), jobSha256: sha256(jobBytes), sourceFiles: manifest.files,
    hostFiles: manifest.hostFiles, hostBasicArguments: manifest.hostBasicArguments, daemonArguments: manifest.daemonArguments,
    desktopArguments: manifest.desktopArguments, desktopSeccompSha256: manifest.desktopSeccompSha256, networkArguments: manifest.networkArguments,
  } };
assert.equal(fs.existsSync(output), false, 'Use a new evidence output directory.');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const file of Object.keys(job.artifacts)) fs.copyFileSync(path.join(resultDirectory, file), path.join(output, file));
fs.copyFileSync(manifestFile, path.join(output, 'manifest.json'));
fs.copyFileSync(path.join(resultDirectory, 'job.json'), path.join(output, 'job.json'));
const bytes = JSON.stringify(evidence, null, 2) + '\n';
fs.writeFileSync(path.join(output, 'evidence.json'), bytes, { mode: 0o600 });
fs.writeFileSync(path.join(output, 'evidence.json.sha256'), `${sha256(bytes)}  evidence.json\n`, { mode: 0o600 });
console.log(JSON.stringify({ image: manifest.hostImage, gate: evidence.gate, sha256: sha256(bytes),
  artifact: path.resolve(output, 'evidence.json'), approval: 'unreviewed' }));
