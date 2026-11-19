import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const run = args => execFileSync('flyctl', [...args, '-a', 'swarm-team'], { encoding: 'utf8', timeout: 60000 });
const volumes = JSON.parse(run(['volumes', 'list', '--json'])).filter(v => v.name === 'swarm_data' && v.attached_machine_id);
assert.equal(volumes.length, 1, 'Expected the existing single staging data volume');
const volume = volumes[0].id;
const list = () => JSON.parse(run(['volumes', 'snapshots', 'list', volume, '--json']));
const previous = new Set(list().map(s => s.id));
run(['volumes', 'snapshots', 'create', volume]);
let snapshot;
for (let attempt = 0; attempt < 60; attempt++) {
  snapshot = list().find(s => !previous.has(s.id) && s.status === 'created');
  if (snapshot) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
assert.ok(snapshot, 'Volume snapshot did not complete; deployment stopped');
fs.mkdirSync('.context/staging-release', { recursive: true });
fs.writeFileSync('.context/staging-release/volume-snapshot.json', JSON.stringify({ volume, snapshot }, null, 2));
console.log(`Backup completed: ${snapshot.id}`);
