import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { containerArguments, pinnedImage, type HostPolicy, type Workload } from './container-policy.js';
import { McpFolderLease, folderMountDriver, type FolderMountDriver } from './mcp-folders.js';
import { mcpFoldersSchema } from '../security/mcp-folders.js';
const exec = promisify(execFile);
const MAX = 8 * 1024 * 1024;

/** Trusted host operations, kept separate from the per-connection protocol. */
export interface SupervisorDriver {
  start(args: string[]): ReturnType<typeof spawn>;
  remove(name: string): Promise<void>;
  resetProfile(dir: string): Promise<void>;
}
const docker: SupervisorDriver = {
  start: args => spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/usr/local/bin:/bin' } }),
  remove: async name => {
    try { await exec('docker', ['rm', '--force', name], { timeout: 15_000 }); }
    catch {
      // --rm may already have removed a completed container. A failed removal
      // is safe only if Docker confirms the container no longer exists.
      const { stdout } = await exec('docker', ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${name}$`], { timeout: 15_000 });
      if (stdout.trim()) throw new Error('Runner container could not be stopped.');
    }
  },
  resetProfile: async dir => {
    if (await fs.realpath(dir) !== dir) throw new Error('Unsafe profile.');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { mode: 0o700 }); await fs.chown(dir, 10001, 10001);
  },
};

/** Attach only to the host's private socket, after startSupervisor verifies its boundary. */
export function attachSupervisor(server: http.Server, policy: HostPolicy, driver: SupervisorDriver = docker,
  options: { mounts?: { driver: FolderMountDriver; root?: string }; onBoundaryFailure?: () => void } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX });
  interface Job { kind: 'cli' | 'mcp'; provider: string; stop: () => Promise<void> }
  const active = new Map<string, Job>();
  // Generation and status share the profile. Only credential mutations are exclusive.
  const writers = new Map<string, string>();
  let closing = false;
  let shutdown: Promise<void> | undefined;
  server.on('upgrade', (req, socket, head) => {
    if (closing || !['/mcp', '/cli'].includes(req.url ?? '')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const id = randomUUID();
      let child: ReturnType<typeof spawn> | undefined;
      let name = '', provider = '', ready = false, starting = false, closed = false, finalizing = false;
      let mutation: Promise<void> | undefined;
      let folders: McpFolderLease | undefined;
      let stopping: Promise<void> | undefined;
      const cleanup = () => stopping ??= (async () => {
        clearTimeout(deadline);
        // A cancelled credential mutation must finish before a new reader can start.
        await mutation?.catch(() => {});
        try { if (name) await driver.remove(name); }
        finally { child?.kill('SIGKILL'); }
        await folders?.close();
        active.delete(id);
        if (writers.get(provider) === id) writers.delete(provider);
      })().catch(error => {
        // Retain ownership until removal succeeds; a later stop can retry.
        stopping = undefined;
        if (folders?.folders.length) {
          // A server may keep using a shared folder without sending more RPCs.
          // Failed revocation must stop the host, not silently leave it running.
          closing = true; options.onBoundaryFailure?.();
        }
        throw error;
      });
      const stop = () => { closed = true; ws.terminate(); return cleanup(); };
      const stopQuietly = () => { void stop().catch(() => {}); };
      const finish = async (line: string | Buffer) => {
        finalizing = true;
        // Deliver completion after cleanup so a following login cannot race this container.
        await cleanup();
        if (!closed && ws.readyState === WebSocket.OPEN) ws.send(line, { binary: false }, () => ws.close());
      };
      let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(stopQuietly, 12_000);
      ws.on('error', stopQuietly); ws.on('close', stopQuietly);
      ws.on('message', async raw => {
        try {
          if (closing || closed || finalizing) return;
          if (ready) {
            if (child?.stdin && !child.stdin.write(raw.toString() + '\n')) ws.pause(), child.stdin.once('drain', () => ws.resume());
            return;
          }
          if (starting) throw new Error('Handshake required.'); starting = true;
          const message = JSON.parse(raw.toString());
          if (message.tenantId !== policy.tenantId) throw new Error('Invalid owner.');
          let workload: Workload;
          if (req.url === '/cli') {
            if (!['claude', 'codex'].includes(message.provider) || !['status', 'catalog', 'generate', 'login', 'delete'].includes(message.operation)) throw new Error('Invalid operation.');
            provider = message.provider;
            if (writers.has(provider)) throw new Error('Subscription credentials are being changed.');
            workload = { kind: 'cli', provider: message.provider };
            const exclusive = message.operation === 'login' || message.operation === 'delete';
            if (exclusive) writers.set(provider, id);
            const previous = exclusive ? [...active.values()].filter(job => job.provider === provider) : [];
            active.set(id, { kind: 'cli', provider, stop });
            // Explicit sign-in/disconnect stops this provider's work; ordinary requests never wait.
            if (exclusive) await Promise.all(previous.map(job => job.stop()));
            if (closed) return;
            if (message.operation === 'delete') {
              const dir = path.join(policy.root, 'subscriptions', provider);
              mutation = driver.resetProfile(dir);
              await mutation;
              if (closed) return;
              ws.send(JSON.stringify({ type: 'ready' }));
              await finish(JSON.stringify({ type: 'result', result: { ok: true } }));
              return;
            }
          } else {
            if (typeof message.config?.command !== 'string' || message.config.command.length > 512 || !Array.isArray(message.config?.args) || message.config.args.some((s: unknown) => typeof s !== 'string') || JSON.stringify(message.config).length > 262144) throw new Error('Invalid command.');
            if ([...active.values()].filter(job => job.kind === 'mcp').length >= 20) throw new Error('MCP runners are busy.');
            const selected = mcpFoldersSchema.parse(message.config.folders);
            workload = { kind: 'mcp', id: message.id, folderCount: selected.length };
            active.set(id, { kind: 'mcp', provider: '', stop });
            name = `swarm-${randomUUID()}`;
            // Validate identity before allocating host resources.
            containerArguments(policy, workload, name);
            folders = new McpFolderLease(path.join(policy.root, 'files'), selected, name, options.mounts?.driver ?? folderMountDriver, options.mounts?.root);
            mutation = folders.prepare();
            await mutation;
            if (closed || closing) return;
          }
          name ||= `swarm-${randomUUID()}`;
          const args = containerArguments(policy, workload, name);
          child = driver.start(args);
          child.on('error', stopQuietly); child.on('close', () => { if (!finalizing) stopQuietly(); });
          child.stdin!.on('error', stopQuietly);
          let buffered = Buffer.alloc(0);
          child.stdout!.on('data', (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length > MAX) { stopQuietly(); return; }
            let end: number;
            while ((end = buffered.indexOf(10)) >= 0) {
              const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
              if (!ready) {
                try { if (JSON.parse(line.toString()).type !== 'ready') throw new Error(); } catch { stopQuietly(); return; }
                ready = true; clearTimeout(deadline);
                const unboundedGeneration = workload.kind === 'cli' && message.operation === 'generate' && message.params?.timeoutMs === 0;
                deadline = unboundedGeneration ? undefined : setTimeout(stopQuietly, workload.kind === 'cli' ? 16 * 60_000 : 30 * 60_000);
              }
              if (ws.bufferedAmount > MAX || closed) { stopQuietly(); return; }
              if (workload.kind === 'cli') {
                try {
                  const type = JSON.parse(line.toString()).type;
                  if (type === 'result' || type === 'error') { void finish(line).catch(stopQuietly); return; }
                } catch { stopQuietly(); return; }
              }
              ws.send(line, { binary: false });
            }
          });
          if (closed) { await stop(); return; }
          child.stdin!.write(JSON.stringify(message) + '\n');
        } catch { await stop().catch(() => {}); }
      });
    });
  });
  return { close: () => shutdown ??= (async () => {
    closing = true;
    for (const ws of wss.clients) ws.terminate();
    try {
      const stopped = await Promise.allSettled([...active.values()].map(job => job.stop()));
      if (stopped.some(result => result.status === 'rejected')) throw new Error('Runner shutdown could not stop every container.');
    }
    finally { await new Promise<void>(resolve => wss.close(() => resolve())); }
  })().catch(error => {
    // Keep admission closed, but let an operator retry failed container cleanup.
    shutdown = undefined;
    throw error;
  }) };
}

/** Host-only daemon. The application gets its Unix socket; workloads get neither it nor Docker's socket. */
export async function startSupervisor(policy: HostPolicy, socketPath: string, onBoundaryFailure?: () => void) {
  pinnedImage(policy.runnerImage); pinnedImage(policy.mcpImage);
  // The boot firewall writes this root-owned marker only after all rules and probes succeed.
  const marker = await fs.stat('/run/swarm-host/network-ready');
  if (marker.uid !== 0 || (marker.mode & 0o022)) throw new Error('Network boundary is not verified.');
  for (const provider of ['claude', 'codex']) {
    const dir = path.join(policy.root, 'subscriptions', provider);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(dir)).isSymbolicLink() || await fs.realpath(dir) !== dir) throw new Error('Unsafe credential mount.');
    await fs.chown(dir, 10001, 10001);
  }
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  await fs.rm(socketPath, { force: true });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const supervisor = attachSupervisor(server, policy, docker, { onBoundaryFailure });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o660); await fs.chown(socketPath, 0, 10001);
  return { server, close: async () => { try { await supervisor.close(); } finally { server.close(); } } };
}
