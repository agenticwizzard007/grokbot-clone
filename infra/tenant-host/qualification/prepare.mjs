#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { alpine, immutableImage, imageProvenance, machineDefinition, sha256 } from './policy.mjs';
import { assertDefaultWorkloadPolicy, daemonArguments, desktopArguments, hostBasicArguments, networkArguments } from './source-policy.mjs';
import { copyLoaderPackages } from './bundle.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [image, provenanceFile, output] = process.argv.slice(2);
assert.ok(output, 'Usage: node infra/tenant-host/qualification/prepare.mjs <host-image@sha256:...> <published-images.json> <new-output-directory>');
immutableImage(image);
const provenance = imageProvenance(JSON.parse(fs.readFileSync(provenanceFile)), image);
const hostSource = fs.readFileSync(path.join(repo, 'server/src/runtime/host.ts'), 'utf8');
const desktopFlags = desktopArguments(hostSource);
assertDefaultWorkloadPolicy(fs.readFileSync(path.join(repo, 'server/src/runtime/container-policy.ts'), 'utf8'), hostBasicArguments(hostSource));
assert.equal(process.platform, 'linux', 'Prepare the Linux x64 tool bundle on Linux x64.');
assert.equal(process.arch, 'x64');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '', 'Commit reviewed sources before preparing evidence.');
const sourceRevision = git(['rev-parse', 'HEAD']);
const out = path.resolve(output);
assert.equal(fs.existsSync(out), false, 'Use a new output directory.');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const bundle = path.join(out, 'bundle');
fs.mkdirSync(bundle);
const sourceFiles = ['tests/container-containment.test.mts', 'server/src/runtime/container-policy.ts',
  'server/src/runtime/mcp-folders.ts', 'server/src/security/mcp-folders.ts', 'server/src/runtime/host.ts',
  'server/src/runtime/host-preflight.ts', 'infra/tenant-host/entrypoint.sh', 'infra/tenant-host/firewall.sh',
  'infra/tenant-host/chromium-seccomp.json', 'package-lock.json'];
const jobFiles = ['job.mjs', 'desktop-check.mjs', 'policy.mjs', 'reporter.mjs'];
function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
for (const file of sourceFiles) copy(path.join(repo, file), path.join(bundle, file));
for (const file of jobFiles) copy(fileURLToPath(new URL(file, import.meta.url)), path.join(bundle, file));
fs.writeFileSync(path.join(bundle, 'package.json'), '{"private":true,"type":"module"}\n');

const packages = copyLoaderPackages(repo, bundle);

execFileSync('npm', ['run', 'build', '-w', 'server'], { cwd: repo, stdio: 'inherit' });
const { containerArguments } = await import(path.join(repo, 'server/dist/runtime/container-policy.js'));
const mcpArguments = containerArguments({ tenantId: 'usr_containment', root: '/run/swarm-host/qualification-fixtures',
  runnerImage: provenance.components.app, mcpImage: provenance.components.app, network: 'swarm-public' },
  { kind: 'mcp', id: 'mcp_containment' }, 'swarm-00000000-0000-0000-0000-000000000000');
const hostFiles = Object.fromEntries(['runtime/host.js', 'runtime/container-policy.js', 'runtime/mcp-folders.js',
  'runtime/host-preflight.js', 'security/mcp-folders.js'].map(file =>
  [`/app/server/dist/${file}`, sha256(fs.readFileSync(path.join(repo, 'server/dist', file)))]));
hostFiles['/opt/swarm/entrypoint.sh'] = sha256(fs.readFileSync(path.join(repo, 'infra/tenant-host/entrypoint.sh')));
for (const file of ['firewall.sh', 'chromium-seccomp.json']) hostFiles[`/opt/swarm/${file}`] = sha256(fs.readFileSync(path.join(repo, 'infra/tenant-host', file)));

function allFiles(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Qualification bundle must not contain symlinks.');
    return entry.isDirectory() ? allFiles(directory, name) : [name];
  }).sort();
}
const manifest = {
  schemaVersion: 1, gate: 'nested-container-containment', hostImage: image, sourceRevision, alpine, imageProvenance: provenance,
  scope: 'single-Fly-VM workload and scoped-desktop policy plus synthetic private/metadata/firewall probes; not two-tenant networking or full application compromise',
  desktopArguments: desktopFlags, desktopSeccompSha256: hostFiles['/opt/swarm/chromium-seccomp.json'],
  networkArguments: networkArguments(fs.readFileSync(path.join(repo, 'infra/tenant-host/entrypoint.sh'), 'utf8')),
  mcpArguments,
  hostFiles,
  hostBasicArguments: hostBasicArguments(fs.readFileSync(path.join(repo, 'server/src/runtime/host.ts'), 'utf8')),
  daemonArguments: daemonArguments(fs.readFileSync(path.join(repo, 'infra/tenant-host/entrypoint.sh'), 'utf8')),
  packages,
  files: Object.fromEntries(allFiles(bundle).map(file => [file, sha256(fs.readFileSync(path.join(bundle, file)))])),
};
const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
const manifestHash = sha256(manifestBytes);
fs.writeFileSync(path.join(bundle, 'manifest.json'), manifestBytes);
fs.writeFileSync(path.join(out, 'manifest.json'), manifestBytes);
fs.writeFileSync(path.join(out, 'machine.json'), JSON.stringify(machineDefinition(image, manifestHash, sourceRevision), null, 2) + '\n');
execFileSync('tar', ['-czf', path.join(out, 'bundle.tgz'), '-C', bundle, '.']);
fs.writeFileSync(path.join(out, 'bundle.tgz.sha256'), `${sha256(fs.readFileSync(path.join(out, 'bundle.tgz')))}  bundle.tgz\n`);
console.log(`Prepared ${out}. No Machine created. Manifest SHA-256: ${manifestHash}`);
