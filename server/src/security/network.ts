import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export function publicAddress(value: string): boolean {
  try { return ipaddr.process(value.replace(/^\[|\]$/g, '')).range() === 'unicast'; } catch { return false; }
}
export function publicHttpsUrl(value: string | URL): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname || hostname === 'localhost' || /\.(localhost|local|internal)$/.test(hostname) || (net.isIP(hostname) && !publicAddress(hostname))) throw new Error('Use a public HTTPS endpoint.');
  for (const own of [process.env.APP_URL, process.env.SERVER_URL, process.env.PLATFORM_URL]) {
    if (own && new URL(own).hostname === url.hostname) throw new Error('Platform endpoints cannot be used as MCP servers.');
  }
  return url;
}
/** Checks DNS results inside the connector that actually opens the socket: no check/use rebinding gap. */
export const publicLookup: typeof dns.lookup = ((hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error);
    if (!records.length || records.some(r => !publicAddress(r.address))) return callback(new Error('Private or reserved network destination blocked.'));
    const candidates = options?.family ? records.filter(r => r.family === options.family) : records;
    if (!candidates.length) return callback(new Error('No allowed address.'));
    if (options?.all) callback(null, candidates); else callback(null, candidates[0].address, candidates[0].family);
  });
}) as typeof dns.lookup;
const agent = new Agent({ connections: 8, pipelining: 1, connect: { lookup: publicLookup, timeout: 12_000 }, headersTimeout: 12_000, bodyTimeout: 60_000, maxHeaderSize: 16_384 });
const MAX_BODY = 8 * 1024 * 1024;
/** Responses remain streamed for SSE, with a bounded per-event buffer. */
export const publicFetch: typeof fetch = async (input, init) => {
  const url = publicHttpsUrl(input instanceof Request ? input.url : String(input));
  const request = new Request(input instanceof Request ? input : url, init);
  const response = await fetch(request, { redirect: 'error', dispatcher: agent } as RequestInit);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BODY) { await response.body?.cancel(); throw new Error('MCP response too large.'); }
  if (!response.body) return response;
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  let total = 0, event = 0, previous = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length;
      for (const byte of chunk) {
        if (++event > MAX_BODY) throw new Error('MCP response too large.');
        if (byte === 10 && previous === 10) event = 0;
        // Treat CRLF and LF equally, while still accounting for every byte.
        if (byte !== 13) previous = byte;
      }
      if ((!sse && total > MAX_BODY) || event > MAX_BODY) throw new Error('MCP response too large.');
      controller.enqueue(chunk);
    },
  }));
  return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
};
