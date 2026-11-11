// This suite must use a disposable PostgreSQL database; missing prerequisites fail
// instead of silently skipping the ownership/lifecycle integration tests.
import { spawnSync } from 'node:child_process';
if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required (disposable PostgreSQL only).');
  process.exit(1);
}
const files = [
  'isolation-security', 'gateway-isolation', 'platform-directory', 'platform-lifecycle', 'platform-tunnel', 'host-preflight', 'runtime-refresh', 'runtime-operations',
  'platform-messaging', 'platform-messaging-dispatch', 'platform-signup', 'platform-native-auth', 'tenant-sessions', 'session-notifications',
  'backup-lifecycle', 'backup-storage', 'backup-upload', 'storage-recovery', 'host-installation', 'environment-operations', 'legacy-database-fence', 'legacy-background', 'migration-package', 'migration-destination', 'migration-transfer', 'migration-coordinator', 'migration-import', 'runtime-event-delivery',
  'google-auth', 'apple-auth', 'openrouter', 'native-auth', 'native-computer', 'rename-compat',
  'mcp', 'mcp-folders', 'composio', 'messaging',
];
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.map(name => `tests/${name}.test.mts`)], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
