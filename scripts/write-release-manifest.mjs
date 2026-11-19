import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
function files(root, dir = '') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}
function inventory(root, excluded) {
  return Object.fromEntries(files(root).filter(file => !excluded.includes(file)).map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
}
let revision = process.env.SWARM_BUILD_REVISION || null;
if (!revision) {
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives may not have Git metadata. */ }
}
const frontend = inventory('web/dist', ['build.json']);
const server = inventory('server/dist', ['release-manifest.json']);
const build = { revision, builtAt: new Date().toISOString(), frontendSha256: hash(JSON.stringify(frontend)), serverSha256: hash(JSON.stringify(server)) };
fs.writeFileSync('web/dist/build.json', JSON.stringify(build, null, 2) + '\n');
frontend['build.json'] = hash(fs.readFileSync('web/dist/build.json'));
fs.writeFileSync('server/dist/release-manifest.json', JSON.stringify({ ...build, frontend, server }, null, 2) + '\n');
console.log(`Release manifest: ${revision ?? 'unversioned'} (${Object.keys(frontend).length} frontend files, ${Object.keys(server).length} server files)`);
