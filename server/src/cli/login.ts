import { randomUUID } from 'node:crypto';
import { cliRuntime, selectCli, setCliRuntime, type CliProvider } from './store.js';
import { hostedOptions, hostedRunner, refreshHosted, setHostedSigningIn, stopHostedJobsAndWait, type LoginHandle } from './hosted.js';

export type LoginState = 'running' | 'verifying' | 'connected' | 'failed' | 'cancelled';
interface LoginSession {
  id: string; userId: string; provider: CliProvider; state: LoginState;
  output: string; base: number; cursor: number; error?: string; exitCode?: number | null;
  controller: AbortController; handle?: LoginHandle; timer: NodeJS.Timeout; finished?: Promise<void>; settled: boolean;
}
export class CliLoginError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 429 | 503) { super(message); }
}
const sessions = new Map<string, LoginSession>();
const attempts = new Map<string, number[]>();
const MAX_OUTPUT = 512 * 1024;
const isRunning = (s: LoginSession) => s.state === 'running' || s.state === 'verifying';

function append(s: LoginSession, data: string) {
  if (!isRunning(s)) return;
  s.output += data;
  s.cursor += data.length;
  if (s.output.length > MAX_OUTPUT) {
    const excess = s.output.length - MAX_OUTPUT;
    s.output = s.output.slice(excess); s.base += excess;
  }
}

function retire(s: LoginSession) {
  clearTimeout(s.timer);
  s.settled = true;
  if (![...sessions.values()].some((other) => other.id !== s.id && other.userId === s.userId && !other.settled)) setHostedSigningIn(s.userId, false);
  s.timer = setTimeout(() => { sessions.delete(s.id); s.output = ''; }, 120_000).unref();
}

function own(userId: string, id: string): LoginSession {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) throw new CliLoginError('Sign-in terminal not found or expired.', 404);
  return s;
}

function snapshot(s: LoginSession, cursor = 0) {
  const reset = cursor < s.base || cursor > s.cursor;
  return { id: s.id, provider: s.provider, state: s.state, output: s.output.slice(reset ? 0 : cursor - s.base), cursor: s.cursor, reset, ...(s.error ? { error: s.error } : {}), ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}) };
}

export function readLoginSession(userId: string, id: string, cursor = 0) {
  return snapshot(own(userId, id), cursor);
}

export async function startLoginSession(userId: string, provider: CliProvider, cols: number, rows: number) {
  if ([...sessions.values()].some((s) => s.userId === userId && !s.settled)) throw new CliLoginError('A sign-in terminal is already running. Close it before starting another.', 409);
  if ([...sessions.values()].filter((s) => !s.settled).length >= 16) throw new CliLoginError('Sign-in runners are busy. Please try again shortly.', 503);
  const recent = (attempts.get(userId) ?? []).filter((at) => Date.now() - at < 5 * 60_000);
  if (recent.length >= 6) throw new CliLoginError('Too many sign-in attempts. Please wait a few minutes.', 429);
  attempts.set(userId, [...recent, Date.now()]);
  // Explicit Login switches execution to this account's server profile, never to API billing.
  setCliRuntime(userId, 'server');
  setHostedSigningIn(userId, true);
  const controller = new AbortController();
  const s: LoginSession = {
    id: randomUUID(), userId, provider, state: 'running', output: '', base: 0, cursor: 0, controller, settled: false,
    timer: setTimeout(() => {
      if (!isRunning(s)) return;
      s.state = 'failed'; s.error = 'Sign-in timed out. Open a new terminal to try again.';
      controller.abort(); s.handle?.cancel();
    }, 10 * 60_000).unref(),
  };
  sessions.set(s.id, s);
  const fail = (error: unknown) => {
    if (isRunning(s)) { s.state = 'failed'; s.error = error instanceof Error ? error.message : 'Sign-in failed. Please try again.'; }
  };
  // Register the entire lifecycle immediately, including asynchronous profile/PTY
  // setup. Cancellation must wait for startup before deleting any credentials.
  const starting = (async () => {
    await stopHostedJobsAndWait(userId);
    if (controller.signal.aborted) return;
    const options = await hostedOptions(userId);
    if (controller.signal.aborted) return;
    const runner = await hostedRunner();
    if (controller.signal.aborted) return;
    s.handle = await runner.startLogin(provider, { ...options, signal: controller.signal, cols, rows, onData: (data) => append(s, data) });
    if (controller.signal.aborted) s.handle.cancel();
  })().catch(fail);
  s.finished = starting.then(async () => {
    if (!s.handle) return;
    const { exitCode } = await s.handle.done;
    s.exitCode = exitCode;
    if (!isRunning(s)) return;
    if (exitCode !== 0) {
      s.state = 'failed'; s.error = 'The CLI did not finish signing in. Review the terminal output and try again.'; return;
    }
    s.state = 'verifying';
    const providers = await refreshHosted(userId, controller.signal);
    if (controller.signal.aborted || !isRunning(s) || cliRuntime(userId) !== 'server') return;
    const auth = providers[provider];
    if (!auth.installed || !auth.authenticated || !auth.subscription || auth.error) {
      s.state = 'failed'; s.error = 'The CLI could not verify a subscription login. Use your ChatGPT or Claude subscription account.'; return;
    }
    selectCli(userId, provider);
    s.state = 'connected';
  }).catch(fail).finally(() => retire(s));
  await starting;
  return snapshot(s);
}

export function writeLoginSession(userId: string, id: string, data: string) {
  const s = own(userId, id);
  if (s.state !== 'running' || !s.handle) throw new CliLoginError('This sign-in terminal is no longer accepting input.', 409);
  if (typeof data !== 'string' || !data.length || Buffer.byteLength(data) > 8192) throw new CliLoginError('Terminal input must be between 1 and 8192 bytes.', 400);
  s.handle.write(data);
}

export function resizeLoginSession(userId: string, id: string, cols: number, rows: number) {
  const s = own(userId, id);
  if (s.state !== 'running' || !s.handle) throw new CliLoginError('This sign-in terminal is no longer running.', 409);
  s.handle.resize(cols, rows);
}

export async function cancelLoginSession(userId: string, id: string) {
  const s = own(userId, id);
  if (isRunning(s)) { s.state = 'cancelled'; s.controller.abort(); s.handle?.cancel(); }
  await s.finished;
  clearTimeout(s.timer); sessions.delete(id); s.output = '';
  if (![...sessions.values()].some((other) => other.userId === userId && !other.settled)) setHostedSigningIn(userId, false);
}

export async function cancelUserLogins(userId: string) {
  await Promise.all([...sessions.values()].filter((s) => s.userId === userId).map((s) => cancelLoginSession(userId, s.id)));
}

process.once('exit', () => { for (const s of sessions.values()) { s.controller.abort(); s.handle?.cancel(); } });
