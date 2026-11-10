/**
 * A VM provider API, used by the cloudvm computer provider (../cloudvm.ts). Each user has one VM;
 * the companion runs inside it (--multi) and connects out to this server with a token bound to the VM.
 * Drivers: Fly.io Machines (fly.ts) and local processes for dev and tests (fake.ts). Self-hosted
 * Firecracker can be added later as another driver.
 */

export type VmState = 'creating' | 'starting' | 'started' | 'stopping' | 'stopped' | 'suspending' | 'suspended' | 'destroying' | 'destroyed' | 'unknown';

export interface VmSpec {
  /** Our VM id (stored in the provider's metadata, for reconciling). */
  vmId: string;
  userId: string;
  /** The companion's pairing token, delivered into the VM as a file only the companion can read. */
  token: string;
  /** Where the companion connects (and downloads its current version from). */
  serverUrl: string;
  image: string;
  memoryMb: number;
  cpus: number;
  region?: string;
  volumeGb: number;
  /** Reuse this disk (a returning user whose VM was archived) instead of creating one. */
  volumeId?: string;
}

export interface VmInfo {
  id: string;
  state: VmState;
  vmId?: string;
  userId?: string;
  image?: string;
  memoryMb?: number;
}

export interface VmDriver {
  name: 'fly' | 'fake';
  /** Create the VM (with its persistent disk for the Bots' files and browser profiles, or spec.volumeId) and boot it. */
  create(spec: VmSpec): Promise<{ id: string; volumeId?: string }>;
  /** Boot a stopped VM, or resume a suspended one. */
  start(id: string): Promise<void>;
  /** Freeze the VM (memory kept); start() resumes it. */
  suspend(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Delete the VM and its disk. Succeeds if it's already gone. */
  destroy(id: string): Promise<void>;
  /** Delete the VM but keep its disk (long-idle users cost only the disk); returns the disk to reuse later. */
  archive(id: string): Promise<{ volumeId?: string }>;
  /** Delete a kept disk (an archived user's account was deleted). */
  destroyVolume(volumeId: string): Promise<void>;
  /** The VM's state, or null if it no longer exists. */
  get(id: string): Promise<VmInfo | null>;
  /** Every VM this server created (for cleaning up orphans). */
  list(): Promise<VmInfo[]>;
  /** Change memory/CPUs (applied on the next boot; a running VM restarts). */
  resize(id: string, memoryMb: number, cpus: number): Promise<void>;
}
