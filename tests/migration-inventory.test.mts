import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { inventoryLegacySource } from '../server/src/platform/migration-inventory.js';
import { migrationInventoryCommand } from '../server/src/platform/migration-inventory-cli.js';
import { prepareMigrationPackage } from '../server/src/platform/migration-package.js';

const tenant = 'usr_aaaaaaaa', other = 'usr_bbbbbbbb';
const sum = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceSnapshot = path.join(root, 'source.db'), filesRoot = path.join(root, 'files'), cliProfilesRoot = path.join(root, 'cli');
  const db = new Database(sourceSnapshot);
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));
    CREATE TABLE cli_runtimes(user_id TEXT PRIMARY KEY REFERENCES users(id),location TEXT);
    CREATE TABLE cli_pairings(user_id TEXT PRIMARY KEY REFERENCES users(id),token_hash TEXT);
    CREATE TABLE vms(vm_id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),volume_id TEXT);
    CREATE TABLE provision_jobs(user_id TEXT,vm_id TEXT,status TEXT,attempts INTEGER);
    INSERT INTO users VALUES('usr_aaaaaaaa'),('usr_bbbbbbbb');
    INSERT INTO bots VALUES('bot_a','usr_aaaaaaaa'),('hidden_a','usr_aaaaaaaa'),('bot_b','usr_bbbbbbbb');`);
  db.close();
  fs.mkdirSync(path.join(filesRoot, 'bot_a/empty'), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, 'bot_a/note'), 'private owner file');
  fs.mkdirSync(path.join(filesRoot, 'bot_b'), { recursive: true });
  // Foreign owned folders are not opened, even if they contain unsupported files.
  fs.symlinkSync('/unavailable', path.join(filesRoot, 'bot_b/unreadable'));
  fs.mkdirSync(path.join(cliProfilesRoot, sum(tenant), '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cliProfilesRoot, sum(tenant), '.codex/auth.json'), 'private subscription token');
  fs.mkdirSync(path.join(cliProfilesRoot, sum(tenant), '.local/share'), { recursive: true });
  fs.mkdirSync(path.join(cliProfilesRoot, sum(other)), { recursive: true });
  fs.symlinkSync('/unavailable', path.join(cliProfilesRoot, sum(other), '.codex'));
  const input = { tenant, sourceSnapshot, filesRoot, cliProfilesRoot };
  const edit = (fn: (db: Database.Database) => void) => { const db = new Database(sourceSnapshot); try { fn(db); } finally { db.close(); } };
  const desktop = () => {
    edit(db => db.prepare('INSERT INTO vms VALUES(?,?,?)').run('vm_owned', tenant, 'vol_owned'));
    const desktopSnapshot = path.join(root, 'desktop'); fs.mkdirSync(desktopSnapshot);
    fs.writeFileSync(path.join(desktopSnapshot, 'tenant-manifest.json'), JSON.stringify({ tenantId: tenant, volumeId: 'vol_owned' }));
    return desktopSnapshot;
  };
  return { root, input, edit, desktop };
}

test('inventory is bounded metadata, preserves hidden bots/empty directories and makes no freeze claim', async t => {
  const f = fixture(t), original = fs.readFileSync(f.input.sourceSnapshot), first = await inventoryLegacySource(f.input);
  assert.equal(first.requiresFileInventory, false); assert.equal(first.boundary, 'observed-files-only');
  assert.equal('writersStopped' in first, false); assert.equal('filesFrozen' in first, false); assert.equal('checkpoint' in first, false);
  assert.equal(first.inventoryHash, (await inventoryLegacySource(f.input)).inventoryHash);
  assert.deepEqual(first.bots, ['bot_a', 'hidden_a']);
  assert.ok(first.entries.some(e => e.destination === 'files/bot_a/empty' && e.kind === 'directory'));
  assert.ok(first.entries.some(e => e.destination === 'subscriptions/codex/.codex/auth.json' && e.sha256 === sum('private subscription token')));
  assert.ok(first.entries.every(e => !e.relative.includes('bot_b') && !e.relative.includes(sum(other))));
  assert.ok(!JSON.stringify(first).includes('private subscription token')); assert.ok(!JSON.stringify(first).includes('private owner file'));
  assert.deepEqual(fs.readFileSync(f.input.sourceSnapshot), original);
});

test('missing roots, unmapped bot folders and nonempty shared CLI homes require explicit reconciliation', async t => {
  const f = fixture(t);
  assert.equal((await inventoryLegacySource({ ...f.input, filesRoot: undefined })).issues[0].code, 'missing_files_root');
  assert.equal((await inventoryLegacySource({ ...f.input, cliProfilesRoot: undefined })).issues[0].code, 'missing_cli_profiles_root');
  fs.mkdirSync(path.join(f.input.filesRoot, 'orphan'));
  fs.writeFileSync(path.join(f.input.cliProfilesRoot, sum(tenant), '.local/share/unknown'), 'do not auto discard');
  const result = await inventoryLegacySource(f.input);
  assert.equal(result.requiresFileInventory, true);
  assert.deepEqual(result.issues.map(x => x.code), ['unmapped_bot_files', 'unmapped_profile_file']);
});

test('desktop snapshot requires exact owner/volume and reports unmapped paths at every supported level', async t => {
  const f = fixture(t), desktopSnapshot = f.desktop();
  assert.equal((await inventoryLegacySource(f.input)).issues[0].code, 'missing_desktop_snapshot');
  fs.mkdirSync(path.join(desktopSnapshot, '.swarm/playwright/bot_a'), { recursive: true });
  fs.writeFileSync(path.join(desktopSnapshot, '.swarm/playwright/bot_a/state'), 'browser state');
  const input = { ...f.input, desktopSnapshot };
  assert.equal((await inventoryLegacySource(input)).requiresFileInventory, false);
  fs.mkdirSync(path.join(desktopSnapshot, '.swarm/playwright/bot_b'), { recursive: true });
  fs.mkdirSync(path.join(desktopSnapshot, '.swarm/unknown'), { recursive: true });
  fs.mkdirSync(path.join(desktopSnapshot, 'Downloads'));
  assert.equal((await inventoryLegacySource(input)).issues.length, 3);
  fs.writeFileSync(path.join(desktopSnapshot, 'tenant-manifest.json'), JSON.stringify({ tenantId: other, volumeId: 'vol_owned' }));
  await assert.rejects(inventoryLegacySource(input), /ownership is unproven/);
});

test('remote CLI and uncertain orphan provider jobs are recorded without treating disconnects as shutdown', async t => {
  const f = fixture(t);
  f.edit(db => {
    db.prepare('INSERT INTO cli_pairings VALUES(?,?)').run(tenant, 'secret-pairing-hash');
    db.prepare('INSERT INTO provision_jobs VALUES(?,?,?,?)').run(tenant, 'unknown_vm', 'running', 1);
  });
  const inventory = await inventoryLegacySource(f.input);
  assert.equal(inventory.cliRuntime, 'bridge'); assert.equal(inventory.pendingProviderOperations, 1);
  assert.ok(inventory.requiredHostEvidence.includes('remote-cli-shutdown-or-explicit-exclusion'));
  assert.ok(!JSON.stringify(inventory).includes('secret-pairing-hash'));
});

for (const type of ['dangling', 'ancestor', 'hardlink', 'fifo', 'root-symlink', 'database-symlink'] as const) test(`source ${type} is rejected before it can supply package bytes`, async t => {
  const f = fixture(t), location = path.join(f.input.filesRoot, 'bot_a');
  if (type === 'dangling') fs.symlinkSync('/missing', path.join(location, 'dangling'));
  if (type === 'ancestor') { fs.rmSync(path.join(f.input.cliProfilesRoot, sum(tenant)), { recursive: true }); fs.symlinkSync(path.join(f.input.cliProfilesRoot, sum(other)), path.join(f.input.cliProfilesRoot, sum(tenant))); }
  if (type === 'hardlink') fs.linkSync(path.join(location, 'note'), path.join(location, 'hardlink'));
  if (type === 'fifo') assert.equal(spawnSync('mkfifo', [path.join(location, 'fifo')]).status, 0);
  if (type === 'root-symlink') { const link = path.join(f.root, 'link'); fs.symlinkSync(f.input.filesRoot, link); f.input.filesRoot = link; }
  if (type === 'database-symlink') { const link = path.join(f.root, 'link'); fs.symlinkSync(f.input.sourceSnapshot, link); f.input.sourceSnapshot = link; }
  await assert.rejects(inventoryLegacySource(f.input), /symlink|hardlink|canonical|unsupported/);
});

for (const suffix of ['-wal', '-shm', '-journal']) test(`database ${suffix} prevents snapshot admission, including dangling links`, async t => {
  const f = fixture(t); fs.symlinkSync('/missing', `${f.input.sourceSnapshot}${suffix}`);
  await assert.rejects(inventoryLegacySource(f.input), /checkpointed database/);
});

test('a checkpointed WAL-format DB is rejected without creating read-side WAL/SHM files', async t => {
  const f = fixture(t); f.edit(db => { db.pragma('journal_mode=WAL'); });
  const before = fs.readFileSync(f.input.sourceSnapshot);
  await assert.rejects(inventoryLegacySource(f.input), /rollback-format/);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(f.input.sourceSnapshot + suffix), false);
  assert.deepEqual(fs.readFileSync(f.input.sourceSnapshot), before);
});

test('overlapping roots, excessive nesting and oversized sparse files are rejected', async t => {
  const f = fixture(t);
  await assert.rejects(inventoryLegacySource({ ...f.input, cliProfilesRoot: f.input.filesRoot }), /overlap/);
  const deep = path.join(f.input.filesRoot, 'bot_a', ...Array(66).fill('x')); fs.mkdirSync(deep, { recursive: true });
  await assert.rejects(inventoryLegacySource(f.input), /depth/);
  fs.rmSync(path.join(f.input.filesRoot, 'bot_a/x'), { recursive: true });
  const huge = path.join(f.input.filesRoot, 'bot_a/huge'); fs.closeSync(fs.openSync(huge, 'w')); fs.truncateSync(huge, 13 * 1024 ** 3);
  await assert.rejects(inventoryLegacySource(f.input), /bounds/);
});

test('reviewed inventory binding rejects changed files or roots before publishing a package', async t => {
  const f = fixture(t), review = await inventoryLegacySource(f.input), key = randomBytes(32);
  t.after(() => key.fill(0));
  const input = { ...f.input, destination: path.join(f.root, 'package'), sourceSessionSecret: 'test-secret', targetKey: key, volume: 'vol_new', reviewedInventoryHash: review.inventoryHash };
  const receipt = await prepareMigrationPackage(input);
  assert.equal(receipt.requiresFileInventory, false); assert.equal(receipt.sourceInventoryHash, review.inventoryHash);
  assert.ok(fs.statSync(path.join(input.destination, 'files/bot_a/empty')).isDirectory());
  fs.writeFileSync(path.join(f.input.filesRoot, 'bot_a/note'), 'different source');
  const destination = path.join(f.root, 'changed');
  await assert.rejects(prepareMigrationPackage({ ...input, destination }), /reviewed source inventory changed/);
  assert.equal(fs.existsSync(destination), false);
});

for (const change of ['added-file', 'removed-empty-directory', 'changed-credential'] as const) test(`a ${change} during package copy prevents publication`, async t => {
  const f = fixture(t), key = randomBytes(32), destination = path.join(f.root, 'package');
  const write = fs.createWriteStream; let altered = false;
  fs.createWriteStream = ((...args: Parameters<typeof write>) => {
    if (!altered) {
      altered = true;
      if (change === 'added-file') fs.writeFileSync(path.join(f.input.filesRoot, 'bot_a/late'), 'late file');
      if (change === 'removed-empty-directory') fs.rmdirSync(path.join(f.input.filesRoot, 'bot_a/empty'));
      if (change === 'changed-credential') fs.writeFileSync(path.join(f.input.cliProfilesRoot, sum(tenant), '.codex/auth.json'), 'replaced credential');
    }
    return write(...args);
  }) as typeof write;
  try {
    await assert.rejects(prepareMigrationPackage({ ...f.input, destination, sourceSessionSecret: 'test-secret', targetKey: key, volume: 'vol_new' }), /changed during migration/);
    assert.equal(fs.existsSync(destination), false); assert.equal(fs.readdirSync(f.root).some(p => p.includes('.preparing-')), false);
  } finally { fs.createWriteStream = write; key.fill(0); }
});

test('offline operator report is private, exclusive and explicitly declares unverified host inputs', async t => {
  const f = fixture(t), output = path.join(f.root, 'report.json');
  const args = ['inventory', '--tenant', tenant, '--snapshot', f.input.sourceSnapshot, '--files-root', f.input.filesRoot, '--cli-profiles-root', f.input.cliProfilesRoot, '--source-image', `registry.example/legacy@sha256:${'a'.repeat(64)}`, '--source-host', 'legacy_app/legacy_machine', '--source-volume', 'vol_legacy', '--output', output];
  const result = await migrationInventoryCommand(args), report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.declaredSource.verified, false); assert.equal(result.sourceMutated, false); assert.equal(result.routingChanged, false);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  await assert.rejects(migrationInventoryCommand(args), /EEXIST/);
  await assert.rejects(migrationInventoryCommand([...args, '--freeze', 'true']), /Invalid inventory options/);
  await assert.rejects(migrationInventoryCommand(args.map(x => x.startsWith('registry.example') ? 'registry.example/legacy:latest' : x)), /immutable source image/);
  const publicDir = path.join(f.root, 'public'); fs.mkdirSync(publicDir, { mode: 0o755 });
  await assert.rejects(migrationInventoryCommand(args.map(x => x === output ? path.join(publicDir, 'report.json') : x)), /private maintenance/);
  fs.chmodSync(f.input.filesRoot,0o700);
  const sourceOutput=path.join(f.input.filesRoot,'report.json');
  await assert.rejects(migrationInventoryCommand(args.map(x => x === output ? sourceOutput : x)), /outside source roots/);
  assert.equal(fs.existsSync(sourceOutput),false);
});
