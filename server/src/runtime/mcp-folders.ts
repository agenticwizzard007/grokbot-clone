import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mcpFoldersSchema, openMcpFolder } from '../security/mcp-folders.js';
const exec = promisify(execFile);
export const MCP_MOUNT_ROOT = '/run/swarm-host/mcp-folders';
export interface FolderMountDriver {
  bind(source: string, destination: string): Promise<void>;
  unmount(destination: string): Promise<void>;
}
/** --no-canonicalize is essential: resolving /proc/<pid>/fd back to an attacker
 * pathname before mount(2) would reintroduce a symlink/rename race. The resulting
 * mount lives under a root-only path, so Docker never resolves workload paths. */
export const folderMountDriver: FolderMountDriver = {
  async bind(source, destination) {
    await exec('mount', ['--no-canonicalize', '--bind', source, destination], { timeout: 10000 });
    await exec('mount', ['--no-canonicalize', '-o', 'remount,bind,ro,nosuid,nodev,noexec', destination], { timeout: 10000 });
  },
  async unmount(destination) {
    const mounted = () => fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4] === destination);
    if (mounted()) await exec('umount', ['--no-canonicalize', destination], { timeout: 10000 });
    if (mounted()) throw new Error('MCP folder cleanup requires retry.');
  },
};
/** A lease remains owned until the container is confirmed gone AND mounts are
 * removed. Partial/failed mount setup is also retryable; no lazy unmounts. */
export class McpFolderLease {
  private destinations: string[] = [];
  private prepared = false;
  readonly directory: string;
  constructor(private filesRoot: string, readonly folders: string[], name: string, private driver = folderMountDriver, root = MCP_MOUNT_ROOT) {
    mcpFoldersSchema.parse(folders);
    if (!/^swarm-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid runner name.');
    if (!path.isAbsolute(root) || /[,\s]/.test(root)) throw new Error('Invalid host mount root.');
    this.directory = path.join(root, name);
  }
  async prepare() {
    if (this.prepared) throw new Error('MCP folder lease already prepared.');
    this.prepared = true;
    if (!this.folders.length) return;
    const root = path.dirname(this.directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(root);
    if (fs.realpathSync(root) !== root || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new Error('Unsafe host mount root.');
    fs.mkdirSync(this.directory, { mode: 0o700 });
    for (const [index, folder] of this.folders.entries()) {
      const fd = openMcpFolder(this.filesRoot, folder);
      try {
        const destination = path.join(this.directory, String(index + 1));
        fs.mkdirSync(destination, { mode: 0o700 });
        // Record before awaiting mount: failure can mean an unknown partial effect.
        this.destinations.push(destination);
        await this.driver.bind(`/proc/${process.pid}/fd/${fd}`, destination);
      } finally { fs.closeSync(fd); }
    }
  }
  async close() {
    for (const destination of [...this.destinations].reverse()) {
      await this.driver.unmount(destination);
      fs.rmdirSync(destination);
      this.destinations.splice(this.destinations.indexOf(destination), 1);
    }
    if (fs.existsSync(this.directory)) fs.rmdirSync(this.directory);
  }
}
