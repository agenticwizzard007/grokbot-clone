import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import ipaddr from 'ipaddr.js';

function address(value: string | undefined) {
  if (!value || !isIP(value)) return null;
  return ipaddr.process(value);
}

/** Only configured proxy CIDRs may vouch for the hop immediately before them. */
export function clientIpPolicy(cidrs: string) {
  const trusted = cidrs.split(',').map((s) => s.trim()).filter(Boolean).map((cidr) => {
    try { return ipaddr.parseCIDR(cidr); }
    catch { throw new Error('MESSAGING_TRUSTED_PROXY_CIDRS must contain valid IP CIDRs'); }
  });
  const isTrusted = (ip: NonNullable<ReturnType<typeof address>>) =>
    trusted.some(([network, prefix]) =>
      ip instanceof ipaddr.IPv4 && network instanceof ipaddr.IPv4 ? ip.match(network, prefix)
        : ip instanceof ipaddr.IPv6 && network instanceof ipaddr.IPv6 && ip.match(network, prefix));

  return (peer: string | undefined, forwarded: string | undefined): string => {
    let current = address(peer);
    if (!current) return 'unknown';
    const fallback = current.toString();
    if (!isTrusted(current) || !forwarded) return fallback;
    // Bound parsing, and fail closed to the socket peer for malformed chains.
    if (forwarded.length > 2048) return fallback;
    const hops = forwarded.split(',');
    if (hops.length > 32) return fallback;
    for (let i = hops.length - 1; i >= 0 && isTrusted(current); i--) {
      const previous = address(hops[i].trim());
      if (!previous) return fallback;
      current = previous;
    }
    return current.toString();
  };
}

const resolveClientIp = clientIpPolicy(process.env.MESSAGING_TRUSTED_PROXY_CIDRS ?? '');

export function clientIp(c: Context): string {
  let peer: string | undefined;
  try { peer = getConnInfo(c).remote.address; } catch { /* No socket: share the unknown quota. */ }
  return resolveClientIp(peer, c.req.header('x-forwarded-for'));
}
