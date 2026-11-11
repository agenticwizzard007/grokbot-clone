import { isEffort } from './types.js';
import { Hono, type Context } from 'hono';
import { checkRoutineCreate } from './routine-limits.js';
import { streamSSE } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, requireUser, requireRecentAuth, recentlyAuthenticated, userFromCookieHeader, revokeSession, sessionHash, sessionFromCookie, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt, resolveApproval, runInBotQueue } from './agent/loop.js';
import { computers } from './computers/index.js';
import { catalog, connectedToolkits, connectionsDetail, manageConnection, disconnect, invalidateComposioSession, startConnect, toolkitInfo } from './composio.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import { createBot } from './bots.js';
import { activateSetup, beginSetupInterview, briefSchema, emitSetup, getSetup, removeSetupFiles, setupFiles, setupView, writeSetupFiles } from './bot-setup.js';
import { importTeammate, provisionTeammate } from './agent/teammates.js';
import type { Toolkit } from './types.js';
import { compareAppPriority, matchesAppCategory } from './app-catalog.js';
import { signUser, verifyUserSig } from './messaging/store.js';
import { createAccount, deleteAccount, AccountAuthorizationChanged } from './accounts.js';
import { finishNativeLogin, nativeAuth } from './native-auth.js';
import { appleAuth } from './auth/apple.js';
import { appleAvailableForAgent } from './auth/apple-provider.js';
import { openrouterAuth } from './auth/openrouter.js';
import { providerApi } from './providers/routes.js';
import { googleAuth, googleLinked, googleSignInAvailable } from './auth/google.js';
import { onSessionRevoked } from './security/session-lifecycle.js';
import { isTenant } from './deployment.js';

export const api = new Hono<AuthVars>();

const findOrCreateUser = (email: string, name?: string, preferId?: string) => createAccount({ email, name, preferId, source: 'web', developmentEmailLookup: true });

// ---------- auth ----------

api.route('/auth/native', nativeAuth);
api.route('/auth/apple', appleAuth);
api.route('/auth/google', googleAuth);
api.route('/auth/openrouter', openrouterAuth);
api.route('/providers', providerApi);

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie'));
  const appleLinked = !!user && !!db.prepare('SELECT 1 FROM apple_identities WHERE user_id=?').get(user.id);
  return c.json({ user, devLogin: env.devLogin, googleLogin: googleSignInAvailable(), googleLinked: !!user && googleLinked(user.id), appleLogin: appleAvailableForAgent(c.req.header('user-agent')), appleLinked });
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin || process.env.NODE_ENV === 'production') return c.json({ error: 'disabled' }, 403);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  const { id } = findOrCreateUser(email, name);
  createSession(c, id);
  return c.json({ ok: true });
});

api.post('/auth/logout', requireUser, (c) => { destroySession(c); return c.json({ ok: true }); });

api.get('/auth/sessions', requireUser, c => {
  const current = sessionHash(sessionFromCookie(c.req.header('cookie')) ?? '');
  const sessions = (db.prepare('SELECT token,created_at,expires_at,last_seen_at FROM auth_sessions WHERE user_id=? AND expires_at>?').all(c.get('user').id, now()) as any[]).map(({ token, ...row }) => ({ ...row, id: token, current: token === current }));
  return c.json({ sessions });
});
api.delete('/auth/sessions/:id', requireUser, c => {
  const row = db.prepare('SELECT token FROM auth_sessions WHERE user_id=? AND token=?').get(c.get('user').id, c.req.param('id')) as { token: string } | undefined;
  if (!row) return c.json({ error: 'Session not found.' }, 404);
  revokeSession(row.token); return c.json({ ok: true });
});

// everything below requires a session
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path.startsWith('/api/messaging/inkbox/webhook') || c.req.path.startsWith('/api/join/') || c.req.path === '/api/health') return next();
  return requireUser(c, next);
});

// ---------- events (SSE) ----------

api.delete('/account', requireRecentAuth, async (c) => {
  const origin = c.req.header('origin');
  if (origin && ![new URL(env.appUrl).origin, new URL(env.serverUrl).origin].includes(origin)) return c.json({ error: 'Invalid request origin.' }, 403);
  const body = await c.req.json().catch(() => null);
  if (body?.confirmation !== 'DELETE') return c.json({ error: 'Confirm account deletion first.' }, 400);
  try {
    if(isTenant)return c.json({error:'Account deletion must be authorized by the platform.'},403);
    await deleteAccount(c.get('user').id,()=>{
      if(!recentlyAuthenticated(c)||userFromCookieHeader(c.req.header('cookie'))?.id!==c.get('user').id)throw new AccountAuthorizationChanged();
    });
    destroySession(c);
    return c.json({ ok: true });
  } catch(error) {
    if(error instanceof AccountAuthorizationChanged)return c.json({error:'Sign in again to delete your account.',code:'reauth_required'},401);
    return c.json({ error: 'Could not finish account deletion. If you use Apple sign-in, Apple access must be revoked first. Please try again.' }, 502);
  }
});

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { if (queue.length >= 1000) { stream.abort(); return; } queue.push(JSON.stringify(ev)); wake?.(); });
    const off = onSessionRevoked(sessionHash(sessionFromCookie(c.req.header('cookie')) ?? ''), () => stream.abort());
    const expiry = setInterval(() => { if (!userFromCookieHeader(c.req.header('cookie'))) stream.abort(); }, 15_000).unref();
    stream.onAbort(() => { clearInterval(expiry); off(); unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20_000);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    clearInterval(expiry); off(); unsub();
  });
});

// ---------- bots ----------
api.get('/jobs', c => c.json({ jobs: db.prepare("SELECT id,bot_id,state,created_at,started_at,finished_at FROM agent_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(c.get('user').id) }));
api.get('/runtime/events', c => c.json({ failures: isTenant ? db.prepare('SELECT id,error_code,received_at FROM runtime_event_failures ORDER BY received_at DESC LIMIT 200').all() : [] }));

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) }));

api.post('/bots', async (c) => {
  const body = await c.req.json();
  const brief = body.brief === undefined ? undefined : briefSchema.safeParse(body.brief);
  if (brief && !brief.success) return c.json({ error: brief.error.message }, 400);
  const bot = createBot(c.get('user').id, { ...body, isPrimary: false, brief: brief?.data, source: { messages: [] } });
  beginSetupInterview(bot.id);
  return c.json({ bot: getBot(bot.id) });
});

api.post('/bots/import', async (c) => {
  try {
    const { manifest, name } = await c.req.json();
    return c.json(await importTeammate(c.get('user').id, manifest, name));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 400); }
});

api.get('/bots/:id/setup', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  const view = b && setupView(b.id);
  if (!view) return c.json({ error: 'No saved setup for this Bot.' }, 404);
  return c.json(view);
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
  const { revision } = await c.req.json();
  if (!Number.isInteger(revision)) return c.json({ error: 'A configuration revision is required.' }, 400);
  try {
    const pending = await runInBotQueue(b.id, async () => activateSetup(b.id, revision));
    if (pending) enqueue(b.id, { type: 'system', text: `Your setup has been confirmed by the user. Now handle this initial assignment from your creation brief:\n${pending}` });
    return c.json(setupView(b.id));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 409); }
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
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json();
  if (p.model !== undefined) {
    if (p.model !== null && (typeof p.model !== 'string' || p.model.length > 120)) return c.json({ error: 'bad model' }, 400);
    p.model = p.model?.trim() || null;
  }
  if (p.effort !== undefined && !isEffort(p.effort)) return c.json({ error: 'bad effort' }, 400);
  if (p.fast !== undefined && typeof p.fast !== 'boolean') return c.json({ error: 'bad fast' }, 400);
  // The inline configuration editor supplies its original text so a delayed or
  // missed roster event cannot let one browser overwrite another browser's edit.
  if (p.expectedInstructions !== undefined) {
    if (typeof p.expectedInstructions !== 'string' || typeof p.instructions !== 'string' || p.instructions.length > 8000)
      return c.json({ error: 'bad instructions' }, 400);
    const result = db.prepare('UPDATE bots SET instructions=?, updated_at=? WHERE id=? AND user_id=? AND instructions=?')
      .run(p.instructions, now(), b.id, c.get('user').id, p.expectedInstructions);
    if (!result.changes) return c.json({ error: 'Instructions changed elsewhere. Reload the current instructions before saving.' }, 409);
  }
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language', model: 'model', fast: 'fast' };
  for (const [k, col] of Object.entries(cols)) {
    if (k === 'instructions' && p.expectedInstructions !== undefined) continue;
    if (p[k] !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k], now(), b.id);
  }
  if (getSetup(b.id)) {
    db.prepare('UPDATE bot_setups SET revision=revision+1, updated_at=? WHERE bot_id=?').run(now(), b.id);
    writeSetupFiles(b.id);
    emitSetup(b.id);
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  for (const r of listRoutines(b.id)) unscheduleRoutine(r.id);
  // Close the Bot's browser/screen so the next Bot to get it doesn't inherit its windows.
  void computers.resetScreen(c.get('user').id, b.id).catch(() => {});
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  removeSetupFiles(b.id);
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
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
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: 'empty' }, 400);
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: text.trim() });
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, text.trim(), enqueue);
  // Any pending question card is answered by a free-text message.
  else enqueue(b.id, { type: 'user', text: text.trim() });
  return c.json({ row });
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const { decision } = await c.req.json<{ decision: 'allow' | 'always' | 'deny' }>();
  try { resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const { answer } = await c.req.json<{ answer: string }>();
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
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
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  if (enabled && !r.enabled) {
    const limit = checkRoutineCreate(r.bot_id, r.schedule, { timezone: r.timezone, excludeRoutineId: r.id });
    if (limit) return c.json({ error: limit }, 429);
  }
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
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
  unscheduleRoutine(r.id);
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

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[];
  return c.json({ memories: rows.map((m) => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at })) });
});

api.delete('/memories/:id', (c) => {
  db.prepare('DELETE FROM memories WHERE id=? AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(c.req.param('id'), c.get('user').id);
  return c.json({ ok: true });
});

// ---------- computer ----------

api.get('/computer', async (c) => c.json({ computer: await computers.refresh(c.get('user').id) }));

api.post('/computer/ensure', (c) => {
  const userId = c.get('user').id;
  computers.ensure(userId).catch((e) => console.warn('[computer] ensure failed', e.message));
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
  const [all, connected] = await Promise.all([catalog(), connectedToolkits(user.id)]);
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => matchesAppCategory(t, category));
  items.sort(compareAppPriority);
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  const pageNumber = (value: string | undefined, fallback: number) => value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
  const offset = pageNumber(c.req.query('offset'), 0);
  const limit = Math.max(1, Math.min(200, pageNumber(c.req.query('limit'), 60)));
  const apps = items.slice(offset, offset + limit);
  const nextOffset = offset + apps.length < items.length ? offset + apps.length : null;
  return c.json({ apps, connected: [...connected], connectedApps, categories, total: items.length, nextOffset });
});

api.get('/apps/connections', async c => c.json({ connections: await connectionsDetail(c.get('user').id) }));
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
  const r = await startConnect(user.id, slug, cb.toString());
  return c.json(r);
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
    const connected = await connectedToolkits(userId).catch(() => new Set<string>());
    if (connected.has(slug)) {
      ok = true;
      invalidateComposioSession(userId);
      hub.emit(userId, { type: 'connections' });
      if (botId && ownBot(userId, botId)) {
        const info = await toolkitInfo(slug);
        if (seq) {
          const row = getRow(botId, seq);
          if (row?.body.type === 'card' && row.body.card === 'connect') updateRow(botId, seq, { ...row.body, status: 'connected' });
        }
        enqueue(botId, { type: 'system', text: `The user connected ${info?.name ?? slug}. Continue with what you were doing.` });
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
