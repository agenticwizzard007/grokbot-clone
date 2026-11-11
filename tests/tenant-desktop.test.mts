import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/tenant-desktop.mts', import.meta.url));
const cases = [
  'tenant-welcome', 'tenant-invalid-token', 'tenant-foreign-token', 'tenant-wrong-mode',
  'tenant-disconnect', 'tenant-replacement', 'tenant-revocation', 'tenant-other-pairing',
  'tenant-native-mac', 'tenant-real-companion', 'host-success', 'host-missing', 'host-rejected',
  'host-disconnect-during-policy', 'host-policy-hold', 'host-database-owner', 'host-backup-hold',
  'host-response-validation', 'standalone-local', 'standalone-desktop', 'standalone-cloudvm', 'tenant-cloudvm-refused',
];
for (const scenario of cases) test(`desktop protocol/readiness: ${scenario}`, { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = await execute(process.execPath, ['--import', 'tsx', fixture, scenario], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.match(result.stdout, new RegExp(`SCENARIO_PASS ${scenario}`));
});
