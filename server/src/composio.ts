import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import type { Toolkit } from './types.js';

const makeClient = (apiKey: string) => new Composio({ apiKey, provider: new OpenAIResponsesProvider() });
let current: { key: string; client: ReturnType<typeof makeClient> } | null = null;
/** The Composio client for the current key; rebuilt (and caches dropped) when the key changes in Settings. */
export function composio() {
  const key = env.composioKey;
  if (!key) throw new Error(APPS_OFF);
  if (!current || current.key !== key) {
    current = { key, client: makeClient(key) };
    sessionCache.clear();
    catalogCache = null;
  }
  return current.client;
}

/** Shown when connected apps are used without a COMPOSIO_API_KEY. */
export const APPS_OFF = "Connected apps aren't set up on this server (it needs a COMPOSIO_API_KEY).";

const REST = 'https://backend.composio.dev/api/v3.1';
async function rest<T = any>(path: string, key: string): Promise<T> {
  const res = await fetch(`${REST}${path}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Composio returned ${res.status}. Check the server's Composio key in Settings → API keys.`);
  return res.json() as Promise<T>;
}

// ---------- catalog (user-independent, cached) ----------

type CatalogItem = Omit<Toolkit, 'connected'>;
let catalogCache: { at: number; items: CatalogItem[] } | null = null;

export async function catalog(): Promise<CatalogItem[]> {
  if (!env.composioEnabled) return [];
  composio(); // Apply key changes before consulting a cache.
  const key = env.composioKey;
  if (catalogCache && Date.now() - catalogCache.at < 3600_000) return catalogCache.items;
  const items: CatalogItem[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const r = await rest<any>(`/toolkits?sort_by=usage&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, key);
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

export async function connectedToolkits(userId: string): Promise<Set<string>> {
  return new Set((await connectionsDetail(userId)).filter((c) => c.status === 'ACTIVE').map((c) => c.toolkit));
}

export async function connectionsDetail(userId: string) {
  if (!env.composioEnabled) return [];
  const client = composio();
  const key = env.composioKey;
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
  const client = composio();
  const key = env.composioKey;
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
  if (env.composioKey !== key) throw new Error('The Composio key changed. Please retry.');
}

/** A connection change must also drop the saved session, which may still select the old account. */
export function invalidateComposioSession(userId: string) {
  sessionCache.delete(userId);
  db.prepare('DELETE FROM composio_sessions WHERE user_id=?').run(userId);
}

export async function sessionFor(userId: string): Promise<Session> {
  if (!env.composioEnabled) throw new Error(APPS_OFF);
  const client = composio();
  const key = env.composioKey;
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
  const session = await sessionFor(userId);
  const req = await session.authorize(toolkit, { callbackUrl });
  if (!req.redirectUrl) throw new Error('Composio did not return a connection link. Please retry.');
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** OpenAI-Responses-format function tools for this user's Composio session (meta tools). */
export async function composioTools(userId: string): Promise<any[]> {
  if (!env.composioEnabled) return [];
  try {
    const session = await sessionFor(userId);
    const tools = await session.tools();
    return Array.isArray(tools) ? tools : [];
  } catch (e) {
    console.warn('[composio] tools unavailable', (e as Error).message);
    return [];
  }
}

export async function executeComposio(userId: string, name: string, args: Record<string, unknown>) {
  const session = await sessionFor(userId);
  try {
    const r = await session.execute(name, args);
    return r as { data?: unknown; error?: unknown; resultType?: string; logId?: string };
  } catch (e: any) {
    if ([404, 410].includes(e?.status ?? e?.cause?.status)) invalidateComposioSession(userId);
    // Never automatically replay a tool call: it may have already changed external data.
    throw e;
  }
}

/** Which inner tool slugs a Composio meta-tool call would run (for approval checks). */
export function innerToolSlugs(name: string, args: any): string[] {
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const list = args?.tools ?? args?.tool_calls ?? args?.actions ?? [];
    return (Array.isArray(list) ? list : []).map((t: any) => String(t.tool_slug ?? t.slug ?? t.name ?? t.tool ?? '')).filter(Boolean);
  }
  if (name.startsWith('COMPOSIO_')) return [];
  return [name];
}

const READ_RE = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
export const isReadOnlySlug = (slug: string) => READ_RE.test(slug.toUpperCase());

// ---------- sign-in via Composio-managed Google (Gmail) connection ----------

export async function startGoogleLogin(provisionalUserId: string, callbackUrl: string) {
  if (!env.composioEnabled) throw new Error(APPS_OFF);
  const session = await composio().create(provisionalUserId, { manageConnections: false } as any);
  const req = await (session as any).authorize('gmail', { callbackUrl });
  return { redirectUrl: req.redirectUrl as string, connectedAccountId: req.id as string | undefined };
}

export async function googleProfile(connectedAccountId: string): Promise<{ email: string; name?: string }> {
  const r: any = await composio().tools.proxyExecute({
    endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    method: 'GET',
    connectedAccountId,
  } as any);
  const data = r?.data ?? r;
  const email = data?.emailAddress ?? data?.email;
  if (!email) throw new Error(`Could not read Google profile: ${JSON.stringify(r).slice(0, 300)}`);
  return { email, name: undefined };
}

export async function deleteConnection(id: string) {
  try { await composio().connectedAccounts.delete(id); } catch { /* ignore */ }
}
