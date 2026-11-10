import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { createPairing } from './local.js';
import { sealSecret, unsealSecret } from '../settings.js';

/**
 * "Use this computer": when Grokbot runs on the user's own Mac/PC, the server starts the companion
 * itself (as a child process) instead of asking the user to run a command. Only offered to requests
 * from this machine (loopback). Remembered across restarts.
 */

const SCRIPT = new URL('../../../companion/grokbot-companion.mjs', import.meta.url).pathname;
const SETTING = 'this_computer';

let child: ChildProcess | null = null;
let owner: string | null = null;
let stopping = false;
let restarts: number[] = [];

export const thisComputerAvailable = () => fs.existsSync(SCRIPT);
export const thisComputerUser = () => owner;

function launch(userId: string, token: string) {
  owner = userId;
  stopping = false;
  const args = [SCRIPT, '--server', `http://127.0.0.1:${env.port}`, '--token', token, '--parent-pid', String(process.pid)];
  if (env.localDesktop) args.push('--desktop');
  else if (process.env.COMPANION_HEADED === '1') args.push('--headed');
  child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (d: Buffer) => String(d).trim().split('\n').forEach((l) => console.log(`[this-computer] ${l}`));
  child.stdout?.on('data', tag);
  child.stderr?.on('data', tag);
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    // Restart after a crash, but give up if it keeps failing (e.g. the token was revoked).
    restarts = [...restarts.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (code === 1 || restarts.length > 4) { console.warn(`[this-computer] companion stopped (code ${code}); use Settings → Computer to start it again`); owner = null; return; }
    setTimeout(() => { if (!stopping && !child) launch(userId, token); }, 2000);
  });
}

export function startThisComputer(userId: string) {
  stopThisComputer();
  const token = createPairing(userId);
  db.prepare('INSERT OR REPLACE INTO server_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?)').run(SETTING, sealSecret(JSON.stringify({ userId, token })), userId, now());
  launch(userId, token);
}

export function stopThisComputer() {
  stopping = true;
  owner = null;
  db.prepare('DELETE FROM server_settings WHERE key=?').run(SETTING);
  if (child) { child.kill('SIGINT'); child = null; }
}

/** At startup: bring the companion back if this computer was in use before the restart. */
export function resumeThisComputer() {
  const row = db.prepare('SELECT value FROM server_settings WHERE key=?').get(SETTING) as { value: string } | undefined;
  if (!row || !thisComputerAvailable()) return;
  const saved = unsealSecret(row.value);
  if (!saved) return;
  const { userId, token } = JSON.parse(saved) as { userId: string; token: string };
  console.log('[this-computer] resuming the companion for this computer');
  launch(userId, token);
}

// Take the companion down with the server (SIGTERM/SIGINT skip 'exit' handlers unless we handle them).
const killChild = () => { if (child) { stopping = true; child.kill('SIGINT'); } };
process.on('exit', killChild);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(sig, () => { killChild(); process.exit(0); });
}
