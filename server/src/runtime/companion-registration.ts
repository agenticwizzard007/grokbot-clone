import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isTenant } from '../deployment.js';
export type CompanionScope = 'desktop' | 'native-local' | 'cli';
/** The directory holds only a capability hash and routing metadata, never the pairing secret. */
export async function registerCompanion(scope: CompanionScope, token?: string) {
  if (!isTenant) return;
  const authorization = (await fs.readFile(process.env.RUNTIME_TOKEN_FILE!, 'utf8')).trim();
  const result = await fetch(new URL('/internal/runtime/companions', process.env.PLATFORM_URL!), {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(15_000),
    headers:{authorization:`Bearer ${authorization}`,'content-type':'application/json'},
    body:JSON.stringify({scope,hash:token ? createHash('sha256').update(token).digest('hex') : null}),
  });
  if (!result.ok) throw new Error('Computer registration failed. Pair again from Settings.');
}
