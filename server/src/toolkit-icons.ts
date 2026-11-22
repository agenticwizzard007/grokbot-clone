import { publicFetch } from './security/network.js';

const MAX_ICON_BYTES = 400_000;
type Icon = { body: Uint8Array; type: string };
const cache = new Map<string, { expires: number; result: Promise<Icon | null> }>();

/** Catalog URLs only. publicFetch pins public DNS at connect time and rejects redirects. */
export function toolkitIcon(url: string): Promise<Icon | null> {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.result;
  const result = (async () => {
    try {
      const response = await publicFetch(url, { signal: AbortSignal.timeout(8000) });
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !/^image\/(svg\+xml|png|jpeg|webp|gif|x-icon|vnd.microsoft.icon)$/.test(type) || Number(response.headers.get('content-length')) > MAX_ICON_BYTES) {
        await response.body?.cancel(); return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ICON_BYTES) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      if (!size) return null;
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      return { body, type };
    } catch { return null; }
  })();
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + 86_400_000, result };
  cache.set(url, entry);
  void result.then(icon => { if (!icon) entry.expires = Date.now() + 60_000; });
  return result;
}
