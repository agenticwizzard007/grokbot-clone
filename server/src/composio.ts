import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { gatewayRequest } from './runtime/gateway-client.js';
import { assertTenant, isTenant, tenantId } from './deployment.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import { composioCredentials, composioHeaders, composioIdentity } from './composio-auth.js';
import type { Toolkit } from './types.js';
import { appArguments, publicAppTools, trustedReadOnly } from './platform/composio-policy.js';
import { createMetadataCache, rankAppTools } from './platform/app-discovery.js';

/** Full toolkit metadata (no credentials), cached briefly per project key so discovery can rank locally. */
const toolkitMetadata = createMetadataCache<Awaited<ReturnType<ReturnType<typeof composio>['tools']['getRawComposioTools']>>>(5 * 60_000);

const makeClient = (apiKey: string) => new Composio({ ...composioCredentials(apiKey), provider: new OpenAIResponsesProvider() });
let current: { key: string; client: ReturnType<typeof makeClient> } | null = null;
/** The Composio client for the current key; rebuilt (and caches dropped) when the key changes in Settings. */
export function composio() {
  if (isTenant) throw new Error('Raw Composio access is forbidden in tenant runtimes.');
  const key = env.composioKey;
  if (!key) throw new Error(APPS_OFF);
  const identity = composioIdentity();
  if (!current || current.key !== identity) {
    current = { key: identity, client: makeClient(key) };
    sessionCache.clear();
    promptConnections.clear();
    catalogCache = null;
    toolkitMetadata.clear();
  }
  return current.client;
}

/** Shown when connected apps are used without a COMPOSIO_API_KEY. */
export const APPS_OFF = "Connected apps aren't set up on this server (it needs a COMPOSIO_API_KEY).";

const REST = 'https://backend.composio.dev/api/v3.1';
async function rest<T = any>(path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${REST}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Composio returned ${res.status}. Check the server's Composio key in Settings → API keys.`);
  return res.json() as Promise<T>;
}

// ---------- catalog (user-independent, cached) ----------

type CatalogItem = Omit<Toolkit, 'connected'>;
let catalogCache: { at: number; items: CatalogItem[] } | null = null;

export async function catalog(): Promise<CatalogItem[]> {
  if (isTenant) {
    const items: CatalogItem[] = []; const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await gatewayRequest(tenantId, 'catalog', { cursor });
      items.push(...(page.items ?? []).map((t: any) => ({ slug: t.slug, name: t.name, logo: t.meta?.logo, description: t.meta?.description, categories: (t.meta?.categories ?? []).map((c: any) => c.name ?? c.id), managedAuth: true, noAuth: !!t.noAuth })));
      cursor = page.nextCursor ?? undefined;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Invalid catalog pagination.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  if (!env.composioEnabled) return [];
  composio(); // Apply key changes before consulting a cache.
  const key = composioIdentity();
  const headers = composioHeaders();
  if (catalogCache && Date.now() - catalogCache.at < 3600_000) return catalogCache.items;
  const items: CatalogItem[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const r = await rest<any>(`/toolkits?sort_by=usage&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers);
    for (const t of r.items ?? []) {
      items.push({
        slug: t.slug,
        name: t.name,
        logo: t.meta?.logo,
        description: t.meta?.description,
        categories: (t.meta?.categories ?? []).map((c: any) => c.name ?? c.id),
        managedAuth: (t.composio_managed_auth_schemes ?? []).length > 0,
        noAuth: !!t.no_auth,
      });
    }
    cursor = r.next_cursor;
    if (cursor && cursors.has(cursor)) throw new Error('Composio returned a repeated catalog page. Please retry.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  assertCurrentKey(key);
  catalogCache = { at: Date.now(), items };
  return items;
}

export async function toolkitInfo(slug: string): Promise<CatalogItem | undefined> {
  return (await catalog()).find((t) => t.slug === slug);
}

// ---------- per-user connections ----------

const promptConnections = new Map<string, { expires: number; promise: Promise<Set<string>> }>();

/** Only prompt context may use a short cache; connection management always reads the provider. */
export async function connectedToolkits(userId: string, cached = false): Promise<Set<string>> {
  if (cached && env.composioEnabled && !isTenant) {
    composio(); // Invalidate across credential/project changes before reading.
    let entry = promptConnections.get(userId);
    if (!entry || Date.now() >= entry.expires) {
      entry = { expires: Date.now() + 30_000, promise: connectedToolkits(userId) };
      promptConnections.set(userId, entry);
      const currentEntry = entry;
      entry.promise.catch(() => { if (promptConnections.get(userId) === currentEntry) promptConnections.delete(userId); });
    }
    return new Set(await entry.promise);
  }
  return new Set((await connectionsDetail(userId)).filter((c) => c.status === 'ACTIVE').map((c) => c.toolkit));
}

export async function connectionsDetail(userId: string): Promise<{ id: string; toolkit: string; status: string; revision?: number; isDefault?: boolean }[]> {
  assertTenant(userId);
  if (isTenant) return gatewayRequest(userId, 'connections');
  if (!env.composioEnabled) return [];
  const client = composio();
  const key = composioIdentity();
  const items: { id: string; toolkit: string; status: string }[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const r = await client.connectedAccounts.list({ userIds: [userId], accountType: 'PRIVATE', limit: 100, cursor });
    items.push(...r.items.map((i) => ({ id: i.id, toolkit: i.toolkit.slug, status: i.status })));
    cursor = r.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Composio returned a repeated connections page. Please retry.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  assertCurrentKey(key);
  return items;
}

export async function disconnect(userId: string, toolkit: string) {
  if (isTenant) {
    const own = (await connectionsDetail(userId)).filter(c => c.toolkit === toolkit);
    if (own.length > 1) throw new Error('Select a specific connected account to disconnect.');
    if (own[0]) await gatewayRequest(userId, 'disconnect', { connectionId: own[0].id });
    return;
  }
  const client = composio();
  const key = composioIdentity();
  try {
    for (const c of await connectionsDetail(userId)) {
      assertCurrentKey(key);
      if (c.toolkit === toolkit) await client.connectedAccounts.delete(c.id);
    }
  } finally {
    invalidateComposioSession(userId);
  }
}

// ---------- sessions (tool router) ----------

type Session = Awaited<ReturnType<ReturnType<typeof makeClient>['create']>>;
const sessionCache = new Map<string, { at: number; promise: Promise<Session> }>();
const SESSION_RECHECK_MS = 5 * 60_000;

function assertCurrentKey(key: string) {
  if (composioIdentity() !== key) throw new Error('The Composio key changed. Please retry.');
}

/** A connection change must also drop the saved session, which may still select the old account. */
/** Drop cached toolkit metadata (tests and credential/project changes). Never affects execution checks, which always re-fetch by slug. */
export function resetAppDiscovery() { toolkitMetadata.clear(); }

export function invalidateComposioSession(userId: string) {
  sessionCache.delete(userId);
  promptConnections.delete(userId);
  db.prepare('DELETE FROM composio_sessions WHERE user_id=?').run(userId);
}

export async function sessionFor(userId: string): Promise<Session> {
  if (!env.composioEnabled) throw new Error(APPS_OFF);
  const client = composio();
  const key = composioIdentity();
  const cached = sessionCache.get(userId);
  if (cached && Date.now() - cached.at < SESSION_RECHECK_MS) return cached.promise;
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const entry = { at: Date.now(), promise: null! as Promise<Session> };
  entry.promise = (async () => {
    const row = db.prepare('SELECT session_id, key_fingerprint FROM composio_sessions WHERE user_id=?').get(userId) as { session_id: string; key_fingerprint: string | null } | undefined;
    let session: Session | undefined;
    if (row?.key_fingerprint === fingerprint) {
      try { session = await client.use(row.session_id); }
      catch (e: any) {
        // Only missing/expired sessions should be recreated. Auth and network failures must surface.
        if (![404, 410].includes(e?.status ?? e?.cause?.status)) throw e;
      }
    }
    session ??= await client.create(userId, { manageConnections: false });
    assertCurrentKey(key);
    if (sessionCache.get(userId) !== entry) throw new Error('App connections changed. Please retry.');
    db.prepare('INSERT OR REPLACE INTO composio_sessions(user_id, session_id, key_fingerprint) VALUES (?,?,?)').run(userId, session.sessionId, fingerprint);
    return session;
  })();
  sessionCache.set(userId, entry);
  try { return await entry.promise; }
  catch (e) {
    if (sessionCache.get(userId) === entry) sessionCache.delete(userId);
    throw e;
  }
}

/** Start a connect flow; returns the hosted Connect Link URL. */
export async function startConnect(userId: string, toolkit: string, callbackUrl: string): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
  if (isTenant) return gatewayRequest(userId, 'connect', { toolkit, native: new URL(callbackUrl).searchParams.get('native') === '1' });
  const session = await sessionFor(userId);
  const req = await session.authorize(toolkit, { callbackUrl });
  if (!req.redirectUrl) throw new Error('Composio did not return a connection link. Please retry.');
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** Narrow app adapter. Models cannot acquire project administration or arbitrary proxy/workbench access. */
export async function composioTools(userId: string): Promise<any[]> {
  assertTenant(userId);
  if (!env.composioEnabled) return [];
  return [
    { type: 'function', name: 'SWARM_APPS_SEARCH', description: 'Discover tools for one of your private connected apps. Describe the action in a few words (for example "list my repositories" or "send a message"); results are ranked by relevance and mark provider-attested read-only tools. Specify an account when several are connected.', parameters: { type: 'object', properties: { toolkit: { type: 'string' }, query: { type: 'string' }, connectionId: { type: 'string' } }, required: ['toolkit', 'query'], additionalProperties: false } },
    { type: 'function', name: 'SWARM_APPS_EXECUTE', description: 'Execute a discovered app tool using its exact private connection and revision. Never retry an uncertain write automatically.', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, revision: { type: 'integer' }, tool_slug: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['connectionId', 'revision', 'tool_slug', 'arguments'], additionalProperties: false } },
  ];
}
export interface ComposioExecutionResult { data?: unknown; error?: unknown; successful?: boolean; resultType?: string; logId?: string }
export async function executeComposio(userId: string, name: string, args: Record<string, unknown>, options: { readOnly?: boolean } = {}): Promise<ComposioExecutionResult> {
  assertTenant(userId);
  if (!['SWARM_APPS_SEARCH','SWARM_APPS_EXECUTE'].includes(name)) throw new Error('Unsupported connected-app operation.');
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw new Error('Invalid execution mode.');
  if (isTenant) {
    if (name === 'SWARM_APPS_SEARCH') return { data: await gatewayRequest(userId, 'search', { toolkit: args.toolkit, query: args.query, connectionId: args.connectionId, ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}) }) };
    return gatewayRequest<ComposioExecutionResult>(userId, 'execute', { connectionId: args.connectionId, revision: args.revision, slug: args.tool_slug, arguments: args.arguments, dispatchId: randomUUID(), ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}) });
  }
  // Development adapter still enforces private account selection and never executes Tool Router meta tools.
  const client = composio(), key = composioIdentity();
  const accounts = (await connectionsDetail(userId)).filter(c => c.status === 'ACTIVE');
  assertCurrentKey(key);
  if (name === 'SWARM_APPS_SEARCH') {
    const choices = accounts.filter(c => c.toolkit === args.toolkit && (!args.connectionId || c.id === args.connectionId));
    if (choices.length !== 1) throw new Error('Choose a specific connected account.');
    // Composio's server-side query filter returns alphabetical matches (GitHub alone has 900+ tools), so fetch the
    // toolkit's metadata once and rank locally. Ranking orders provider metadata only; it never grants access.
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const all = await toolkitMetadata.get(`${fingerprint}:${choices[0].toolkit}`, () => client.tools.getRawComposioTools({ toolkits: [choices[0].toolkit], limit: 5000 }));
    assertCurrentKey(key);
    const tools = rankAppTools(all, String(args.query ?? ''), { limit: 20, preferReadOnly: options.readOnly === true });
    const current = (await connectionsDetail(userId)).find(c => c.id === choices[0].id && c.toolkit === choices[0].toolkit && c.status === 'ACTIVE');
    assertCurrentKey(key);
    if (!current) throw new Error('Connection not found.');
    return { data: { connectionId: choices[0].id, revision: 1, tools: publicAppTools(tools, choices[0].toolkit) } };
  }
  const account = accounts.find(c => c.id === args.connectionId);
  const slug = String(args.tool_slug ?? '');
  if (!account || !/^[A-Z][A-Z0-9_]{2,199}$/.test(slug) || slug.startsWith('COMPOSIO_') || args.revision !== 1) throw new Error('Connection not found.');
  appArguments(args.arguments);
  const tool = await client.tools.getRawComposioToolBySlug(slug);
  assertCurrentKey(key);
  if (tool.toolkit?.slug !== account.toolkit || !tool.version || tool.version === 'latest') throw new Error('Invalid tool selection.');
  if (tool.slug !== undefined && tool.slug !== slug) throw new Error('Invalid tool selection.');
  if (options.readOnly && !trustedReadOnly(tool)) throw new Error('Setup requires a provider-verified read-only app tool. Write or unknown tool metadata is refused.');
  const current = (await connectionsDetail(userId)).find(c => c.id === account.id && c.toolkit === account.toolkit && c.status === 'ACTIVE');
  assertCurrentKey(key);
  if (!current) throw new Error('Connection not found.');
  return client.tools.execute(slug, { userId, connectedAccountId: account.id, version: tool.version, arguments: args.arguments });
}

/** Which inner tool slugs a Composio meta-tool call would run (for approval checks). */
export function innerToolSlugs(name: string, args: any): string[] {
  if (name === 'SWARM_APPS_SEARCH') return [];
  if (name === 'SWARM_APPS_EXECUTE') return [String(args?.tool_slug ?? 'UNKNOWN_WRITE')];
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const list = args?.tools ?? args?.tool_calls ?? args?.actions ?? [];
    return (Array.isArray(list) ? list : []).map((t: any) => String(t.tool_slug ?? t.slug ?? t.name ?? t.tool ?? '')).filter(Boolean);
  }
  if (name.startsWith('COMPOSIO_')) return [];
  return [name];
}

const READ_RE = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
export const isReadOnlySlug = (slug: string) => READ_RE.test(slug.toUpperCase());


/** Account-specific management never accepts a toolkit as an ownership proof. */
export async function manageConnection(userId: string, id: string, operation: 'disconnect' | 'default') {
  assertTenant(userId);
  if (isTenant) return gatewayRequest(userId, operation, { connectionId: id });
  const own = (await connectionsDetail(userId)).find(c => c.id === id && c.status === 'ACTIVE');
  if (!own) throw new Error('Connection not found.');
  if (operation === 'default') throw new Error('Saved account defaults require a private tenant environment.');
  await composio().connectedAccounts.delete(id);
  invalidateComposioSession(userId);
}
