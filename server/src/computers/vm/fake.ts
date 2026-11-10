import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env.js';
import type { VmDriver, VmInfo, VmSpec, VmState } from './driver.js';

/**
 * Fake VMs for development and tests: each "VM" is a process group on this machine running the
 * companion in --multi mode (one Xvfb screen per Bot). Suspend/resume freeze and thaw the whole
 * group (SIGSTOP/SIGCONT), which behaves like a real VM pause: the companion's connection goes
 * stale and must reconnect after resuming. Needs Xvfb, xdotool, ImageMagick and Chrome.
 *
 * FAKE_VM_DIR: where VMs keep their state (default: next to the database).
 * FAKE_VM_RUN_AS: an existing Unix user for the Bots' shells and browsers (optional).
 * FAKE_VM_NO_SANDBOX=1: start Chrome with --no-sandbox (containers).
 */

const ROOT = path.resolve(process.env.FAKE_VM_DIR ?? path.join(path.dirname(env.filesDir), 'fake-vms'));
const COMPANION = new URL('../../../../companion/swarm-companion.mjs', import.meta.url).pathname;

interface FakeVm { id: string; vmId: string; userId: string; image: string; memoryMb: number; pid: number | null; destroyed?: boolean; archived?: boolean }

const dir = (id: string) => path.join(ROOT, id);
const read = (id: string): FakeVm | null => {
  try { return JSON.parse(fs.readFileSync(path.join(dir(id), 'vm.json'), 'utf8')); } catch { return null; }
};
const write = (vm: FakeVm) => fs.writeFileSync(path.join(dir(vm.id), 'vm.json'), JSON.stringify(vm));

function procState(pid: number | null): 'running' | 'stopped' | 'gone' {
  if (!pid) return 'gone';
  try { process.kill(pid, 0); } catch { return 'gone'; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    if (state === 'Z') return 'gone';
    return state === 'T' || state === 't' ? 'stopped' : 'running';
  } catch { return 'running'; }
}

function boot(vm: FakeVm) {
  const d = dir(vm.id);
  const log = fs.openSync(path.join(d, 'companion.log'), 'a');
  const args = [
    COMPANION, '--server', String(fs.readFileSync(path.join(d, 'server'), 'utf8')), '--token-file', path.join(d, 'token'), '--multi',
    '--data-dir', path.join(d, 'data'),
    ...(process.env.FAKE_VM_RUN_AS ? ['--run-as', process.env.FAKE_VM_RUN_AS] : ['--agent-home', path.join(d, 'home')]),
    ...(process.env.FAKE_VM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  ];
  // Its own process group, so suspend/stop reach Xvfb and Chrome too.
  const p = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
  p.unref();
  fs.closeSync(log);
  vm.pid = p.pid ?? null;
  write(vm);
}

const signal = (vm: FakeVm, sig: NodeJS.Signals) => { if (vm.pid) { try { process.kill(-vm.pid, sig); } catch { /* gone */ } } };

export const fakeDriver: VmDriver = {
  name: 'fake',

  async create(spec: VmSpec) {
    // A kept disk (archived VM) is this fake's whole directory: boot it again.
    const kept = spec.volumeId ? read(spec.volumeId) : null;
    if (kept) {
      fs.writeFileSync(path.join(dir(kept.id), 'token'), spec.token, { mode: 0o600 });
      fs.writeFileSync(path.join(dir(kept.id), 'server'), spec.serverUrl);
      Object.assign(kept, { archived: false, vmId: spec.vmId, userId: spec.userId, image: spec.image, memoryMb: spec.memoryMb });
      boot(kept);
      return { id: kept.id, volumeId: kept.id };
    }
    const id = `fake-${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(path.join(dir(id), 'home'), { recursive: true });
    fs.writeFileSync(path.join(dir(id), 'token'), spec.token, { mode: 0o600 });
    fs.writeFileSync(path.join(dir(id), 'server'), spec.serverUrl);
    const vm: FakeVm = { id, vmId: spec.vmId, userId: spec.userId, image: spec.image, memoryMb: spec.memoryMb, pid: null };
    write(vm);
    boot(vm);
    return { id, volumeId: id };
  },

  async archive(id) {
    const vm = read(id);
    if (!vm) return {};
    signal(vm, 'SIGCONT');
    signal(vm, 'SIGKILL');
    vm.archived = true;
    vm.pid = null;
    write(vm);
    return { volumeId: id };
  },

  async destroyVolume(volumeId) {
    fs.rmSync(dir(volumeId), { recursive: true, force: true });
  },

  async start(id) {
    const vm = read(id);
    if (!vm || vm.destroyed) throw Object.assign(new Error('VM not found'), { gone: true });
    const s = procState(vm.pid);
    if (s === 'stopped') signal(vm, 'SIGCONT');
    else if (s === 'gone') boot(vm);
  },

  async suspend(id) {
    const vm = read(id);
    if (vm) signal(vm, 'SIGSTOP');
  },

  async stop(id) {
    const vm = read(id);
    if (!vm) return;
    signal(vm, 'SIGCONT');
    signal(vm, 'SIGTERM');
    for (let i = 0; i < 30 && procState(vm.pid) !== 'gone'; i++) await new Promise((r) => setTimeout(r, 200));
    signal(vm, 'SIGKILL');
  },

  async destroy(id) {
    const vm = read(id);
    if (!vm) return;
    signal(vm, 'SIGCONT');
    signal(vm, 'SIGKILL');
    fs.rmSync(dir(id), { recursive: true, force: true });
  },

  async get(id): Promise<VmInfo | null> {
    const vm = read(id);
    if (!vm || vm.destroyed || vm.archived) return null;
    const s = procState(vm.pid);
    const state: VmState = s === 'running' ? 'started' : s === 'stopped' ? 'suspended' : 'stopped';
    return { id, state, vmId: vm.vmId, userId: vm.userId, image: vm.image, memoryMb: vm.memoryMb };
  },

  async list() {
    if (!fs.existsSync(ROOT)) return [];
    const out: VmInfo[] = [];
    for (const id of fs.readdirSync(ROOT)) { const info = await fakeDriver.get(id); if (info) out.push(info); }
    return out;
  },

  async setImage(id, image) {
    const vm = read(id);
    if (!vm) return;
    vm.image = image;
    write(vm);
  },

  async resize(id, memoryMb) {
    const vm = read(id);
    if (!vm) return;
    vm.memoryMb = memoryMb;
    write(vm);
  },
};
