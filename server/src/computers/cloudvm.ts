import { assertLegacyWorkOpen, legacyWorkHeld, withLegacyWork } from '../security/legacy-work.js';
import { localAccess } from './local-access.js';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import type { ComputerState } from '../types.js';
import { companionConnected, createPairing, dropCompanion, localProvider, revokeVmTokens, setComputerStateSource, waitForCompanion } from './local.js';
import { ComputerError, type ComputerProvider } from './types.js';
import type { VmDriver } from './vm/driver.js';
import { fakeDriver } from './vm/fake.js';
import { flyDriver } from './vm/fly.js';

/**
 * Cloud VMs (COMPUTER_PROVIDER=cloudvm): every user gets exactly one VM, created automatically
 * through a provider API (VM_DRIVER: Fly.io Machines, or local fake VMs for dev and tests).
 * Inside it the companion runs in --multi mode: each Bot has its own screen (X display), its own
 * Chrome profile and its own folder; the user's Bots share the machine and its shell user.
 *
 * The companion connects out to this server with a token bound to the VM, so the transport,
 * live viewer and tools are the ones in local.ts. This module owns the VM lifecycle:
 * create → boot → (idle) suspend → resume → destroy, and sizing (memory grows with the Bot count).
 */

export const driver: VmDriver = env.vmDriver === 'fake' ? fakeDriver : flyDriver;

db.exec(`
CREATE TABLE IF NOT EXISTS vms (
  vm_id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  driver TEXT NOT NULL,
  ext_id TEXT,
  status TEXT NOT NULL DEFAULT 'creating',
  error TEXT,
  image TEXT,
  memory_mb INTEGER,
  cpus INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);
// The VM's disk (Bots' files, browser profiles): kept when a long-idle VM is archived.
try { db.exec('ALTER TABLE vms ADD COLUMN volume_id TEXT'); } catch { /* exists */ }

export interface VmRow {
  vm_id: string; user_id: string | null; driver: string; ext_id: string | null; volume_id: string | null; status: string; error: string | null;
  image: string | null; memory_mb: number | null; cpus: number | null; created_at: number; updated_at: number;
}

export const vmFor = (userId: string) => db.prepare('SELECT * FROM vms WHERE user_id=?').get(userId) as VmRow | undefined;

const BOOT_TIMEOUT_MS = Number(process.env.VM_BOOT_TIMEOUT_SEC ?? 240) * 1000;

/** Memory and CPUs for a user's VM: a base plus one screen per Bot (Fly allows 2 GB per shared vCPU). */
export function sizeFor(userId: string): { memoryMb: number; cpus: number } {
  const bots = (db.prepare("SELECT COUNT(*) n FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room'").get(userId) as { n: number }).n;
  let memoryMb = Math.ceil((env.vmBaseMemoryMb + Math.max(1, bots) * env.vmScreenMemoryMb) / 256) * 256;
  // Shared vCPUs come in 1, 2, 4 or 8, each allowing up to 2 GB.
  const cpus = [1, 2, 4, 8].find((c) => c >= env.vmCpus && c * 2048 >= memoryMb) ?? 8;
  memoryMb = Math.min(memoryMb, cpus * 2048);
  return { memoryMb, cpus };
}

function setStatus(vmId: string, status: string, extra: { error?: string | null; ext_id?: string | null } = {}) {
  db.prepare('UPDATE vms SET status=?, error=?, ext_id=COALESCE(?, ext_id), updated_at=? WHERE vm_id=?').run(status, extra.error ?? null, extra.ext_id ?? null, now(), vmId);
  const row = db.prepare('SELECT user_id FROM vms WHERE vm_id=?').get(vmId) as { user_id: string | null } | undefined;
  if (row?.user_id && !localAccess(row.user_id).enabled) hub.emit(row.user_id, { type: 'computer', state: state(row.user_id) });
}

const STATUS: Record<string, ComputerState['status']> = {
  creating: 'creating', starting: 'starting', resuming: 'resuming', running: 'running', suspending: 'suspending',
  suspended: 'suspended', stopped: 'stopped', error: 'error',
  // Archived: the VM was deleted after a long sleep; its disk is kept and a new VM boots on it when needed.
  archived: 'suspended',
};

function state(userId: string): ComputerState {
  const vm = vmFor(userId);
  const connected = companionConnected(userId);
  const asleep = vm && ['suspending', 'suspended', 'stopped', 'archived'].includes(vm.status);
  const status: ComputerState['status'] = !vm ? 'absent' : connected && !asleep ? 'running' : STATUS[vm.status] ?? 'starting';
  return {
    status,
    orgoId: null,
    error: vm?.status === 'error' ? vm.error : null,
    screens: connected ? localProvider.state(userId).screens : [],
    provider: 'cloudvm',
    device: null,
  };
}
if (env.computerProvider === 'cloudvm') setComputerStateSource(state);

// ---------- lifecycle ----------

const inflight = new Map<string, Promise<VmRow>>();

/** Make sure the user's VM exists, is running and its companion is connected. One VM per user, always. */
export function ensureVm(userId: string): Promise<VmRow> {
  return withLegacyWork(userId, () => ensureVmOpen(userId));
}

function ensureVmOpen(userId: string): Promise<VmRow> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = (async () => {
    let vm = vmFor(userId);
    if (vm?.ext_id && companionConnected(userId) && vm.status === 'running') return vm;
    if (!vm) {
      // The UNIQUE user_id makes a second VM for the same user impossible, even across retries.
      const vmId = newId('vm');
      db.prepare('INSERT INTO vms(vm_id,user_id,driver,status,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(vmId, userId, driver.name, 'creating', env.vmImage, now(), now());
      vm = vmFor(userId)!;
      if (!localAccess(userId).enabled) hub.emit(userId, { type: 'computer', state: state(userId) });
    }
    try {
      if (!vm.ext_id) {
        // Adopt a VM created before a crash rather than making a second one.
        const adopted = (await driver.list()).find((v) => v.vmId === vm!.vm_id);
        assertLegacyWorkOpen(userId);
        if (adopted) setStatus(vm.vm_id, 'starting', { ext_id: adopted.id });
        else {
          const size = sizeFor(userId);
          const restoring = vm.status === 'archived' && vm.volume_id;
          if (restoring) setStatus(vm.vm_id, 'starting');
          revokeVmTokens(vm.vm_id);
          const token = createPairing(userId, vm.vm_id);
          console.log(`[cloudvm] ${restoring ? 'restoring archived' : 'creating'} VM for user=${userId} (${size.memoryMb} MB, ${size.cpus} vCPU, ${driver.name})`);
          const created = await driver.create({ vmId: vm.vm_id, userId, token, serverUrl: env.serverUrl, image: env.vmImage, region: env.vmRegion || undefined, volumeGb: env.vmVolumeGb, volumeId: vm.volume_id ?? undefined, ...size });
          db.prepare('UPDATE vms SET memory_mb=?, cpus=?, image=?, volume_id=COALESCE(?, volume_id) WHERE vm_id=?').run(size.memoryMb, size.cpus, env.vmImage, created.volumeId ?? null, vm.vm_id);
          setStatus(vm.vm_id, 'starting', { ext_id: created.id });
        }
        vm = vmFor(userId)!;
      } else {
        const info = await driver.get(vm.ext_id);
        assertLegacyWorkOpen(userId);
        if (!info) {
          // Deleted outside Swarm: forget it and start over with a fresh VM.
          console.warn(`[cloudvm] VM ${vm.ext_id} for user=${userId} is gone; recreating`);
          db.prepare('UPDATE vms SET ext_id=NULL WHERE vm_id=?').run(vm.vm_id);
          inflight.delete(userId);
          return ensureVm(userId);
        }
        if (info.state === 'suspended' || info.state === 'suspending') { setStatus(vm.vm_id, 'resuming'); await driver.start(vm.ext_id); }
        else if (info.state === 'stopped' || info.state === 'stopping' || info.state === 'creating') { setStatus(vm.vm_id, 'starting'); await driver.start(vm.ext_id); }
      }
      if (!(await waitForCompanion(userId, BOOT_TIMEOUT_MS))) throw new Error('The computer started but did not come online in time.');
      setStatus(vm.vm_id, 'running');
      return vmFor(userId)!;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      console.warn(`[cloudvm] ensure failed for user=${userId}: ${msg}`);
      if (!legacyWorkHeld(userId)) setStatus(vm.vm_id, 'error', { error: msg });
      throw new ComputerError(`Your Bots' computer couldn't start: ${msg}`, 503);
    }
  })();
  inflight.set(userId, p);
  p.finally(() => { if (inflight.get(userId) === p) inflight.delete(userId); }).catch(() => {});
  return p;
}

/** Freeze the user's VM (idle or on request). The next computer action resumes it. */
export async function suspendVm(userId: string, reason = 'manual') {
  return withLegacyWork(userId, () => suspendVmOpen(userId, reason));
}

async function suspendVmOpen(userId: string, reason = 'manual') {
  const vm = vmFor(userId);
  if (!vm?.ext_id || !['running', 'starting', 'resuming'].includes(vm.status)) return;
  // On an outdated image: stop and move it to the current image instead of pausing it, so its next
  // wake is one fresh boot (a few seconds longer) with the new image; later wakes are quick again.
  if (vm.image && vm.image !== env.vmImage) {
    console.log(`[cloudvm] stopping VM for user=${userId} to update its image (${vm.image} → ${env.vmImage}; ${reason})`);
    setStatus(vm.vm_id, 'suspending');
    try {
      await driver.stop(vm.ext_id);
      dropCompanion(userId, 'computer updating');
      assertLegacyWorkOpen(userId);
      await driver.setImage(vm.ext_id, env.vmImage);
      db.prepare('UPDATE vms SET image=? WHERE vm_id=?').run(env.vmImage, vm.vm_id);
      setStatus(vm.vm_id, 'stopped');
    } catch (e: any) {
      if (!legacyWorkHeld(userId)) setStatus(vm.vm_id, 'running', { error: String(e?.message ?? e) });
      throw e;
    }
    return;
  }
  console.log(`[cloudvm] suspending VM for user=${userId} (${reason})`);
  setStatus(vm.vm_id, 'suspending');
  try {
    await driver.suspend(vm.ext_id);
    // The frozen companion can't say goodbye; drop its connection so nobody waits on it.
    dropCompanion(userId, 'computer suspended');
    setStatus(vm.vm_id, 'suspended');
  } catch (e: any) {
    if (!legacyWorkHeld(userId)) setStatus(vm.vm_id, 'running', { error: String(e?.message ?? e) });
    throw e;
  }
}

/** Delete a VM and its disk (account deleted, or an orphan found by the reconcile loop). */
export async function destroyVm(vmId: string) {
  const owner = (db.prepare('SELECT user_id FROM vms WHERE vm_id=?').get(vmId) as { user_id: string | null } | undefined)?.user_id;
  return withLegacyWork(owner, () => destroyVmOpen(vmId));
}

async function destroyVmOpen(vmId: string) {
  const vm = db.prepare('SELECT * FROM vms WHERE vm_id=?').get(vmId) as VmRow | undefined;
  if (!vm) return;
  console.log(`[cloudvm] destroying VM ${vm.ext_id ?? '(not created)'} (user=${vm.user_id ?? 'none'})`);
  if (vm.ext_id) await driver.destroy(vm.ext_id);
  else if (vm.volume_id) await driver.destroyVolume(vm.volume_id); // archived: only the disk is left
  revokeVmTokens(vmId);
  if (vm.user_id) dropCompanion(vm.user_id, 'computer deleted');
  db.prepare('DELETE FROM vms WHERE vm_id=?').run(vmId);
  if (vm.user_id && !localAccess(vm.user_id).enabled) hub.emit(vm.user_id, { type: 'computer', state: state(vm.user_id) });
}

/**
 * Archive a long-sleeping VM: delete the VM itself (no more charges for it) but keep its disk.
 * The next computer task boots a fresh VM, from the current image, on the same disk.
 */
export async function archiveVm(userId: string) {
  return withLegacyWork(userId, () => archiveVmOpen(userId));
}

async function archiveVmOpen(userId: string) {
  const vm = vmFor(userId);
  if (!vm?.ext_id || !['suspended', 'stopped'].includes(vm.status)) return;
  console.log(`[cloudvm] archiving VM ${vm.ext_id} for user=${userId} (asleep since ${new Date(vm.updated_at).toISOString()}); keeping its disk`);
  const { volumeId } = await driver.archive(vm.ext_id);
  revokeVmTokens(vm.vm_id);
  db.prepare("UPDATE vms SET ext_id=NULL, volume_id=COALESCE(?, volume_id), status='archived', updated_at=? WHERE vm_id=?").run(volumeId ?? null, now(), vm.vm_id);
}

/** Grow (or shrink) the VM to fit the user's Bots: one screen each. Called while the VM sleeps; applies at its next boot. */
export async function resizeVm(userId: string) {
  return withLegacyWork(userId, () => resizeVmOpen(userId));
}

async function resizeVmOpen(userId: string) {
  const vm = vmFor(userId);
  if (!vm?.ext_id) return;
  const size = sizeFor(userId);
  if (size.memoryMb === vm.memory_mb && size.cpus === vm.cpus) return;
  console.log(`[cloudvm] resizing VM for user=${userId}: ${vm.memory_mb} → ${size.memoryMb} MB, ${size.cpus} vCPU`);
  await driver.resize(vm.ext_id, size.memoryMb, size.cpus);
  // A resized VM boots fresh next time (its suspended memory is discarded).
  db.prepare("UPDATE vms SET memory_mb=?, cpus=?, status='stopped', updated_at=? WHERE vm_id=?").run(size.memoryMb, size.cpus, now(), vm.vm_id);
}

// ---------- the provider ----------

const PROMPT =
  "You have your own computer in the cloud: a Linux desktop screen that only you use, with Google Chrome (your own logged-in profile) and a bash shell. Your teammates (the user's other Bots) each have their own screen on the same machine. " +
  "Do all web work with the browser_* tools, which drive your Chrome through Playwright: browser_navigate to open a page, browser_snapshot to read it (every element has a ref, e.g. e12), then browser_click, browser_type, browser_fill_form, browser_select_option and browser_press_key on those refs; browser_tabs for tabs, browser_wait_for to wait for text, browser_file_upload for files on your computer, browser_take_screenshot to see the page. browser_navigate and the other actions (click, type, …) return the loaded page with its elements: work from that result. Don't call browser_wait_for, browser_snapshot or browser_navigate again unless the returned page is clearly still loading or is the wrong page. Keep tasks to as few steps as possible. " +
  "Use the computer_* tools only for things outside the browser (other apps, system dialogs) or to look at your whole screen, and shell for commands and files (your folder is your shell's starting folder; files there persist). " +
  "CAPTCHAs and 'verify you are human' checks: never try to solve or get around them. When one appears, the system automatically asks the user to solve it on your screen and waits; you'll then be told to continue (or that it's still waiting, in which case tell the user and stop that step). Save finished deliverables (reports, notes, data) with save_file so they appear in the user's Library.";

export const cloudvmProvider: ComputerProvider = {
  kind: 'cloudvm',
  capabilities: { shell: true, browser: true },
  promptLine: PROMPT,
  toolDescriptions: {
    computer_screenshot: 'Take a screenshot of your screen. Use this before acting on it.',
    computer_click: 'Click at pixel coordinates on your screen. Returns a fresh screenshot.',
    computer_type: 'Type text into whatever has keyboard focus on your screen. A newline presses Enter. Returns a fresh screenshot.',
    computer_key: 'Press a key or key combination on your screen, using X11 keysym names joined by "+", e.g. "Return", "Tab", "Escape", "BackSpace", "Page_Down", "ctrl+l" (Chrome address bar), "ctrl+t" (new tab), "ctrl+w" (close tab), "alt+Left" (back).',
    computer_scroll: 'Scroll the mouse wheel at a position on your screen.',
    computer_drag: 'Drag with the left mouse button from one point to another on your screen.',
    open_browser: 'Open a web page (http/https) in your Chrome on your screen and return a screenshot. For reading and acting on pages, prefer browser_navigate and browser_snapshot.',
    shell: "Run a bash command on your cloud computer (as the Bots' user, in your own folder). Use for files, scripts, CLIs and quick data work. Output is truncated to 20k characters.",
  },

  state,
  async refresh(userId) {
    const vm = vmFor(userId);
    if (vm?.ext_id && !companionConnected(userId) && vm.status === 'running') {
      const info = await driver.get(vm.ext_id).catch(() => null);
      if (!info) setStatus(vm.vm_id, 'stopped');
      else if (info.state === 'suspended') setStatus(vm.vm_id, 'suspended');
      else if (info.state === 'stopped') setStatus(vm.vm_id, 'stopped');
    }
    return state(userId);
  },
  ensure: async (userId) => { await ensureVm(userId); },
  suspend: (userId) => suspendVm(userId),

  async screen(userId, botId) {
    await ensureVm(userId);
    return localProvider.screen(userId, botId);
  },
  peek: (userId, botId) => (companionConnected(userId) ? localProvider.peek(userId, botId) : Promise.resolve(null)),
  resetScreen: (userId, botId) => (companionConnected(userId) ? localProvider.resetScreen(userId, botId) : Promise.resolve({ ok: true as const, note: 'The computer is asleep.' })),
  screens: (userId) => localProvider.screens(userId),
  files: localProvider.files,

  async viewer(client, userId, botId, mode) {
    try { await ensureVm(userId); } catch (e: any) { try { client.close(1011, String(e?.message ?? e).slice(0, 120)); } catch { /* */ } return; }
    return localProvider.viewer(client, userId, botId, mode);
  },

  start() {
    // Lazy: idle.ts imports the agent loop, which imports the provider index.
    void import('../idle.js').then(({ startIdleWatcher }) => startIdleWatcher({
      computers: () => (db.prepare("SELECT user_id FROM vms WHERE user_id IS NOT NULL AND ext_id IS NOT NULL AND status='running'").all() as { user_id: string }[])
        .map((r) => ({ userId: r.user_id, status: 'running' })),
      suspend: (userId) => suspendVm(userId, 'idle'),
      lastActivity: (userId) => vmFor(userId)?.updated_at ?? 0,
    }));
    void import('../provisioning.js').then(({ startProvisioning }) => startProvisioning());
  },
};
