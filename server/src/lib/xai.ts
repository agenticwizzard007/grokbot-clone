import OpenAI from 'openai';
import { env } from '../env.js';

export const NO_XAI_KEY = 'No xAI API key yet. Add one in Settings → API keys.';

const clients = new Map<number, { sig: string; client: OpenAI }>();

/** An xAI (OpenAI-compatible) client for the current key; rebuilt when the key changes in Settings. */
export function xaiClient(timeout: number): OpenAI {
  if (!env.xaiKey) throw new Error(NO_XAI_KEY);
  const sig = `${env.xaiKey}|${env.xaiBaseUrl}`;
  let c = clients.get(timeout);
  if (!c || c.sig !== sig) {
    c = { sig, client: new OpenAI({ apiKey: env.xaiKey, baseURL: env.xaiBaseUrl, timeout }) };
    clients.set(timeout, c);
  }
  return c.client;
}
