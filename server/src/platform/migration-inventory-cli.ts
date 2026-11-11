/** Offline operator inspection only. No app imports, network clients or effects
 * on the source; no freeze/activate/resume command is intentionally exposed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryLegacySource } from './migration-inventory.js';

export async function migrationInventoryCommand(args: string[]) {
  const [command, ...rest] = args, options: Record<string, string> = {};
  if (command !== 'inventory' || rest.length % 2) throw new Error('Use inventory with explicit snapshot, source layout and output.');
  const allowed = new Set(['tenant', 'snapshot', 'files-root', 'cli-profiles-root', 'desktop-snapshot', 'source-image', 'source-host', 'source-volume', 'output']);
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].slice(2), value = rest[i + 1];
    if (!rest[i].startsWith('--') || !allowed.has(name) || Object.hasOwn(options, name) || !value || value.startsWith('--')) throw new Error('Invalid inventory options.');
    options[name] = value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(options['source-image'] ?? '') || options['source-image'].length > 512 ||
      !/^[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}$/.test(options['source-host'] ?? '') || !/^[A-Za-z0-9_-]{1,120}$/.test(options['source-volume'] ?? '')) throw new Error('Declared immutable source image, app/machine and volume are required.');
  const output = options.output, parent = output && path.dirname(output);
  if (!output || !path.isAbsolute(output) || !parent || fs.realpathSync(parent) !== parent || path.normalize(output) !== output) throw new Error('A canonical absolute output path is required.');
  const info = fs.statSync(parent);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Inventory reports require a private maintenance directory.');
  // The only write is the new report, and it must stay outside every source
  // root. Comparing ancestor inodes also rejects bind-mount aliases of a root.
  const sourceRoots = ['files-root', 'cli-profiles-root', 'desktop-snapshot'].flatMap(name => options[name] ? [fs.statSync(options[name])] : []);
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    const stat = fs.statSync(ancestor);
    if (sourceRoots.some(root => root.dev === stat.dev && root.ino === stat.ino)) throw new Error('Inventory output must be outside source roots.');
    if (ancestor === path.dirname(ancestor)) break;
  }
  const inventory = await inventoryLegacySource({ tenant: options.tenant, sourceSnapshot: options.snapshot, filesRoot: options['files-root'], cliProfilesRoot: options['cli-profiles-root'], desktopSnapshot: options['desktop-snapshot'] });
  const report = { declaredSource: { image: options['source-image'], host: options['source-host'], volume: options['source-volume'], verified: false }, inventory };
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(output); throw error; }
  fs.closeSync(fd);
  const dir = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return { report: output, inventoryHash: inventory.inventoryHash, issues: inventory.issues.length, requiresFileInventory: inventory.requiresFileInventory, boundary: inventory.boundary, sourceMutated: false, routingChanged: false };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(await migrationInventoryCommand(process.argv.slice(2)), null, 2)); }
  catch { console.error('Legacy inventory refused. Use an offline checkpointed snapshot, canonical owned roots and a private output directory; inspect unsupported layouts before retrying.'); process.exitCode = 1; }
}
