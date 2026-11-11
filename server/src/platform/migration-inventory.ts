/** Trusted, offline inspection. This observes supplied files; it does not fence
 * a live source, discover all writer hosts or issue a SourceCheckpoint. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { validateArchiveEntry } from '../security/files.js';

export interface LegacyInventoryInput {
  tenant: string;
  sourceSnapshot: string;
  filesRoot?: string;
  cliProfilesRoot?: string;
  desktopSnapshot?: string;
}
export interface LegacyInventoryEntry {
  root: 'filesRoot' | 'cliProfilesRoot' | 'desktopSnapshot';
  relative: string;
  destination: string;
  source: 'bot-files' | 'claude' | 'codex' | 'desktop';
  kind: 'file' | 'directory';
  bytes: number;
  sha256?: string;
}
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_ENTRIES = 100000, MAX_BYTES = 12 * 1024 ** 3, MAX_DEPTH = 64;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } };
const unchanged = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function canonical(file: string, directory: boolean) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || fs.realpathSync(file) !== file) throw new Error('Source directory or file must be canonical without symlinks.');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('Invalid migration source type or hardlink.');
  return stat;
}
/** Descriptor-relative traversal refuses every ancestor symlink, including a
 * dangling one. It never opens a FIFO/device and never follows a swapped parent. */
export function openInventoryPath(root: string, relative: string, directory: boolean) {
  canonical(root, true); validateArchiveEntry(relative);
  if (relative.split('/').some(p => !p || p === '.')) throw new Error('Invalid inventory path.');
  let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const target = `/proc/self/fd/${fd}/${parts[i]}`, last = i === parts.length - 1;
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink() || (last && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw new Error('Migration symlink, hardlink or unsupported file type.');
      const next = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (!last || directory ? fs.constants.O_DIRECTORY : 0));
      fs.closeSync(fd); fd = next;
      if (!unchanged(info, fs.fstatSync(fd))) throw new Error('Migration source changed while opening.');
    }
    if (fs.realpathSync(`/proc/self/fd/${fd}`) !== path.join(root, relative)) throw new Error('Source directory changed during migration.');
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
async function digestFile(fd: number) {
  const before = fs.fstatSync(fd), digest = createHash('sha256'); let bytes = 0;
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error('Invalid or oversized source file.');
  for await (const chunk of fs.createReadStream('', { fd, autoClose: false, start: 0 })) {
    bytes += chunk.length;
    if (bytes > before.size) throw new Error('Source file changed during inventory.');
    digest.update(chunk);
  }
  if (bytes !== before.size || !unchanged(before, fs.fstatSync(fd))) throw new Error('Source file changed during inventory.');
  return { bytes, sha256: digest.digest('hex') };
}

export async function inventoryLegacySource(input: LegacyInventoryInput) {
  if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(input.tenant)) throw new Error('Invalid legacy owner.');
  const snapshotStat = canonical(input.sourceSnapshot, false);
  const sidecars = () => ['-wal', '-shm', '-journal'].some(s => exists(`${input.sourceSnapshot}${s}`));
  if (sidecars()) throw new Error('Use a stopped, checkpointed database snapshot without sidecars.');
  const fd = fs.openSync(input.sourceSnapshot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let snapshot: { bytes: number; sha256: string };
  try {
    // A read-only SQLite connection can create WAL/SHM files for a WAL-mode DB.
    // Require a standalone rollback-format snapshot before opening SQLite; never
    // change a source's journal mode as part of this read-only inspection.
    const header = Buffer.alloc(20);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) throw new Error('Use an offline rollback-format SQLite snapshot, not a WAL database.');
    snapshot = await digestFile(fd);
  } finally { fs.closeSync(fd); }
  const db = new Database(input.sourceSnapshot, { readonly: true, fileMustExist: true });
  const table = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  let bots: string[], knownBots: Set<string>, volume: string | null = null, cliRuntime = 'server', pendingProviderOperations = 0;
  try {
    if (table('tenant_identity') || !db.prepare('SELECT 1 FROM users WHERE id=?').get(input.tenant)) throw new Error('Legacy source owner is absent or already isolated.');
    const rows = table('bots') ? db.prepare('SELECT id,user_id FROM bots ORDER BY id').all() as { id: string; user_id: string }[] : [];
    if (rows.some(row => !ID.test(row.id) || typeof row.user_id !== 'string')) throw new Error('Unsafe or unowned legacy bot.');
    bots = rows.filter(row => row.user_id === input.tenant).map(row => row.id); knownBots = new Set(rows.map(row => row.id));
    let vmId = '';
    if (table('vms')) {
      const machines = db.prepare('SELECT vm_id,volume_id FROM vms WHERE user_id=?').all(input.tenant) as { vm_id: string; volume_id: string | null }[];
      if (machines.length > 1 || machines.some(m => !ID.test(m.vm_id) || !m.volume_id || !ID.test(m.volume_id))) throw new Error('Legacy desktop ownership or volume requires reconciliation.');
      volume = machines[0]?.volume_id ?? null;
      vmId = machines[0]?.vm_id ?? '';
    }
    if (table('provision_jobs')) pendingProviderOperations = Number((db.prepare("SELECT count(*) n FROM provision_jobs WHERE (user_id=? OR vm_id=?) AND (status='running' OR (attempts>0 AND status!='done'))").get(input.tenant, vmId) as { n: number }).n);
    if (table('cli_pairings') && db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get(input.tenant)) cliRuntime = 'bridge';
    if (table('cli_runtimes')) cliRuntime = (db.prepare('SELECT location FROM cli_runtimes WHERE user_id=?').get(input.tenant) as { location: string } | undefined)?.location ?? cliRuntime;
    if (!['server', 'bridge'].includes(cliRuntime)) throw new Error('Unknown subscription runtime.');
  } finally { db.close(); }

  const entries: LegacyInventoryEntry[] = [], issues: { code: string; location: string }[] = [];
  let totalBytes = snapshot.bytes, observed = 0;
  const rootStats = new Map<string, fs.Stats>();
  const roots = { filesRoot: input.filesRoot ?? null, cliProfilesRoot: input.cliProfilesRoot ?? null, desktopSnapshot: input.desktopSnapshot ?? null };
  for (const root of Object.values(roots)) if (root) rootStats.set(root, canonical(root, true));
  // Roots must not alias or contain one another, or accidentally include the DB.
  const values = Object.values(roots).filter((v): v is string => v !== null);
  if (values.some((a, i) => input.sourceSnapshot === a || input.sourceSnapshot.startsWith(a + '/') || values.some((b, j) => i !== j && (a === b || a.startsWith(b + '/'))))) throw new Error('Migration source roots overlap.');
  const budget = () => { if (++observed > MAX_ENTRIES || totalBytes > MAX_BYTES) throw new Error('Migration inventory exceeds bounds.'); };
  async function walk(rootName: LegacyInventoryEntry['root'], relative: string, destination: string | null, source: LegacyInventoryEntry['source'], depth = 0) {
    budget(); if (depth > MAX_DEPTH) throw new Error('Migration inventory depth exceeds bounds.');
    const root = roots[rootName]!; validateArchiveEntry(relative); if (destination) validateArchiveEntry(destination);
    // lstat here decides the expected type only. The descriptor walk verifies it.
    const info = fs.lstatSync(path.join(root, relative));
    const handle = openInventoryPath(root, relative, info.isDirectory());
    try {
      const before = fs.fstatSync(handle);
      if (before.isDirectory()) {
        if (destination) entries.push({ root: rootName, relative, destination, source, kind: 'directory', bytes: 0 });
        const names: string[] = [];
        // Bound enumeration before allocating the entire directory contents.
        const dir = fs.opendirSync(`/proc/self/fd/${handle}`);
        try { for (let item; (item = dir.readSync());) { if (names.length + observed >= MAX_ENTRIES) throw new Error('Migration inventory exceeds bounds.'); names.push(item.name); } } finally { dir.closeSync(); }
        for (const name of names.sort()) await walk(rootName, `${relative}/${name}`, destination ? `${destination}/${name}` : null, source, depth + 1);
      } else if (destination) {
        if (totalBytes + before.size > MAX_BYTES) throw new Error('Migration inventory exceeds bounds.');
        const data = await digestFile(handle); totalBytes += data.bytes;
        entries.push({ root: rootName, relative, destination, source, kind: 'file', ...data });
      } else {
        // Unknown profile content must be reviewed, even if zero length. Do not
        // read its contents or silently discard it as a cache.
        issues.push({ code: 'unmapped_profile_file', location: `${rootName}/${relative}` });
      }
      if (!unchanged(before, fs.fstatSync(handle))) throw new Error('Source directory changed during inventory.');
    } finally { fs.closeSync(handle); }
  }
  const children = (root: string, relative?: string) => {
    const handle = relative ? openInventoryPath(root, relative, true) : fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const dir = fs.opendirSync(`/proc/self/fd/${handle}`), names: string[] = [];
      try { for (let item; (item = dir.readSync());) { budget(); names.push(item.name); } } finally { dir.closeSync(); }
      return names.sort();
    } finally { fs.closeSync(handle); }
  };
  if (!input.filesRoot) issues.push({ code: 'missing_files_root', location: 'filesRoot' });
  else {
    for (const name of children(input.filesRoot)) if (!knownBots.has(name)) issues.push({ code: 'unmapped_bot_files', location: `filesRoot/${name}` });
    for (const bot of bots) if (exists(path.join(input.filesRoot, bot))) await walk('filesRoot', bot, `files/${bot}`, 'bot-files');
  }
  if (!input.cliProfilesRoot) issues.push({ code: 'missing_cli_profiles_root', location: 'cliProfilesRoot' });
  else {
    const owner = hash(input.tenant);
    if (exists(path.join(input.cliProfilesRoot, owner))) for (const name of children(input.cliProfilesRoot, owner)) {
      const provider = name === '.codex' ? 'codex' : name === '.claude' || name === '.claude.json' ? 'claude' : null;
      await walk('cliProfilesRoot', `${owner}/${name}`, provider ? `subscriptions/${provider}/${name}` : null, provider ?? 'claude');
    }
  }
  if (volume && !input.desktopSnapshot) issues.push({ code: 'missing_desktop_snapshot', location: 'desktopSnapshot' });
  if (input.desktopSnapshot) {
    if (!volume) throw new Error('Unexpected desktop snapshot without owned volume.');
    const proofFd = openInventoryPath(input.desktopSnapshot, 'tenant-manifest.json', false);
    let proof;
    try { if (fs.fstatSync(proofFd).size > 4096) throw new Error('Invalid desktop manifest.'); proof = JSON.parse(fs.readFileSync(proofFd, 'utf8')); } finally { fs.closeSync(proofFd); }
    if (proof.tenantId !== input.tenant || proof.volumeId !== volume) throw new Error('Legacy desktop volume ownership is unproven.');
    for (const name of children(input.desktopSnapshot)) if (!['tenant-manifest.json', 'profiles', 'files', '.swarm'].includes(name)) issues.push({ code: 'unmapped_desktop_files', location: `desktopSnapshot/${name}` });
    if (exists(path.join(input.desktopSnapshot, '.swarm'))) for (const name of children(input.desktopSnapshot, '.swarm')) if (!['profiles', 'desktop-browser-profiles', 'playwright'].includes(name)) issues.push({ code: 'unmapped_desktop_files', location: `desktopSnapshot/.swarm/${name}` });
    for (const prefix of ['profiles', '.swarm/profiles', '.swarm/desktop-browser-profiles', '.swarm/playwright', 'files']) {
      if (!exists(path.join(input.desktopSnapshot, prefix))) continue;
      for (const name of children(input.desktopSnapshot, prefix)) if (!bots.includes(name)) issues.push({ code: 'unmapped_desktop_files', location: `desktopSnapshot/${prefix}/${name}` });
      for (const bot of bots) if (exists(path.join(input.desktopSnapshot, prefix, bot))) await walk('desktopSnapshot', `${prefix}/${bot}`, `desktop/${prefix}/${bot}`, 'desktop');
    }
  }
  const finalFd = fs.openSync(input.sourceSnapshot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if ((await digestFile(finalFd)).sha256 !== snapshot.sha256 || !unchanged(snapshotStat, fs.fstatSync(finalFd)) || sidecars()) throw new Error('Source snapshot changed during inventory.'); } finally { fs.closeSync(finalFd); }
  for (const [root, before] of rootStats) if (!unchanged(before, canonical(root, true))) throw new Error('Source root changed during inventory.');
  const facts = {
    version: 1 as const, boundary: 'observed-files-only' as const, tenant: input.tenant,
    sourceSnapshot: input.sourceSnapshot, snapshot, roots, bots, desktopVolume: volume,
    cliRuntime, pendingProviderOperations, entries, issues, totalBytes,
  };
  return { ...facts, inventoryHash: hash(JSON.stringify(facts)), requiresFileInventory: issues.length > 0,
    requiredHostEvidence: ['all-source-processes-and-pending-starts', 'open-file-descriptors-and-writable-mounts', 'remote-cli-shutdown-or-explicit-exclusion', 'provider-resource-inventory-and-stop', 'monotonic-maintenance-fence'] };
}
