import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const sidecars = ['-wal', '-shm', '-journal'];
function requireOfflineSnapshot(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Use a regular, offline SQLite backup file.');
  if (sidecars.some(suffix => fs.existsSync(file + suffix))) {
    throw new Error('Journal/SHM sidecars found. Inspect a complete offline SQLite backup, not a live database or a copied main file.');
  }
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Bounded to the knowledge downgrade contract, never a release approval.
 * No application imports, migrations, SQL writes, or access to live services.
 * SQLite opens a private copy so even WAL bookkeeping cannot touch the source.
 */
export async function checkKnowledgeRollback(snapshot) {
  const source = path.resolve(snapshot);
  requireOfflineSnapshot(source);
  const before = fs.statSync(source, { bigint: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-knowledge-rollback-'));
  let database;
  try {
    const copy = path.join(temporary, 'snapshot.db');
    fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(copy, 0o600);
    const snapshotSha256 = await sha256(copy);
    requireOfflineSnapshot(source);
    const after = fs.statSync(source, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || snapshotSha256 !== await sha256(source)) {
      throw new Error('Snapshot changed during inspection; stop writers and make a consistent backup.');
    }
    database = new Database(copy, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed.');
    const columns = table => database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const table of ['users', 'bots', 'skills', 'memories']) {
      if (!columns(table).includes('id')) throw new Error('Not a recognized application SQLite snapshot.');
    }
    const knowledgeObjects = database.prepare("SELECT type,name FROM sqlite_schema WHERE substr(name,1,10)='knowledge_' ORDER BY type,name").all();
    const skillColumns = columns('skills').filter(c => ['revision', 'deleted_at', 'lifecycle'].includes(c));
    const memoryColumns = columns('memories').filter(c => ['status', 'revision', 'supersedes', 'superseded_revision'].includes(c));
    const incompatible = knowledgeObjects.length > 0 || skillColumns.length > 0 || memoryColumns.length > 0;
    return {
      targetContract: 'pre-hermes', snapshotSha256,
      status: incompatible ? 'incompatible' : 'no-knowledge-schema-detected',
      rollbackApproved: false,
      knowledgeObjects, skillColumns, memoryColumns,
      reason: incompatible
        ? 'Forward-only knowledge schema: old code cannot enforce soft deletion, correction, suppression or immutable history. Use a compatible forward repair or a separately rehearsed pre-upgrade backup restore.'
        : 'No knowledge-specific downgrade blocker detected. This is not approval of the target image, other schemas, files, credentials or external-effect recovery.',
    };
  } finally {
    database?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-knowledge-rollback.mjs <offline-snapshot.db>');
    const report = await checkKnowledgeRollback(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'incompatible' ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: 'inspection-failed', rollbackApproved: false, error: error.message }));
    process.exitCode = 1;
  }
}
