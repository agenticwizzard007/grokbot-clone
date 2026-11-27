import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SourceError, type Params, type SourceData } from './catalog.js';

interface Job { source: string; userId: string; params: Params; resolve(value: SourceData): void; reject(error: Error): void }

/** SQLite is synchronous. A separate process makes the 200 ms deadline interruptible,
 * including native SQL work, without blocking authenticated requests on the server. */
export class SourceRunner {
  private child?: ChildProcess;
  private ready = false;
  private queue: Job[] = [];
  private active?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private startup?: ReturnType<typeof setTimeout>;

  run(source: string, userId: string, params: Params): Promise<SourceData> {
    if (this.queue.length >= 128) return Promise.reject(new SourceError('unavailable', 'Data sources are busy.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ source, userId, params, resolve, reject });
      if (!this.child) this.start();
      this.pump();
    });
  }

  private start() {
    const ts = import.meta.url.endsWith('.ts');
    const child = fork(fileURLToPath(new URL(`./worker.${ts ? 'ts' : 'js'}`, import.meta.url)), [], {
      execArgv: ts ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    this.startup = setTimeout(() => this.fail(new SourceError('unavailable', 'Data sources could not start.')), 10_000);
    child.on('message', (message: any) => {
      if (this.child !== child) return;
      if (message.ready) { clearTimeout(this.startup); this.ready = true; this.pump(); return; }
      const job = this.active;
      if (!job) return;
      clearTimeout(this.timer); this.active = undefined;
      if (message.ok) job.resolve(message.data);
      else job.reject(new SourceError(message.code === 'not_found' ? 'not_found' : 'unavailable', message.code === 'not_found' ? 'Bot not found.' : 'Data is unavailable.'));
      this.pump();
    });
    child.on('error', () => { if (this.child === child) this.fail(new SourceError('unavailable', 'Data is unavailable.')); });
    child.on('exit', () => { if (this.child === child) this.fail(new SourceError('unavailable', 'Data is unavailable.')); });
  }

  private pump() {
    if (!this.ready || this.active || !this.child) return;
    const job = this.queue.shift();
    if (!job) { this.child.unref(); this.child.channel?.unref(); return; }
    this.child.ref(); this.child.channel?.ref();
    this.active = job;
    this.timer = setTimeout(() => this.fail(new SourceError('timeout', 'Data source timed out.')), 200);
    this.child.send({ source: job.source, userId: job.userId, params: job.params });
  }

  private fail(error: SourceError) {
    clearTimeout(this.timer); clearTimeout(this.startup);
    const child = this.child;
    this.child = undefined; this.ready = false;
    child?.kill('SIGKILL');
    this.active?.reject(error); this.active = undefined;
    // Queued sources did not run. Keep their errors distinct from the timed out query.
    for (const job of this.queue.splice(0)) job.reject(new SourceError('unavailable', 'Data is unavailable. Retry shortly.'));
  }

  close() { this.fail(new SourceError('unavailable', 'Data sources are closed.')); }
}
