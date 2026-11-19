// Run inside the built container with node --input-type=module on stdin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.env.RELEASE_ROOT || '/app';
const expected = process.env.EXPECTED_REVISION;
assert.match(expected ?? '', /^[a-f0-9]{40}$/, 'Expected source revision is required');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'server/dist/release-manifest.json'), 'utf8'));
assert.equal(manifest.revision, expected);
const counts = {};
for (const [group, dir] of [['frontend', 'web/dist'], ['server', 'server/dist']]) {
  const directory = path.resolve(root, dir);
  const entries = Object.entries(manifest[group]);
  assert.ok(entries.length > 0, `Empty ${group} build`);
  for (const [file, digest] of entries) {
    const resolved = path.resolve(directory, file);
    assert.ok(resolved.startsWith(directory + path.sep), 'Invalid manifest path');
    assert.equal(createHash('sha256').update(fs.readFileSync(resolved)).digest('hex'), digest, `Image file differs: ${group}/${file}`);
  }
  counts[group] = entries.length;
}
console.log(JSON.stringify({ verified: true, revision: expected, ...counts }, null, 2));
