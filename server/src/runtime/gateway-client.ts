import fs from 'node:fs/promises';
import { assertTenant, isTenant } from '../deployment.js';
import { currentSessionHash } from '../security/request-context.js';
export class GatewayError extends Error {
  constructor(readonly status: number) { super(`Connected app operation refused (${status}).`); }
}
export async function gatewayRequest<T = any>(userId: string, operation: string, input: Record<string, unknown> = {}): Promise<T> {
  assertTenant(userId);
  const endpoint = process.env.COMPOSIO_GATEWAY_URL, tokenPath = process.env.RUNTIME_TOKEN_FILE;
  if (!isTenant || !endpoint?.startsWith('https://') || !tokenPath?.startsWith('/run/swarm/')) throw new Error('Connected apps gateway unavailable.');
  const authorization = (await fs.readFile(tokenPath, 'utf8')).trim();
  const res = await fetch(new URL('/rpc', endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65_000),
    headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, input, sessionHash: currentSessionHash() }) }).catch(() => { throw new GatewayError(503); });
  if (!res.ok) { await res.body?.cancel(); throw new GatewayError(res.status); }
  // Bound streamed decoding before JSON allocation.
  const reader = res.body?.getReader(); if (!reader) throw new Error('Empty gateway response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) throw new Error('Gateway response too large.'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
