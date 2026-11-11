/** Limits include base64 expansion and JSON framing, in both tunnel directions. */
export const SOCKET_BYTES = 8 * 1024 * 1024;
export const FRAME_BYTES = 12 * 1024 * 1024;
export const BUFFER_BYTES = 16 * 1024 * 1024;
export const REQUEST_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 65536;
export function decodeFrame(data: unknown, maximum: number): Buffer {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(maximum / 3) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid tunnel frame.');
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length > maximum) throw new Error('Tunnel frame limit exceeded.');
  return decoded;
}
export async function readRequest(request: Request, signal?: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new Error('Request cancelled.');
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > REQUEST_BYTES) throw new Error('Request limit exceeded.');
      chunks.push(value);
    }
  } finally { signal?.removeEventListener('abort',cancel); await reader.cancel(); reader.releaseLock(); }
}
