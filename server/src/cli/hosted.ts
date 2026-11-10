import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { env } from '../env.js';
import { db } from '../db.js';
import { sha256 } from '../lib/ids.js';
import type { CliProviders } from './bridge.js';
import type { CliProvider } from './store.js';

const require = createRequire(import.meta.url);
// Claude uses OS Keychain on macOS; deleting a profile directory would leave
// that authorization behind. Hosted profiles currently support Linux only.
export const serverLoginAvailable = () => process.env.SWARM_CLI_SERVER_LOGIN !== '0' && process.platform === 'linux';
export const emptyCliProviders = (): CliProviders => ({
  codex: { installed: false, authenticated: false, subscription: false },
  claude: { installed: false, authenticated: false, subscription: false },
});
const statuses = new Map<string, CliProviders>();
const active = new Map<string, Set<AbortController>>();
const signingIn = new Set<string>();
const deleting = new Set<string>();
let totalJobs = 0;

export interface LoginHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  cancel(): void;
  done: Promise<{ exitCode: number | null }>;
}
export interface RunnerOptions {
  env: NodeJS.ProcessEnv;
  codexPath: string;
  claudePath: string;
  pythonPath?: string;
  fileCredentials?: boolean;
  signal?: AbortSignal;
  onData?: (data: string) => void;
  cols?: number;
  rows?: number;
}
interface Runner {
  checkProviders(options: RunnerOptions): Promise<CliProviders>;
  runGeneration(params: unknown, options: RunnerOptions): Promise<unknown>;
  startLogin(provider: CliProvider, options: RunnerOptions): Promise<LoginHandle>;
}
let runnerPromise: Promise<Runner> | undefined;
export function hostedRunner(): Promise<Runner> {
  return runnerPromise ??= import(new URL('../../../companion/cli-bridge.mjs', import.meta.url).href) as Promise<Runner>;
}

function executable(pkg: string, command: string, override: string | undefined): string {
  if (override) return path.resolve(override);
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = require(manifestPath);
  return path.resolve(path.dirname(manifestPath), manifest.bin[command]);
}

export function profilePath(userId: string): string {
  const root = process.env.CLI_PROFILES_DIR || path.join(path.dirname(env.dbPath), 'cli-profiles');
  return path.resolve(root, sha256(userId));
}

/** One credential home per account, never the server process's home or another user's CLI state. */
export async function hostedOptions(userId: string): Promise<RunnerOptions> {
  if (!serverLoginAvailable()) throw new Error('Server CLI login is disabled on this server.');
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new Error('Account no longer exists.');
  if (deleting.has(userId)) throw new Error('This CLI profile is being disconnected. Please try again shortly.');
  const home = profilePath(userId);
  await fs.mkdir(path.dirname(home), { recursive: true, mode: 0o700 });
  for (const dir of [home, ...['.codex', '.claude', '.config', '.cache', '.local/share', '.local/state'].map((p) => path.join(home, p))]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
  // A fresh environment prevents server keys, proxies, profiles and host credentials leaking into any CLI.
  return {
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, USER: 'swarm-cli', LOGNAME: 'swarm-cli',
      LANG: 'C.UTF-8', CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    },
    codexPath: executable('@openai/codex', 'codex', process.env.SWARM_CLI_CODEX_PATH),
    claudePath: executable('@anthropic-ai/claude-code', 'claude', process.env.SWARM_CLI_CLAUDE_PATH),
    ...(process.env.SWARM_CLI_PYTHON_PATH ? { pythonPath: process.env.SWARM_CLI_PYTHON_PATH } : {}),
    fileCredentials: true,
  };
}

export const hostedStatus = (userId: string) => ({ connected: statuses.has(userId) && serverLoginAvailable(), providers: statuses.get(userId) ?? emptyCliProviders() });
export const setHostedSigningIn = (userId: string, value: boolean) => { if (value) signingIn.add(userId); else signingIn.delete(userId); };

async function job<T>(userId: string, signal: AbortSignal | undefined, fn: (options: RunnerOptions) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error('CLI request cancelled.');
  const jobs = active.get(userId) ?? new Set<AbortController>();
  if (jobs.size >= 4 || totalJobs >= 32) throw new Error('CLI runners are busy. Try again when a running task finishes.');
  const controller = new AbortController();
  active.set(userId, jobs); jobs.add(controller); totalJobs++;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const options = await hostedOptions(userId);
    if (controller.signal.aborted) throw new Error('CLI request cancelled.');
    return await fn({ ...options, signal: controller.signal });
  } finally {
    signal?.removeEventListener('abort', abort);
    jobs.delete(controller); totalJobs--;
    if (!jobs.size) active.delete(userId);
  }
}

export async function refreshHosted(userId: string, signal?: AbortSignal): Promise<CliProviders> {
  const providers = await job(userId, signal, async (opts) => (await hostedRunner()).checkProviders(opts));
  if (!signal?.aborted && !deleting.has(userId) && db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) statuses.set(userId, providers);
  return providers;
}

export async function hostedGenerate(userId: string, params: unknown, signal?: AbortSignal) {
  if (signingIn.has(userId)) throw new Error('CLI sign-in is in progress. Finish or cancel it before starting a model request.');
  return job(userId, signal, async (opts) => (await hostedRunner()).runGeneration(params, opts));
}

export function stopHostedJobs(userId: string) {
  for (const controller of active.get(userId) ?? []) controller.abort();
}

export async function stopHostedJobsAndWait(userId: string) {
  stopHostedJobs(userId);
  for (let i = 0; active.get(userId)?.size && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  if (active.get(userId)?.size) throw new Error('A CLI request is still stopping. Please try again shortly.');
}

export async function deleteHostedProfile(userId: string) {
  deleting.add(userId);
  try {
    statuses.delete(userId);
    // Cancellation stops child processes asynchronously; wait before removing credentials.
    await stopHostedJobsAndWait(userId);
    await fs.rm(profilePath(userId), { recursive: true, force: true });
    statuses.delete(userId);
  } finally { deleting.delete(userId); }
}

process.once('exit', () => { for (const userId of active.keys()) stopHostedJobs(userId); });
