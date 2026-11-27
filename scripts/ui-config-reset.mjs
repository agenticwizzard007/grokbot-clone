#!/usr/bin/env node
// Trusted offline repair: DB_PATH must name the intended local database.
import fs from 'node:fs';
import { register } from 'tsx/esm/api';
import Database from 'better-sqlite3';
register();
const email = process.argv[2], databasePath = process.env.DB_PATH;
if (!email || process.argv.length !== 3 || !databasePath || !fs.existsSync(databasePath)) {
  console.error('Usage: DB_PATH=/path/to/app.db node scripts/ui-config-reset.mjs <user email>');
  process.exitCode = 1;
} else {
  const { SqliteUiConfigService } = await import('../server/src/ui/service.ts');
  const db = new Database(databasePath, { fileMustExist: true }); db.pragma('foreign_keys=ON');
  try {
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!user) throw new Error('Account not found.');
    // Operator recovery remains available when customization is disabled.
    class RepairService extends SqliteUiConfigService { enabled() { return true; } }
    const service = new RepairService(db, { metrics: () => {} });
    const preview = service.reset(user.id, 'all');
    if (!preview.ok) throw new Error(preview.errors[0].message);
    const result = service.applyPreview(user.id, preview.previewId, 'reset');
    if (!result.ok) throw new Error(result.errors[0].message);
    console.log(JSON.stringify({ ok: true, revision: result.revision, historyRetained: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { db.close(); }
}
