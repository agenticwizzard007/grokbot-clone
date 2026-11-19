import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Fly reports the platform manifest digest, not an OCI index/attestation digest. */
export function runtimeImage(reference, manifest) {
  assert.match(reference, /^registry\.fly\.io\/swarm-team@sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.schemaVersion, 2, 'Unsupported registry manifest');
  if (Array.isArray(manifest.manifests)) {
    const images = manifest.manifests.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
    assert.equal(images.length, 1, 'Expected exactly one Linux amd64 image, excluding attestations');
    assert.match(images[0].digest, /^sha256:[a-f0-9]{64}$/);
    return `registry.fly.io/swarm-team@${images[0].digest}`;
  }
  assert.ok(manifest.config?.digest && Array.isArray(manifest.layers), 'Registry response is not an image manifest');
  return reference;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , reference, file] = process.argv;
  console.log(runtimeImage(reference, JSON.parse(fs.readFileSync(file, 'utf8'))));
}
