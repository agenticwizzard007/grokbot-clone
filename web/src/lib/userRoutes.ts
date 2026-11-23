/** User-facing routes are resolved only against the signed-in account's Bot list. */
type RouteBot = { id: string; name: string };

// A stable 64-bit fingerprint keeps duplicate names distinct across devices and renames.
// This is a route label, never an authorization credential.
function routeKey(id: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(id)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, '0');
}

export function botSlug(bot: RouteBot): string {
  const name = bot.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'bot';
  return `${name}~${routeKey(bot.id)}`;
}

export function routeBot<T extends RouteBot>(reference: string, bots: T[]): T | undefined {
  // Accept old ID links, then replace them with the canonical slug on navigation.
  const legacy = bots.find(bot => bot.id === reference);
  if (legacy) return legacy;
  const key = reference.match(/~([a-z0-9]{13})$/)?.[1];
  const matches = key ? bots.filter(bot => routeKey(bot.id) === key) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export type WorkTab = 'Tasks' | 'Team' | 'Goals' | 'Reports';
export interface WorkRoute { tab: WorkTab; botSlug?: string }
const WORK_TABS: WorkTab[] = ['Tasks', 'Team', 'Goals', 'Reports'];
export function linkedWork(hash: string): WorkRoute | null {
  const match = hash.match(/^#(?:bot\/([^/]+)\/)?(tasks|team|goals|reports)$/);
  if (!match) return null;
  try {
    return { tab: WORK_TABS.find(tab => tab.toLowerCase() === match[2])!, ...(match[1] ? { botSlug: decodeURIComponent(match[1]) } : {}) };
  } catch { return null; }
}
export const workHash = (route: WorkRoute) => `#${route.botSlug ? `bot/${encodeURIComponent(route.botSlug)}/` : ''}${route.tab.toLowerCase()}`;
