import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Copy only the locked test-loader graph, not the app dependency tree. The
// graph is exercised by a real packaged-loader test without running Docker.
export function copyLoaderPackages(repo, bundle) {
  const packages = new Map();
  function includePackage(name, from) {
    const require = createRequire(from);
    let location;
    try { location = require.resolve(`${name}/package.json`); }
    catch {
      let directory = path.dirname(require.resolve(name));
      while (!fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).name !== name) {
        assert.notEqual(directory, path.dirname(directory)); directory = path.dirname(directory);
      }
      location = path.join(directory, 'package.json');
    }
    const pkg = JSON.parse(fs.readFileSync(location));
    if (packages.has(name)) { assert.equal(packages.get(name), pkg.version, 'Conflicting loader dependency versions.'); return; }
    packages.set(name, pkg.version);
    fs.cpSync(path.dirname(location), path.join(bundle, 'node_modules', name), { recursive: true, dereference: true });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) includePackage(dependency, location);
    if (name === 'esbuild') includePackage('@esbuild/linux-x64', location);
  }
  for (const name of ['tsx', 'zod']) includePackage(name, path.join(repo, 'server/package.json'));
  return Object.fromEntries(packages);
}
