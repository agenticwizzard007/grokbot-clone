import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const [origin, manifestPath = 'server/dist/release-manifest.json'] = process.argv.slice(2);
assert.ok(origin, 'Usage: node scripts/verify-deployment.mjs https://app.example manifest.json');
const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.match(expected.revision ?? '', /^[a-f0-9]{40}$/, 'Expected a committed release revision');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function get(route) {
  const response = await fetch(new URL(route, origin), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return response;
}
const health = await (await get('/api/health')).json();
assert.equal(health.ok, true);
const version = await (await get('/api/version')).json();
for (const key of ['revision', 'builtAt', 'frontendSha256', 'serverSha256']) assert.equal(version[key], expected[key], `Backend ${key} differs from expected build`);
const queue = Object.entries(expected.frontend), verified = [], bundles = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const [file, digest] = queue.shift();
    const response = await get('/' + file);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), digest, `Published file differs: ${file}`);
    if (file === 'index.html' || file === 'build.json') assert.match(response.headers.get('cache-control') ?? '', /no-cache|no-store/, `${file} must revalidate`);
    if (file.endsWith('.js')) bundles.push(bytes.toString());
    verified.push(file);
  }
}));
const source = bundles.join('\n');
for (const marker of ['Goals and workflows', '/learning/settings', '/team/state', 'Automatic improvement policy', 'Daily synopses']) assert.ok(source.includes(marker), `Missing released feature: ${marker}`);
for (const route of ['/api/learning/settings', '/api/workflows', '/api/team/state', '/api/checkins/reports']) {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 401, `${route} must exist and require authentication`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${route} returned a frontend fallback`);
}
console.log(JSON.stringify({ verified: true, origin, revision: expected.revision, frontendFiles: verified.length, featuresPresent: true, authenticatedRoutes: true }, null, 2));
