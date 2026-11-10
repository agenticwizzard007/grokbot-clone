import { env } from '../../env.js';
import type { VmDriver, VmInfo, VmSpec, VmState } from './driver.js';

/**
 * Fly.io Machines (Firecracker microVMs) through the Machines API.
 * One app (FLY_VM_APP) holds every user's VM. Each VM gets a volume mounted at /home/agent
 * (the Bots' files and browser profiles survive restarts and image updates), the pairing token as
 * a file, and metadata linking it back to our VM and user ids.
 *
 * Needs FLY_API_TOKEN (a token scoped to FLY_VM_APP) and an image built from infra/vm-image.
 */

class FlyError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!env.flyApiToken || !env.flyApp) throw new Error('Cloud VMs need FLY_API_TOKEN and FLY_VM_APP.');
  const r = await fetch(`${env.flyApiBase}/v1/apps/${encodeURIComponent(env.flyApp)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.flyApiToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new FlyError(`Fly ${method} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 300)}`, r.status);
  return (text ? JSON.parse(text) : {}) as T;
}

const gone = (e: unknown) => e instanceof FlyError && e.status === 404;

const STATES: Record<string, VmState> = {
  created: 'creating', starting: 'starting', started: 'started', stopping: 'stopping', stopped: 'stopped',
  suspending: 'suspending', suspended: 'suspended', destroying: 'destroying', destroyed: 'destroyed', replacing: 'starting', updating: 'starting',
};

const info = (m: any): VmInfo => ({
  id: m.id,
  state: STATES[m.state] ?? 'unknown',
  vmId: m.config?.metadata?.swarm_vm,
  userId: m.config?.metadata?.swarm_user,
  image: m.config?.image,
  memoryMb: m.config?.guest?.memory_mb,
});

export const flyDriver: VmDriver = {
  name: 'fly',

  async create(spec: VmSpec) {
    const region = spec.region || undefined;
    const volume = await api<{ id: string; region: string }>('POST', '/volumes', { name: 'agent_home', size_gb: spec.volumeGb, region, encrypted: true });
    try {
      const m = await api<{ id: string }>('POST', '/machines', {
        name: `sw-${spec.vmId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()}`,
        region: volume.region,
        config: {
          image: spec.image,
          guest: { cpu_kind: 'shared', cpus: spec.cpus, memory_mb: spec.memoryMb },
          env: { SWARM_SERVER: spec.serverUrl },
          files: [{ guest_path: '/run/swarm/token', raw_value: Buffer.from(spec.token).toString('base64') }],
          mounts: [{ volume: volume.id, path: '/home/agent' }],
          metadata: { swarm_vm: spec.vmId, swarm_user: spec.userId },
          restart: { policy: 'on-failure', max_retries: 5 },
        },
      });
      return { id: m.id };
    } catch (e) {
      await api('DELETE', `/volumes/${volume.id}`).catch(() => {});
      throw e;
    }
  },

  async start(id) {
    try { await api('POST', `/machines/${id}/start`); }
    catch (e) { if (gone(e)) throw Object.assign(new Error('VM not found'), { gone: true }); throw e; }
  },

  async suspend(id) { await api('POST', `/machines/${id}/suspend`); },

  async stop(id) { await api('POST', `/machines/${id}/stop`, {}); },

  async destroy(id) {
    let m: any;
    try { m = await api('GET', `/machines/${id}`); } catch (e) { if (gone(e)) return; throw e; }
    await api('DELETE', `/machines/${id}?force=true`).catch((e) => { if (!gone(e)) throw e; });
    for (const mount of m?.config?.mounts ?? []) await api('DELETE', `/volumes/${mount.volume}`).catch(() => {});
  },

  async get(id) {
    try { const m = await api('GET', `/machines/${id}`); return m.state === 'destroyed' ? null : info(m); }
    catch (e) { if (gone(e)) return null; throw e; }
  },

  async list() {
    const ms = await api<any[]>('GET', '/machines');
    return ms.filter((m) => m.config?.metadata?.swarm_vm && m.state !== 'destroyed').map(info);
  },

  async resize(id, memoryMb, cpus) {
    const m = await api('GET', `/machines/${id}`);
    // The Machines API replaces the whole config. Stop a suspended machine first, and keep it down
    // (skip_launch): it boots with the new size the next time it's needed.
    if (m.state === 'suspended') { await api('POST', `/machines/${id}/stop`, {}); await api('GET', `/machines/${id}/wait?state=stopped&instance_id=${m.instance_id}&timeout=60`).catch(() => {}); }
    await api('POST', `/machines/${id}`, { config: { ...m.config, guest: { ...m.config.guest, cpus, memory_mb: memoryMb } }, skip_launch: true });
  },
};
