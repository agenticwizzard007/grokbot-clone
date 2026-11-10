import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import { composioCredentials, composioHeaders, composioIdentity } from './composio-auth.js';
import type { Toolkit } from './types.js';

const makeClient = (apiKey: string) => new Composio({ ...composioCredentials(apiKey), provider: new OpenAIResponsesProvider() });
let current: { key: string; client: ReturnType<typeof makeClient> } | null = null;
/** The Composio client for the current key; rebuilt (and caches dropped) when the key changes in Settings. */
export function composio() {
  const key = env.composioKey;
  if (!key) throw new Error(APPS_OFF);
  const identity = composioIdentity();
  if (!current || current.key !== identity) {
    current = { key: identity, client: makeClient(key) };
    sessionCache.clear();
    promptConnections.clear();
    catalogCache = null;
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
  if (cached && env.composioEnabled) {
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

export async function connectionsDetail(userId: string) {
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
  const session = await sessionFor(userId);
  const req = await session.authorize(toolkit, { callbackUrl });
  if (!req.redirectUrl) throw new Error('Composio did not return a connection link. Please retry.');
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** OpenAI-Responses-format function tools for this user's Composio session (meta tools). */
const sessionTools = new WeakMap<Session, Promise<any[]>>();
export async function composioTools(userId: string): Promise<any[]> {
  if (!env.composioEnabled) return [];
  try {
    const session = await sessionFor(userId);
    let pending = sessionTools.get(session);
    if (!pending) {
      pending = session.tools().then((tools) => Array.isArray(tools) ? tools : []);
      sessionTools.set(session, pending);
      pending.catch(() => { if (sessionTools.get(session) === pending) sessionTools.delete(session); });
    }
    return await pending;
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
  const session = await composio().create(provisionalUserId, { manageConnections: false });
  const req = await session.authorize('gmail', { callbackUrl });
  if (!req.redirectUrl || !req.id) throw new Error('Google sign-in did not return a connection link.');
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

export class GoogleLoginError extends Error {
  constructor(public readonly code: 'google_denied' | 'google_pending' | 'google_permissions' | 'google_unavailable') {
    super(code);
  }
}

/** Only a confirmed Gmail authorization can establish the sign-in identity. */
export async function googleProfile(connectedAccountId: string, userId: string): Promise<{ email: string; name?: string }> {
  const account = await composio().connectedAccounts.get(connectedAccountId);
  if (account.status === 'FAILED' && /access_denied/i.test(account.statusReason ?? '')) throw new GoogleLoginError('google_denied');
  if (account.status !== 'ACTIVE' || account.toolkit.slug !== 'gmail') throw new GoogleLoginError('google_pending');
  const r = await composio().tools.proxyExecute({
    endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    method: 'GET',
    connectedAccountId,
    userId,
  });
  if (r.status === 401 || r.status === 403) throw new GoogleLoginError('google_permissions');
  if (r.status < 200 || r.status >= 300) throw new GoogleLoginError('google_unavailable');
  const data = r.data as { emailAddress?: unknown } | undefined;
  const email = data?.emailAddress;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GoogleLoginError('google_unavailable');
  return { email: email.trim().toLowerCase(), name: undefined };
}

export async function deleteConnection(id: string) {
  try { await composio().connectedAccounts.delete(id); } catch { /* ignore */ }
}
