#!/usr/bin/env node
// Explicit packaging step. Normal Xcode builds and native tests never download anything.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = process.argv.slice(2);
const value = (name, fallback) => {
  const index = options.indexOf(name);
  if (index < 0) return fallback;
  if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return options[index + 1];
};
const selected = value('--arch', 'universal');
if (!['arm64', 'x64', 'universal'].includes(selected)) throw new Error('Architecture must be arm64, x64, or universal.');
if (options.some((option) => option.startsWith('--') && !['--arch', '--output', '--cache', '--offline', '--check'].includes(option))) throw new Error('Unknown packaging option.');
const architectures = selected === 'universal' ? ['arm64', 'x64'] : [selected];
const output = path.resolve(value('--output', path.join(repo, 'apple/build/MacControlPayload')));
const cache = path.resolve(value('--cache', path.join(repo, 'apple/build/runtime-cache')));
const offline = options.includes('--offline');
const digest = (data) => createHash('sha256').update(data).digest('hex');
const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const source = path.join(repo, 'apple/MacControl');
const pins = await readJSON(path.join(source, 'node-runtimes.json'));
const companion = path.join(repo, 'companion/swarm-companion.mjs');
const lockHash = digest(await fs.readFile(path.join(source, 'package-lock.json')));
const companionHash = digest(await fs.readFile(companion));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_audit: 'false', npm_config_fund: 'false' } });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Install packaging prerequisites and retry.`);
}
async function check() {
  const manifest = await readJSON(path.join(output, 'manifest.json'));
  if (manifest.node !== pins.version || manifest.lockSHA256 !== lockHash || manifest.companionSHA256 !== companionHash) throw new Error('Staged payload is stale. Run the stage command again. Cached archives are reused.');
  for (const arch of architectures) {
    if (manifest.architectures?.[arch]?.archiveSHA256 !== pins.architectures[arch].sha256) throw new Error(`Missing pinned ${arch} runtime. Stage it first.`);
    const nodeHash = digest(await fs.readFile(path.join(output, arch, 'node')));
    if (nodeHash !== manifest.architectures[arch].nodeSHA256) throw new Error(`The staged ${arch} Node runtime was modified. Stage again before building.`);
  }
  if (digest(await fs.readFile(path.join(output, 'companion/swarm-companion.mjs'))) !== companionHash) throw new Error('The staged companion was modified. Stage it again.');
  await fs.access(path.join(output, 'playwright/node_modules/@playwright/mcp/cli.js'));
  const installed = await readJSON(path.join(output, 'playwright/node_modules/@playwright/mcp/package.json'));
  const expected = await readJSON(path.join(source, 'package.json'));
  if (installed.version !== expected.dependencies['@playwright/mcp']) throw new Error('Staged Playwright MCP does not match its pin.');
  console.log(`Mac control payload verified (${architectures.join(', ')}; Node ${pins.version}; MCP ${installed.version}).`);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Packaging requires Node 22 or newer. The installed app uses its own bundled runtime.');
  if (options.includes('--check')) {
    await check();
  } else {
    // Stage into a sibling and publish only after all downloads, integrity checks and npm ci pass.
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(cache, { recursive: true });
    const temporary = await fs.mkdtemp(`${output}.staging-`);
    try {
      const manifest = { node: pins.version, lockSHA256: lockHash, companionSHA256: companionHash, architectures: {} };
      for (const arch of architectures) {
        const pin = pins.architectures[arch];
        const archive = path.join(cache, pin.archive);
        let bytes;
        try { bytes = await fs.readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (bytes && digest(bytes) !== pin.sha256) throw new Error(`Cached ${pin.archive} failed SHA-256 verification. Remove that cache file and retry.`);
        if (!bytes) {
          if (offline) throw new Error(`Offline cache is missing ${pin.archive}. Run stage once online.`);
          const url = `https://nodejs.org/dist/v${pins.version}/${pin.archive}`;
          console.log(`Downloading official Node ${pins.version} for ${arch}.`);
          const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
          if (!response.ok) throw new Error(`Official Node download failed (HTTP ${response.status}).`);
          bytes = Buffer.from(await response.arrayBuffer());
          if (digest(bytes) !== pin.sha256) throw new Error(`Official ${pin.archive} failed the committed SHA-256 pin. Nothing was staged.`);
          await fs.writeFile(archive, bytes, { flag: 'wx' });
        }
        const extracted = path.join(temporary, `extract-${arch}`);
        await fs.mkdir(extracted);
        run('tar', ['-xzf', archive, '-C', extracted], repo);
        const unpacked = path.join(extracted, pin.archive.replace(/\.tar\.gz$/, ''));
        const destination = path.join(temporary, arch);
        await fs.mkdir(destination);
        await fs.copyFile(path.join(unpacked, 'bin/node'), path.join(destination, 'node'));
        await fs.chmod(path.join(destination, 'node'), 0o755);
        await fs.copyFile(path.join(unpacked, 'LICENSE'), path.join(destination, 'NODE-LICENSE'));
        manifest.architectures[arch] = { archiveSHA256: pin.sha256, nodeSHA256: digest(await fs.readFile(path.join(destination, 'node'))) };
        await fs.rm(extracted, { recursive: true });
      }
      const dependencies = path.join(temporary, 'playwright');
      await fs.mkdir(dependencies);
      await fs.copyFile(path.join(source, 'package.json'), path.join(dependencies, 'package.json'));
      await fs.copyFile(path.join(source, 'package-lock.json'), path.join(dependencies, 'package-lock.json'));
      run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], dependencies);
      await fs.mkdir(path.join(temporary, 'companion'));
      await fs.copyFile(companion, path.join(temporary, 'companion/swarm-companion.mjs'));
      await fs.copyFile(path.join(repo, 'LICENSE'), path.join(temporary, 'SWARM-LICENSE'));
      await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      // Never overwrite an arbitrary directory supplied by the caller.
      try {
        await fs.access(output);
        await fs.access(path.join(output, 'manifest.json'));
        await fs.rm(output, { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await fs.access(output); throw new Error('Output directory exists without a payload manifest. Choose an empty path.'); }
        catch (nested) { if (nested.code !== 'ENOENT') throw nested; }
      }
      await fs.rename(temporary, output);
      await check();
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
} catch (error) {
  console.error(`Mac runtime staging failed: ${error.message}`);
  process.exitCode = 1;
}
