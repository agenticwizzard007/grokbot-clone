import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function retryCommand(work, { attempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.error } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt >= attempts) throw new Error(`Command failed after ${attempts} attempts`, { cause: error });
      const delay = 5000 * 2 ** (attempt - 1);
      log(`Attempt ${attempt} failed; retrying in ${delay / 1000} seconds`);
      await sleep(delay);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('A staging command is required');
  await retryCommand(() => execFileSync(command, args, { stdio: 'inherit', timeout: 180_000 }));
}
