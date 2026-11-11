import path from 'node:path';
import { MCP_MOUNT_ROOT } from './mcp-folders.js';

export interface HostPolicy {
  tenantId: string;
  root: string;
  runnerImage: string;
  mcpImage: string;
  network: string;
}
export type Workload = { kind: 'cli'; provider: 'claude' | 'codex' } | { kind: 'mcp'; id: string; folderCount?: number };
export function pinnedImage(image: string) {
  if (!/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('A digest-pinned image is required.');
  return image;
}
/** All Docker flags and mount sources come from host policy, never from workload arguments. */
export function containerArguments(policy: HostPolicy, workload: Workload, name: string): string[] {
  if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(policy.tenantId) || !/^swarm-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid host identity.');
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(policy.network) || !path.isAbsolute(policy.root)) throw new Error('Invalid host policy.');
  if (workload.kind === 'cli' && !['claude', 'codex'].includes(workload.provider)) throw new Error('Invalid provider.');
  if (workload.kind === 'mcp' && !/^mcp_[A-Za-z0-9_-]{6,100}$/.test(workload.id)) throw new Error('Invalid MCP connection.');
  if (workload.kind === 'mcp' && (!Number.isInteger(workload.folderCount ?? 0) || (workload.folderCount ?? 0) < 0 || (workload.folderCount ?? 0) > 8)) throw new Error('Invalid MCP folder count.');
  const args = ['run', '--rm', '--pull=never', '--name', name, '--label', `swarm.tenant=${policy.tenantId}`,
    '--init', '--interactive', '--user', '10001:10001', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=128', '--memory=768m', '--memory-swap=768m',
    '--cpus=1', '--ulimit=nofile=1024:1024', '--log-driver=none', '--network', policy.network,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m,uid=10001,gid=10001',
    '--workdir=/workspace', '--env=HOME=/home/runner', '--env=LANG=C.UTF-8'];
  if (workload.kind === 'cli') {
    // No shared provider home: a compromised Claude process cannot read Codex authentication.
    const home = path.join(policy.root, 'subscriptions', workload.provider);
    args.push('--mount', `type=bind,src=${home},dst=/home/runner`);
  } else {
    args.push('--tmpfs', '/home/runner:rw,nosuid,nodev,size=32m,uid=10001,gid=10001');
    for (let i = 1; i <= (workload.folderCount ?? 0); i++) {
      // Host-created nonrecursive binds only; no workload-supplied Docker paths.
      args.push('--mount', `type=bind,src=${MCP_MOUNT_ROOT}/${name}/${i},dst=/workspace/folders/${i},readonly,bind-recursive=disabled`);
    }
  }
  args.push(pinnedImage(workload.kind === 'cli' ? policy.runnerImage : policy.mcpImage), 'node', '/app/infra/tenant-host/worker.mjs', workload.kind);
  return args;
}
