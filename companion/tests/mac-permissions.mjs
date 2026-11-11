// Read-only native API smoke. Safe to run before granting Swarm any TCC permissions:
// no screenshots, clicks, keyboard input, clipboard changes, or permission prompts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MAC_PERMISSION_PROBE, MAC_SCREEN_PROBE } from '../swarm-companion.mjs';
if (process.platform !== 'darwin') {
  console.error('This read-only JXA binding check requires macOS.');
  process.exit(2);
}
for (const [name, source] of Object.entries({ permissions: MAC_PERMISSION_PROBE, screen: MAC_SCREEN_PROBE })) {
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(typeof value.screen, 'boolean', `${name}: screen binding unavailable`);
  if (name === 'permissions') assert.equal(typeof value.accessibility, 'boolean', 'Accessibility binding unavailable');
  console.log(JSON.stringify({ probe: name, ...value }));
}
console.log('PASS native bindings. Permission booleans belong to the launching app; false is valid.');
