/**
 * Local ranking for connected-app tool discovery.
 *
 * Composio's tools.list `query` filter returns alphabetical matches, so a GitHub search for
 * "list repositories" yields GITHUB_ADD_APP_ACCESS_RESTRICTIONS… and never reaches
 * GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER within the first page (GitHub has 900+ tools).
 * The adapters therefore fetch a toolkit's complete tool metadata once, cache it briefly, and rank
 * locally. Ranking only orders provider metadata; it never grants access or changes a tool's
 * read-only attestation (see composio-policy.ts).
 */

export interface DiscoverableTool {
  slug: string;
  description?: string | null;
  tags?: string[] | null;
  isDeprecated?: boolean | null;
  toolkit?: { slug?: string | null } | null;
}

export interface RankOptions {
  limit?: number;
  /** Prefer provider-attested read-only tools (used for setup-phase verification). */
  preferReadOnly?: boolean;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'by', 'from', 'this', 'that', 'is', 'are', 'all', 'any', 'some', 'please', 'pleas', 'can', 'you', 'it', 'its', 'at', 'as', 'be', 'do', 'via', 'using', 'use', 'tool', 'tools', 'app', 'apps', 'who', 'am', 'what', 'which', 'how']);

/** Lowercase word stems: repositories -> repositori, issues -> issu, user -> user. Deterministic and tiny. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'i';
  else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('y')) w = w.slice(0, -1) + 'i'; // repository -> repositori (matches repositories)
  else if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1); // issue -> issu (matches issues), create -> creat
  return w;
}

export function tokens(text: string): string[] {
  return text.split(/[^a-z0-9]+/i).filter((w) => w && !STOP.has(w.toLowerCase())).map(stem).filter((t) => t.length > 1 && !STOP.has(t));
}

const SYNONYMS: Record<string, string[]> = {
  repo: ['repositori'], repositori: ['repo'],
  pr: ['pull'], pull: ['pr'],
  msg: ['messag'], messag: ['msg'],
  dm: ['direct'], mail: ['email', 'messag'], email: ['mail', 'messag'], inbox: ['email', 'mail', 'messag', 'fetch'],
  post: ['send', 'messag', 'creat'], repli: ['send', 'messag'], unread: ['fetch', 'email'],
  cal: ['calendar'], event: ['calendar'],
  delet: ['remov'], remov: ['delet'],
  updat: ['edit', 'modifi'], edit: ['updat'], modifi: ['updat'],
  creat: ['add', 'new', 'open'], add: ['creat'], new: ['creat'], open: ['creat'],
  list: ['get', 'find', 'search'], find: ['search', 'list'], search: ['find', 'list', 'fetch'], get: ['fetch', 'read', 'list'], fetch: ['get'], read: ['get', 'fetch', 'list'],
  todai: ['list'], upcom: ['list'], free: ['freebusi', 'slot'], avail: ['free', 'slot'],
  me: ['authenticat'], my: ['authenticat'], own: ['authenticat'], mine: ['authenticat'], authenticat: ['me', 'my'],
};

function expand(t: string): string[] { return [t, ...(SYNONYMS[t] ?? [])]; }

export function scoreTool(tool: DiscoverableTool, queryTokens: string[], preferReadOnly: boolean): { score: number; matched: number } {
  const slugTokens = tokens(tool.slug);
  const descTokens = new Set(tokens(tool.description ?? ''));
  const tags = tool.tags ?? [];
  // Each slug word can satisfy one query word. Exact words are claimed first so a synonym never
  // steals the word another query term names literally ("reply to a message" keeps REPLY_TO_THREAD
  // ahead of DELETE_MESSAGE).
  const free = new Set(slugTokens);
  let score = 0;
  let matched = 0;
  const pending: string[] = [];
  // The first query word is usually the intent verb ("reply", "list", "create"); naming it in the slug counts a little extra.
  const intent = queryTokens[0];
  for (const q of queryTokens) {
    if (free.has(q)) { free.delete(q); score += q === intent ? 5 : 4; matched++; } else pending.push(q);
  }
  for (const q of pending) {
    const synonym = expand(q).slice(1).find((a) => free.has(a));
    if (synonym) { free.delete(synonym); score += q === intent ? 2.5 : 2; matched++; continue; }
    const prefix = [...free].find((s) => s.length >= 3 && q.length >= 3 && (s.startsWith(q) || q.startsWith(s)));
    if (prefix) { free.delete(prefix); score += 1.5; matched++; continue; }
    if (expand(q).some((a) => descTokens.has(a))) { score += 0.5; matched++; }
  }
  if (queryTokens.length && matched === queryTokens.length) score += 3; // every query term found
  if (!queryTokens.length) score += tags.includes('important') ? 2 : 0;
  else if (tags.includes('important')) score += 0.5;
  if (preferReadOnly && tags.includes('readOnlyHint') && !tags.some((t) => ['createHint', 'updateHint', 'destructiveHint'].includes(t))) score += 3;
  // Prefer the tool whose name says no more than the query asked: each unclaimed slug word (after the toolkit prefix) costs one point.
  if (queryTokens.length) {
    free.delete(slugTokens[0]);
    score -= Math.min(free.size, 8);
  }
  return { score, matched };
}

/**
 * Rank a toolkit's tools for a free-text query. Deprecated tools are excluded; order is stable for equal scores.
 * Matching tools come first. When fewer than `limit` match, the page is completed with the toolkit's default
 * order (provider-marked important tools first), so a discovery call never returns an empty page for a
 * non-empty toolkit; the caller still sees each tool's description and read-only attestation to judge fit.
 */
export function rankAppTools<T extends DiscoverableTool>(tools: T[], query: string, options: RankOptions = {}): T[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const q = tokens(String(query ?? '').slice(0, 300));
  const order = (terms: string[]) => tools
    .filter((t) => !t.isDeprecated)
    .map((t, i) => ({ t, i, ...scoreTool(t, terms, !!options.preferReadOnly) }))
    .filter((x) => !terms.length || x.matched > 0)
    .sort((a, b) => b.score - a.score || a.t.slug.length - b.t.slug.length || a.t.slug.localeCompare(b.t.slug) || a.i - b.i)
    .map((x) => x.t);
  const matches = q.length ? order(q).slice(0, limit) : [];
  if (matches.length >= limit) return matches;
  const seen = new Set(matches.map((t) => t.slug));
  return [...matches, ...order([]).filter((t) => !seen.has(t.slug))].slice(0, limit);
}

/** Small in-memory TTL cache with in-flight de-duplication; metadata only, keyed by caller scope. */
export function createMetadataCache<T>(ttlMs: number, maxEntries = 64) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const entry = { at: Date.now(), value: load() };
      entry.value.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      entries.set(key, entry);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
      return entry.value;
    },
    clear() { entries.clear(); },
  };
}
