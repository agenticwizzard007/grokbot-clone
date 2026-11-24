import { visibleConnections } from './connection-details.js';
import { isEffort } from './types.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { checkRoutineCreate } from './routine-limits.js';
import { stream } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { activeSessionPredicate, activeSessionBounds, clearSessionCookies, createSession, destroySession, requireUser, requireRecentAuth, recentlyAuthenticated, userFromCookieHeader, revokeSession, sessionHash, sessionFromCookie, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listRowChanges, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt, resolveApproval, runInBotQueue } from './agent/loop.js';
import { computers } from './computers/index.js';
import { catalog, connectedToolkits, connectionsDetail, manageConnection, removeExpiredConnection, ExpiredConnectionRemovalError, disconnect, invalidateComposioSession } from './composio.js';
import { ConnectionCardChanged, pendingConnectionCards, reconcileConnectionCards, startCardConnect } from './agent/connection-cards.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger, isEventSchedule } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { acceptMessage, SubmissionConflict } from './agent/message-receipts.js';
import { JobCapacityError } from './agent/jobs.js';
import { voiceApi } from './voice.js';
import { createBot, assertPrimaryRemovalAllowed, transferPrimary, botPatchSchema, botCreateSchema, BRIEF_FIELDS } from './bots.js';
import { readJson, zodMessage } from './lib/json.js';
import { apiBodyLimit } from './security/body-limits.js';
import { renameSetupGreeting, skipSetup, SetupSkipError } from './bot-setup.js';
import { activateSetup, beginSetupInterview, briefSchema, emitSetup, getSetup, repairActiveSetup, removeSetupFiles, setupFiles, setupView, writeSetupFiles, coworkerSetups, coworkerSetup } from './bot-setup.js';
import { importTeammate, provisionTeammate } from './agent/teammates.js';
import type { ComputerState, ServerEvent, Toolkit } from './types.js';
import { compareAppPriority, matchesAppCategory } from './app-catalog.js';
import { signUser, verifyUserSig } from './messaging/store.js';
import { createAccount, deleteAccount, updateProfile, AccountAuthorizationChanged } from './accounts.js';
import { adoptAccountTimezone } from './proactive.js';
import { finishNativeLogin, nativeAuth } from './native-auth.js';
import { appleAuth } from './auth/apple.js';
import { appleAvailableForAgent } from './auth/apple-provider.js';
import { openrouterAuth } from './auth/openrouter.js';
import { providerApi } from './providers/routes.js';
import { googleAuth, googleLinked, googleSignInAvailable } from './auth/google.js';
import { currentSessionHash } from './security/request-context.js';
import { onSessionRevoked } from './security/session-lifecycle.js';
import { isTenant } from './deployment.js';
import { appSuggestionsApi } from './routes-app-suggestions.js';

export const api = new Hono<AuthVars>();

const findOrCreateUser = (email: string, name?: string, preferId?: string) => createAccount({ email, name, preferId, source: 'web', developmentEmailLookup: true });

// ---------- auth ----------

api.route('/auth/native', nativeAuth);
api.route('/auth/apple', appleAuth);
api.route('/auth/google', googleAuth);
api.route('/auth/openrouter', openrouterAuth);
api.route('/providers', providerApi);

api.get('/auth/me', (c) => {
  const session = userFromCookieHeader(c.req.header('cookie'));
  const user = session ? { ...session, timezone: ((db.prepare('SELECT timezone FROM users WHERE id=?').get(session.id) as { timezone?: string | null } | undefined)?.timezone ?? null) } : null;
  const appleLinked = !!user && !!db.prepare('SELECT 1 FROM apple_identities WHERE user_id=?').get(user.id);
  return c.json({ user, devLogin: env.devLogin, googleLogin: googleSignInAvailable(), googleLinked: !!user && googleLinked(user.id), appleLogin: appleAvailableForAgent(c.req.header('user-agent')), appleLinked });
});

/** MF-017: the browser sends its IANA time zone; synopses and check-ins that fell back to UTC follow it. */
const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const mePatchSchema = z.object({ timezone: z.string().trim().min(1).max(100).refine(validTimezone, 'Use an IANA time zone such as Europe/London.') }).strict();
api.patch('/auth/me', requireUser, async (c) => {
  const body = await readJson(c, mePatchSchema); if (!body.ok) return body.response;
  const userId = c.get('user').id;
  const timezone = new Intl.DateTimeFormat('en-US', { timeZone: body.data.timezone }).resolvedOptions().timeZone;
  updateProfile(userId, { timezone });
  adoptAccountTimezone(userId, timezone);
  // R2F-017: synopsis lines and schedules that follow the account zone refresh without a manual Refresh.
  hub.emit(userId, { type: 'synopses' });
  return c.json({ user: { ...c.get('user'), timezone } });
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin || process.env.NODE_ENV === 'production') return c.json({ error: 'disabled' }, 403);
  const body = await readJson(c); if (!body.ok) return body.response;
  const { email, name } = body.data as { email?: unknown; name?: unknown };
  if (typeof email !== 'string' || !email.includes('@') || (name !== undefined && typeof name !== 'string')) return c.json({ error: 'email required' }, 400);
  const { id } = findOrCreateUser(email, name);
  createSession(c, id);
  return c.json({ ok: true });
});

api.post('/auth/logout', requireUser, (c) => { destroySession(c); return c.json({ ok: true }); });

api.get('/auth/sessions', requireUser, c => {
  const current = currentSessionHash();
  const sessions = (db.prepare(`SELECT token,created_at,expires_at,last_seen_at FROM auth_sessions s WHERE user_id=? AND ${activeSessionPredicate}`).all(c.get('user').id, ...activeSessionBounds()) as any[]).map(({ token, ...row }) => ({ ...row, id: token, current: token === current }));
  return c.json({ sessions });
});
api.delete('/auth/sessions/:id', requireUser, c => {
  const row = db.prepare('SELECT token FROM auth_sessions WHERE user_id=? AND token=?').get(c.get('user').id, c.req.param('id')) as { token: string } | undefined;
  if (!row) return c.json({ error: 'Session not found.' }, 404);
  const revokedCurrent = row.token === currentSessionHash();
  revokeSession(row.token);
  if (revokedCurrent) clearSessionCookies(c);
  return c.json({ ok: true, revokedCurrent });
});

// everything below requires a session
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path.startsWith('/api/messaging/inkbox/webhook') || c.req.path.startsWith('/api/join/') || c.req.path === '/api/health') return next();
  return requireUser(c, next);
});

// R2F-019: byte caps before any JSON is parsed on Bot, card answer and approval routes.
api.use('/bots', apiBodyLimit);
api.use('/bots/*', apiBodyLimit);
api.use('/approvals/*', apiBodyLimit);
api.route('/', appSuggestionsApi);

// ---------- events (SSE) ----------

api.delete('/account', requireRecentAuth, async (c) => {
  const origin = c.req.header('origin');
  if (origin && ![new URL(env.appUrl).origin, new URL(env.serverUrl).origin].includes(origin)) return c.json({ error: 'Invalid request origin.' }, 403);
  const body = await c.req.json().catch(() => null);
  if (body?.confirmation !== 'DELETE') return c.json({ error: 'Confirm account deletion first.' }, 400);
  const userId = c.get('user').id;
  if (typeof body.expectedUserId !== 'string' || !body.expectedUserId) return c.json({ error: 'Confirm the account for this request.' }, 400);
  if (body.expectedUserId !== userId) return c.json({ error: 'Your account changed. Reload before deleting your account.', code: 'account_changed' }, 409);
  try {
    if(isTenant)return c.json({error:'Account deletion must be authorized by the platform.'},403);
    await deleteAccount(userId,()=>{
      if(!recentlyAuthenticated(c)||userFromCookieHeader(c.req.header('cookie'))?.id!==userId)throw new AccountAuthorizationChanged();
    });
    destroySession(c);
    return c.json({ ok: true });
  } catch(error) {
    if(error instanceof AccountAuthorizationChanged)return c.json({error:'Sign in again to delete your account.',code:'reauth_required'},401);
    return c.json({ error: 'Could not finish account deletion. If you use Apple sign-in, Apple access must be revoked first. Please try again.' }, 502);
  }
});

/** Hard cap on undelivered events per subscriber; past it the stream is closed and the client resyncs on reconnect. */
export const SSE_QUEUE_CAP = 5000;
export const SSE_HEARTBEAT_MS = 10_000;
/** Snapshot style events replace an older undelivered copy for the same bot instead of piling up (MF-011). */
export function sseCoalesceKey(ev: ServerEvent): string | null {
  if (ev.type === 'live') return `live:${ev.state.botId}`;
  if (ev.type === 'bot') return `bot:${ev.bot.id}`;
  if (ev.type === 'roster') return 'roster';
  if (ev.type === 'computer') return 'computer';
  if (ev.type === 'synopses') return 'synopses';
  // Streaming updates rewrite one row many times; only its latest body matters.
  if (ev.type === 'rows' && ev.rows.length === 1) return `rows:${ev.botId}:${ev.generation}:${ev.rows[0].seq}`;
  return null;
}
export class SseQueue {
  private items: { key: string | null; data: string }[] = [];
  get length() { return this.items.length; }
  /** Returns false when the subscriber is too far behind to keep. */
  push(ev: ServerEvent): boolean {
    const key = sseCoalesceKey(ev);
    if (key !== null) {
      const i = this.items.findIndex((item) => item.key === key);
      if (i >= 0) this.items.splice(i, 1);
    }
    if (this.items.length >= SSE_QUEUE_CAP) return false;
    this.items.push({ key, data: JSON.stringify(ev) });
    return true;
  }
  shift(): string | undefined { return this.items.shift()?.data; }
}

api.get('/events', (c) => {
  const user = c.get('user');
  // Set these before the first write. Leave protocol framing to the adapter:
  // streamSSE adds HTTP/1 hop-by-hop headers that are invalid on HTTP/2.
  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  c.header('Content-Encoding', 'identity');
  return stream(c, async (stream) => {
    const queue = new SseQueue();
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { if (!queue.push(ev)) { stream.abort(); return; } wake?.(); });
    const off = onSessionRevoked(sessionHash(sessionFromCookie(c.req.header('cookie')) ?? ''), () => stream.abort());
    const expiry = setInterval(() => { if (!userFromCookieHeader(c.req.header('cookie'))) stream.abort(); }, 15_000).unref();
    const cleanup = () => { clearInterval(expiry); off(); unsub(); wake?.(); };
    stream.onAbort(cleanup);
    // Each write is a complete SSE frame. Data pings also reach the browser watchdog.
    const write = (data: string) => stream.write(`data: ${data}\n\n`);
    try {
      await write(JSON.stringify({ type: 'hello', serverTime: now() }));
      while (!stream.aborted) {
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, SSE_HEARTBEAT_MS);
            wake = () => { clearTimeout(timer); resolve(); };
          });
          wake = null;
          if (stream.aborted) break;
          if (!queue.length) { await write(JSON.stringify({ type: 'ping' })); continue; }
        }
        while (queue.length && !stream.aborted) await write(queue.shift()!);
      }
    } finally { cleanup(); }
  });
});

// ---------- bots ----------
api.get('/jobs', c => c.json({ jobs: db.prepare("SELECT id,bot_id,state,created_at,started_at,finished_at FROM agent_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(c.get('user').id) }));
api.get('/runtime/events', c => c.json({ failures: isTenant ? db.prepare('SELECT id,error_code,received_at FROM runtime_event_failures ORDER BY received_at DESC LIMIT 200').all() : [] }));

/** Longest user message, room message or card answer accepted (MF-009). */
export const MAX_MESSAGE_CHARS = 32_000;
const MESSAGE_TOO_LONG = 'Message is too long (max 32,000 characters).';
const approvalDecisionSchema = z.object({ decision: z.enum(['allow', 'always', 'deny']) }).strict();
const routinePatchSchema = z.object({ enabled: z.boolean() }).strict();

class PatchConflict extends Error { constructor(message: string, readonly status: 404 | 409) { super(message); } }

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => {
  const userId = c.get('user').id;
  const bots = listBots(userId);
  for (const bot of bots) repairActiveSetup(bot.id);
  return c.json({ bots, live: allLive(userId) });
});

api.post('/bots', async (c) => {
  const parsed = await readJson(c, botCreateSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const brief = body.brief === undefined ? undefined : briefSchema.safeParse(body.brief);
  if (brief && !brief.success) return c.json({ error: brief.error.message }, 400);
  const bot = createBot(c.get('user').id, { ...body, name: body.name ?? '', isPrimary: false, brief: brief?.data, source: { messages: [] } });
  beginSetupInterview(bot.id);
  return c.json({ bot: getBot(bot.id) });
});

api.post('/bots/import', async (c) => {
  // R2F-037: malformed, empty or non-object bodies are a plain 400 from readJson, like every other handler.
  const body = await readJson(c); if (!body.ok) return body.response;
  const { manifest, name, expectedUserId } = body.data;
  const userId = c.get('user').id;
  if (expectedUserId !== undefined) {
    if (typeof expectedUserId !== 'string' || !expectedUserId) return c.json({ error: 'Confirm the account for this import.' }, 400);
    if (expectedUserId !== userId) return c.json({ error: 'Your account changed. Reload before importing this setup.', code: 'account_changed' }, 409);
  }
  try { return c.json(await importTeammate(userId, manifest, name)); }
  catch (e: any) { return c.json({ error: e instanceof z.ZodError ? zodMessage(e) : String(e?.message ?? e) }, 400); }
});

api.get('/bots/:id/setup', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  const view = b && setupView(b.id);
  if (!view) return c.json({ error: 'No saved setup for this Bot.' }, 404);
  return c.json(view);
});

api.get('/bots/:id/coworker-setups', (c) => {
  try { return c.json({ setups: coworkerSetups(c.get('user').id, c.req.param('id')) }); }
  catch { return c.json({ error: 'Coordinator not found.' }, 404); }
});

api.post('/bots/:id/setup/interview', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || b.kind === 'room' || b.hidden) return c.json({ error: 'not found' }, 404);
  await runInBotQueue(b.id, async () => { beginSetupInterview(b.id); });
  return c.json(setupView(b.id));
});

api.post('/bots/:id/setup/activate', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await readJson(c); if (!body.ok) return body.response;
  const { revision, coordinatorId } = body.data;
  if (!Number.isInteger(revision)) return c.json({ error: 'A configuration revision is required.' }, 400);
  try {
    await runInBotQueue(b.id, async () => {
      if (coordinatorId !== undefined) coworkerSetup(c.get('user').id, coordinatorId, b.id);
      return activateSetup(b.id, revision);
    });
    return c.json(setupView(b.id));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 409); }
});

// MF-010 (WS2): "Skip setup" activates the current brief with safe defaults.
api.post('/bots/:id/setup/skip', async (c) => {
  const userId = c.get('user').id;
  const botId = c.req.param('id');
  const bot = ownBot(userId, botId);
  if (!bot || bot.kind === 'room' || bot.hidden) return c.json({ error: 'not found' }, 404);
  const setup = getSetup(botId);
  if (!setup || setup.onboarding.status === 'active') return c.json({ error: 'This Bot is already active.' }, 409);
  // Stop the interview before joining its queue so a slow setup turn cannot block Skip.
  interrupt(botId, undefined, 'setup');
  try {
    return c.json(await runInBotQueue(botId, async () => ({ ...skipSetup(userId, botId), bot: getBot(botId)! })));
  }
  catch (e: any) { return c.json({ error: String(e?.message ?? e) }, e instanceof SetupSkipError ? e.status : 409); }
});

api.get('/bots/:id/setup/:file', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const name = c.req.param('file');
  const files = setupFiles(b.id);
  if (!Object.hasOwn(files, name)) return c.json({ error: 'not found' }, 404);
  return c.body(files[name], 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
});

api.post('/bots/:id/setup/retry', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !getSetup(b.id)) return c.json({ error: 'not found' }, 404);
  return c.json({ computer: await provisionTeammate(c.get('user').id, b.id) });
});

api.patch('/bots/:id', async (c) => {
  const userId = c.get('user').id;
  const b = ownBot(userId, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const parsed = botPatchSchema.safeParse(body.data);
  if (!parsed.success) {
    // Keep the established short messages for fields older clients already handle.
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    if (body.data.expectedInstructions !== undefined && (field === 'instructions' || field === 'expectedInstructions')) return c.json({ error: 'bad instructions' }, 400);
    if (field === 'model' || field === 'effort' || field === 'fast') return c.json({ error: `bad ${field}` }, 400);
    return c.json({ error: zodMessage(parsed.error) }, 400);
  }
  const p = parsed.data;
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language', model: 'model', fast: 'fast' };
  const manifestCols = new Set(['name', 'label', 'description', 'instructions', 'avatarShape', 'avatarColor', 'mode', 'effort', 'model', 'voice', 'voiceSpeed', 'voiceLanguage']);
  const sqlValue = (v: unknown) => typeof v === 'boolean' ? (v ? 1 : 0) : v;
  let result: { briefChanged: boolean; manifestChanged: boolean };
  try {
    // One transaction: every field, the instructions compare-and-set and the setup revision land together or not at all.
    result = db.transaction(() => {
      const current = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(b.id, userId) as Record<string, unknown> | undefined;
      if (!current) throw new PatchConflict('not found', 404);
      // The inline configuration editor supplies its original text so a delayed or
      // missed roster event cannot let one browser overwrite another browser's edit.
      if (p.expectedInstructions !== undefined && current.instructions !== p.expectedInstructions)
        throw new PatchConflict('Instructions changed elsewhere. Reload the current instructions before saving.', 409);
      const changed: string[] = [];
      for (const [k, col] of Object.entries(cols)) {
        const v = (p as Record<string, unknown>)[k];
        if (v === undefined) continue;
        const next = sqlValue(v);
        if (current[col] === next) continue;
        db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(next, now(), b.id);
        changed.push(k);
      }
      // MF-013: only a brief relevant edit is a new setup revision; model, effort, voice or pin changes are not.
      const briefChanged = changed.some((k) => (BRIEF_FIELDS as readonly string[]).includes(k));
      if (briefChanged && getSetup(b.id)) db.prepare('UPDATE bot_setups SET revision=revision+1, updated_at=? WHERE bot_id=?').run(now(), b.id);
      return { briefChanged, manifestChanged: changed.some((k) => manifestCols.has(k)) };
    })();
  } catch (e) {
    if (e instanceof PatchConflict) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (typeof p.name === 'string' && p.name !== b.name) renameSetupGreeting(b.id, b.name, p.name); // MF-035 (WS2)
  if (result.manifestChanged && getSetup(b.id)) writeSetupFiles(b.id);
  if (result.briefChanged && getSetup(b.id)) emitSetup(b.id);
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const routines=listRoutines(b.id);
  try { db.transaction(()=>{
    assertPrimaryRemovalAllowed(c.get('user').id,b.id);
    interrupt(b.id);
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
    db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  })(); } catch(e) { return c.json({error:(e as Error).message},409); }
  for(const r of routines) unscheduleRoutine(r.id);
  void computers.resetScreen(c.get('user').id,b.id).catch(()=>{});
  removeSetupFiles(b.id);
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!b.is_primary) {
    const primary=db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1 LIMIT 1').get(user.id) as {id:string}|undefined;
    try { if(primary) transferPrimary(user.id,primary.id,b.id);
      else {
        const eligible=db.prepare("SELECT 1 FROM bots b JOIN bot_setups s ON s.bot_id=b.id WHERE b.id=? AND b.user_id=? AND COALESCE(b.hidden,0)=0 AND b.parent_bot_id IS NULL AND COALESCE(b.kind,'agent')!='room' AND s.onboarding_status='active'").get(b.id,user.id);
        if(!eligible) return c.json({error:'Activate a permanent teammate before choosing a primary.'},409);
        db.prepare('UPDATE bots SET is_primary=1 WHERE id=? AND user_id=?').run(b.id,user.id);
      }
    } catch(e) { return c.json({error:(e as Error).message},409); }
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rawBefore = c.req.query('beforeSeq');
  const rawLimit = c.req.query('limit');
  if (rawBefore !== undefined && rawBefore !== '' && !/^-?\d+$/.test(rawBefore)) return c.json({ error: 'beforeSeq must be an integer.' }, 400);
  if (rawLimit !== undefined && !/^-?\d+$/.test(rawLimit)) return c.json({ error: 'limit must be an integer.' }, 400);
  const beforeSeq = rawBefore ? Number(rawBefore) : undefined;
  const limit = rawLimit === undefined ? 24 : Math.max(1, Math.min(500, Number(rawLimit)));
  // Activation and roster/setup reads repair legacy setup cards. History reads
  // stay read-only and bounded, including the first conversation page.
  const rows = listRows(b.id, { beforeSeq, limit });
  return c.json({ generation: b.generation, revision: b.rev, rows, olderCursor: rows.length === limit ? rows[0].seq : null });
});

// Only changed rows in the already opened range are reconciled after reconnect.
api.get('/bots/:id/row-changes', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const values = ['afterRev', 'throughRev', 'minSeq'].map(key => c.req.query(key));
  if (values.some(value => value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    return c.json({ error: 'Revision and sequence cursors must be nonnegative integers.' }, 400);
  }
  const [afterRev, throughRev, minSeq] = values.map(Number);
  const rows = listRowChanges(b.id, b.generation, afterRev, Math.min(throughRev, b.rev), minSeq);
  return c.json({ generation: b.generation, rows, nextRev: rows.length === 200 ? rows[rows.length - 1].updatedSeq : null });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await readJson(c); if (!body.ok) return body.response;
  const { text, submissionId } = body.data;
  if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'empty' }, 400);
  if (text.length > MAX_MESSAGE_CHARS) return c.json({ error: MESSAGE_TOO_LONG }, 413);
  if (submissionId !== undefined && (typeof submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(submissionId)))
    return c.json({ error: 'Invalid submission ID.' }, 400);
  try {
    const receipt = acceptMessage(c.get('user').id, b.id, submissionId, text, () => {
      const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: text.trim() });
      const jobIds: string[] = [];
      // Reserve every responder inside the receipt transaction. Events, live state and
      // execution are deferred until commit and discarded if any reservation fails.
      if (b.kind === 'room') dispatchRoomMessage(b.id, text.trim(), (id, trigger) => { jobIds.push(enqueue(id, trigger)); });
      else jobIds.push(enqueue(b.id, { type: 'user', text: text.trim() }));
      return { row, jobIds };
    });
    emitBot(b.id);
    return c.json(receipt);
  } catch (error) {
    if (error instanceof SubmissionConflict) return c.json({ error: error.message }, 409);
    if (error instanceof JobCapacityError) {
      c.header('Retry-After', '5');
      return c.json({ error: error.message, code: 'chat_capacity', retryable: true }, 429);
    }
    throw error;
  }
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id, undefined, 'user');
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id, undefined, 'conversation');
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const body = await readJson(c, approvalDecisionSchema); if (!body.ok) return body.response;
  const { decision } = body.data;
  try { resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const body = await readJson(c); if (!body.ok) return body.response;
  const { answer } = body.data;
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  if(typeof answer!=='string'||!answer.trim())return c.json({error:'Invalid answer'},400);
  if(answer.length>MAX_MESSAGE_CHARS)return c.json({error:MESSAGE_TOO_LONG},413);
  if(row.body.answerJobId) {
    if(row.body.answer!==answer)return c.json({error:'This question already has an admitted answer.'},409);
    return c.json({ok:true,jobId:row.body.answerJobId});
  }
  if(!['pending','answered'].includes(row.body.status))return c.json({error:'This question is no longer pending.'},409);
  try {
    const jobId=db.transaction(()=>{
      const current=getRow(b.id,row.seq);
      if(!current||current.body.type!=='card'||current.body.card!=='question')throw new Error('Question changed. Reload before answering.');
      const questionBody=current.body;
      if(questionBody.answerJobId){
        if(questionBody.answer!==answer)throw new Error('This question already has an admitted answer.');
        return questionBody.answerJobId;
      }
      if(!['pending','answered'].includes(questionBody.status))throw new Error('This question is no longer pending.');
      updateRow(b.id,row.seq,{...questionBody,status:'answered',answer});
      const id=enqueue(b.id,{type:'user',text:`[Answer to "${questionBody.question}"] ${answer}`});
      appendRow(b.id,'message',{type:'message',role:'user',text:answer});
      return id;
    })();
    // Needs-you lists pending question cards; this one is no longer waiting.
    hub.emit(c.get('user').id, { type: 'tasks', botId: b.id });
    return c.json({ok:true,jobId});
  }catch(e){return c.json({error:(e as Error).message},409);}

});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  if(row.body.status!=='pending')return c.json({ok:true});
  // A draft card (R2F-006) is discarded on the client's Discard; it never sends anything.
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : row.body.card === 'draft' ? 'discarded' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', connectionCardSeq:row.seq,text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const body = await readJson(c, routinePatchSchema); if (!body.ok) return body.response;
  const { enabled } = body.data;
  if (enabled && !r.enabled) {
    const limit = checkRoutineCreate(r.bot_id, r.schedule, { timezone: r.timezone, excludeRoutineId: r.id });
    if (limit) return c.json({ error: limit }, 429);
  }
  try {
    if (enabled) await scheduleRoutine(toRoutine(r));
    else await unscheduleRoutine(r.id);
  } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  if (!isEventSchedule(r.schedule)) db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const run = runRoutine(r.id, 'manual');
  if (!run.ok) return c.json({ error: `Not run: ${run.reason}.` }, 429);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  try { await unscheduleRoutine(r.id); }
  catch (e) { return c.json({ error: (e as Error).message }, 502); }
  await deleteEventTrigger(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

// Memory routes live in routes-knowledge.ts, which mounts before this router.

// ---------- computer ----------

// The last failed wake per account, so the viewer and Settings show the error instead of "Waking..." forever
// (MF-019). R2F-018: it survives a restart, the client only ever sees generic copy (the provider's raw
// text is logged on the server), and a successful wake clears it. Additive table; rows are never deleted.
db.exec(`CREATE TABLE IF NOT EXISTS computer_wake_errors (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL, failed_at INTEGER NOT NULL, cleared_at INTEGER
)`);
export const WAKE_ERROR_MESSAGE = 'The computer could not start. Try again in a minute.';
function lastWakeError(userId: string): { message: string; failedAt: number } | undefined {
  const row = db.prepare('SELECT message, failed_at FROM computer_wake_errors WHERE user_id=? AND cleared_at IS NULL').get(userId) as { message: string; failed_at: number } | undefined;
  return row ? { message: row.message, failedAt: row.failed_at } : undefined;
}
const clearWakeError = (userId: string) => db.prepare('UPDATE computer_wake_errors SET cleared_at=? WHERE user_id=? AND cleared_at IS NULL').run(now(), userId);
export function computerView(userId: string, state: ComputerState = computers.state(userId)): ComputerState {
  const error = lastWakeError(userId);
  if (!error || state.error || state.status === 'running') return state;
  return { ...state, status: 'error', error: error.message };
}
export async function wakeComputer(userId: string): Promise<void> {
  try {
    await computers.ensure(userId);
    clearWakeError(userId);
  } catch (e) {
    // Provider text can carry internals (hosts, regions, request ids). Keep it in the server log only.
    console.warn('[computer] ensure failed', String((e as Error)?.message ?? e).slice(0, 300));
    db.prepare(`INSERT INTO computer_wake_errors(user_id,message,failed_at,cleared_at) VALUES (?,?,?,NULL)
      ON CONFLICT(user_id) DO UPDATE SET message=excluded.message, failed_at=excluded.failed_at, cleared_at=NULL`).run(userId, WAKE_ERROR_MESSAGE, now());
  }
  try { hub.emit(userId, { type: 'computer', state: computerView(userId) }); } catch { /* state unavailable */ }
}

api.get('/computer', async (c) => c.json({ computer: computerView(c.get('user').id, await computers.refresh(c.get('user').id)) }));

api.post('/computer/ensure', (c) => {
  const userId = c.get('user').id;
  void wakeComputer(userId);
  return c.json({ computer: computers.state(userId) });
});

api.post('/computer/suspend', async (c) => {
  await computers.suspend(c.get('user').id);
  return c.json({ computer: computers.state(c.get('user').id) });
});

api.get('/bots/:id/screenshot', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    const s = await computers.peek(user.id, b.id);
    if (!s) return c.body(null, 204);
    return c.body(Buffer.from(s.image, 'base64'), 200, { 'Content-Type': s.mime, 'Cache-Control': 'no-store' });
  } catch {
    return c.body(null, 204);
  }
});

// ---------- apps (Composio marketplace) ----------

api.get('/apps', async (c) => {
  const user = c.get('user');
  if (!env.composioEnabled) return c.json({ apps: [], connected: [], connectedApps: [], categories: [], total: 0, notConfigured: true });
  const search = (c.req.query('search') ?? '').toLowerCase();
  const category = c.req.query('category') ?? '';
  const [all, rawAccounts] = await Promise.all([catalog(), connectionsDetail(user.id, { details: true })]);
  const accounts = visibleConnections(rawAccounts);
  const connected = new Set(accounts.filter(a => a.status === 'ACTIVE' && !a.isDisabled).map(a => a.toolkit));
  const withAccounts = (t: Omit<Toolkit, 'connected'>): Toolkit => ({ ...t, connected: connected.has(t.slug), accounts: accounts.filter(a => a.toolkit === t.slug) });
  let items: Toolkit[] = all.map(withAccounts);
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => matchesAppCategory(t, category));
  items.sort(compareAppPriority);
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map(withAccounts);
  const pageNumber = (value: string | undefined, fallback: number) => value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
  const offset = pageNumber(c.req.query('offset'), 0);
  const limit = Math.max(1, Math.min(200, pageNumber(c.req.query('limit'), 60)));
  const apps = items.slice(offset, offset + limit);
  const nextOffset = offset + apps.length < items.length ? offset + apps.length : null;
  return c.json({ apps, connected: [...connected], connectedApps, categories, total: items.length, nextOffset });
});

api.get('/apps/connections', async c => {
  const userId = c.get('user').id;
  const pending = pendingConnectionCards(userId);
  const connections = await connectionsDetail(userId, { details: true });
  reconcileConnectionCards(userId, pending, connections);
  return c.json({ connections: visibleConnections(connections) });
});
api.delete('/apps/connections/:id/expired', async c => {
  try {
    const result = await removeExpiredConnection(c.get('user').id, c.req.param('id'));
    hub.emit(c.get('user').id, { type: 'connections' });
    return c.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ExpiredConnectionRemovalError) return c.json({ error: e.message, code: e.code }, e.status);
    return c.json({ error: 'Could not verify or remove this expired connection. Try again later.' }, 503);
  }
});
api.post('/apps/connections/:id/default', async c => {
  await manageConnection(c.get('user').id, c.req.param('id'), 'default');
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});
api.delete('/apps/connections/:id', async c => {
  await manageConnection(c.get('user').id, c.req.param('id'), 'disconnect');
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.post('/apps/:slug/connect', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const { botId, seq } = await c.req.json<{ botId?: string; seq?: number }>().catch(() => ({} as any));
  const cb = new URL(`${env.serverUrl}/api/apps/callback`);
  cb.searchParams.set('slug', slug);
  if (botId) cb.searchParams.set('bot', botId);
  if (seq) cb.searchParams.set('seq', String(seq));
  // Native apps authorize in the system browser, which has a separate cookie jar.
  // Bind the callback to this account and exact operation for fifteen minutes.
  if (c.req.header('user-agent')?.includes('SwarmNative/')) {
    const expires = String(now() + 15 * 60_000);
    cb.searchParams.set('native', '1');
    cb.searchParams.set('u', user.id);
    cb.searchParams.set('expires', expires);
    cb.searchParams.set('sig', signUser(user.id, `native-apps:${slug}:${cb.searchParams.get('bot') ?? ''}:${cb.searchParams.get('seq') ?? ''}:${expires}`));
  }
  try { return c.json(await startCardConnect(user.id, slug, cb, botId, seq)); }
  catch (e) {
    if (e instanceof ConnectionCardChanged) return c.json({ error: e.message }, 409);
    throw e;
  }
});

api.get('/apps/callback', async (c) => {
  // Opened in the app (session cookie), or from a link sent by text (signed user id; the phone has no session).
  const native = c.req.query('native') === '1';
  const expires = c.req.query('expires') ?? '';
  const nativeScope = `native-apps:${c.req.query('slug') ?? ''}:${c.req.query('bot') ?? ''}:${c.req.query('seq') ?? ''}:${expires}`;
  const signed = c.req.query('u') && (!native || (Number(expires) > now() && Number(expires) <= now() + 15 * 60_000)) && verifyUserSig(c.req.query('u')!, native ? nativeScope : 'apps-callback', c.req.query('sig') ?? '') ? c.req.query('u')! : '';
  const userId = native ? signed : userFromCookieHeader(c.req.header('cookie'))?.id ?? signed;
  const slug = c.req.query('slug') ?? '';
  const botId = c.req.query('bot');
  const seq = Number(c.req.query('seq') ?? 0);
  let ok = false;
  const userExists = db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  if (userExists && c.req.query('status') !== 'failed') {
    invalidateComposioSession(userId);
    const connected = await connectedToolkits(userId).catch(() => new Set<string>());
    if (connected.has(slug)) {
      ok = !botId && !seq;
      if (ok) await connectionsDetail(userId, { details: true }).catch(() => []);
      hub.emit(userId, { type: 'connections' });
      if (botId && ownBot(userId, botId)) {
        const bot = ownBot(userId, botId);
        if (seq && bot && bot.generation === Number(c.req.query('generation'))) {
          const row = getRow(botId, seq);
          if (row?.body.type === 'card' && row.body.card === 'connect' && row.body.toolkit === slug &&
              row.body.connectionAttempt && row.body.connectionAttempt === c.req.query('attempt') &&
              ['pending', 'connected'].includes(row.body.status)) {
            const connectedAccountId = row.body.connectedAccountId;
            const accounts = await connectionsDetail(userId, { details: true }).catch(() => []);
            // The user's other ACTIVE account must not confirm this sign-in attempt.
            const verified = accounts.find(a => a.id === connectedAccountId && a.toolkit === slug && a.status === 'ACTIVE' && !a.isDisabled);
            const currentBot = ownBot(userId, botId);
            const current = currentBot?.generation === row.generation ? getRow(botId, seq) : null;
            if (verified && current && JSON.stringify(current.body) === JSON.stringify(row.body)) {
              ok = true;
              if (!row.body.answerJobId) {
                updateRow(botId, seq, { ...row.body, status: 'connected', accountDetails: verified.accountLabel ? { accountLabel: verified.accountLabel, connectedAt: verified.connectedAt ?? null, displayStatus: verified.displayStatus! } : undefined });
                const answerJobId = enqueue(botId, { type: 'system', connectionCardSeq: seq, text: `The user connected ${row.body.toolkitName}. Continue with what you were doing.` });
                const resolved = getRow(botId, seq);
                if (resolved?.body.type === 'card' && resolved.body.card === 'connect') updateRow(botId, seq, { ...resolved.body, answerJobId });
              }
            }
          }
        }
      }
    }
  }
  const message = JSON.stringify({ type: 'swarm-connected', slug, ok }).replace(/</g, '\\u003c');
  if (native) {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Swarm</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>${ok ? 'App connected' : 'Connection not confirmed'}</h1><p>${ok ? 'Return to Swarm to continue.' : 'Return to Swarm and try connecting again.'}</p><a href="so.swarms.app://connected">Return to Swarm</a></body>`);
  }
  return c.html(`<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Connection not confirmed'}</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection could not be confirmed. Return to the app and try again.'}<script>try{window.opener&&window.opener.postMessage(${message},${JSON.stringify(new URL(env.appUrl).origin)})}catch(e){};${ok ? 'setTimeout(()=>window.close(),800)' : ''}</script></body>`);
});

api.delete('/apps/:slug', async (c) => {
  await disconnect(c.get('user').id, c.req.param('slug'));
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);
