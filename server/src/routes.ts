import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, requireUser, userFromCookieHeader, type AuthVars } from './lib/auth.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt, resolveApproval, runInBotQueue } from './agent/loop.js';
import { computers } from './computers/index.js';
import { catalog, connectedToolkits, deleteConnection, disconnect, googleProfile, startConnect, startGoogleLogin, toolkitInfo } from './composio.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import { createBot } from './bots.js';
import { activateSetup, beginSetupInterview, briefSchema, emitSetup, getSetup, removeSetupFiles, setupFiles, setupView, writeSetupFiles } from './bot-setup.js';
import { importTeammate, provisionTeammate } from './agent/teammates.js';
import type { Toolkit } from './types.js';
import { verifyUserSig } from './messaging/store.js';
import { createAccount } from './accounts.js';

export const api = new Hono<AuthVars>();

const findOrCreateUser = (email: string, name?: string, preferId?: string) => createAccount({ email, name, preferId, source: 'web' });

// ---------- auth ----------

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie'));
  return c.json({ user, devLogin: env.devLogin, googleLogin: env.composioEnabled });
});

api.get('/auth/google/start', async (c) => {
  const attemptId = newId('login');
  const provisional = newId('usr');
  const cb = `${env.serverUrl}/api/auth/google/callback?attempt=${attemptId}`;
  const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, cb);
  db.prepare('INSERT INTO login_attempts(id,provisional_user_id,connected_account_id,created_at) VALUES (?,?,?,?)').run(attemptId, provisional, connectedAccountId ?? null, now());
  return c.redirect(redirectUrl);
});

api.get('/auth/google/callback', async (c) => {
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE id=?').get(c.req.query('attempt') ?? '') as any;
  const caId = c.req.query('connected_account_id') ?? attempt?.connected_account_id;
  if (!attempt || c.req.query('status') === 'failed' || !caId) return c.redirect(`${env.appUrl}/?login=failed`);
  if (attempt.connected_account_id && caId !== attempt.connected_account_id) return c.redirect(`${env.appUrl}/?login=failed`);
  db.prepare('DELETE FROM login_attempts WHERE id=?').run(attempt.id);
  try {
    const profile = await googleProfile(caId);
    const { id, isNew } = findOrCreateUser(profile.email, profile.name, attempt.provisional_user_id);
    // Existing user: the Gmail connection made for sign-in belongs to a throwaway id; remove it.
    if (!isNew && id !== attempt.provisional_user_id) await deleteConnection(caId);
    createSession(c, id);
    return c.redirect(`${env.appUrl}/`);
  } catch (e: any) {
    console.error('[auth] google callback', e);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin) return c.json({ error: 'disabled' }, 403);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  const { id } = findOrCreateUser(email, name);
  createSession(c, id);
  return c.json({ ok: true });
});

api.post('/auth/logout', (c) => { destroySession(c); return c.json({ ok: true }); });

// everything below requires a session
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path.startsWith('/api/messaging/inkbox/webhook') || c.req.path.startsWith('/api/join/') || c.req.path === '/api/health') return next();
  return requireUser(c, next);
});

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- bots ----------

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
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language', model: 'model' };
  for (const [k, col] of Object.entries(cols)) {
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
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
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
  const [all, connected] = await Promise.all([catalog(), connectedToolkits(user.id).catch(() => new Set<string>())]);
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => t.categories.some((x) => x.toLowerCase() === category.toLowerCase()));
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  return c.json({ apps: items.slice(0, Number(c.req.query('limit') ?? 120)), connected: [...connected], connectedApps, categories, total: items.length });
});

api.post('/apps/:slug/connect', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const { botId, seq } = await c.req.json<{ botId?: string; seq?: number }>().catch(() => ({} as any));
  const cb = new URL(`${env.serverUrl}/api/apps/callback`);
  cb.searchParams.set('slug', slug);
  if (botId) cb.searchParams.set('bot', botId);
  if (seq) cb.searchParams.set('seq', String(seq));
  const r = await startConnect(user.id, slug, cb.toString());
  return c.json(r);
});

api.get('/apps/callback', async (c) => {
  // Opened in the app (session cookie), or from a link sent by text (signed user id; the phone has no session).
  const signed = c.req.query('u') && verifyUserSig(c.req.query('u')!, 'apps-callback', c.req.query('sig') ?? '') ? c.req.query('u')! : '';
  const userId = userFromCookieHeader(c.req.header('cookie'))?.id ?? signed;
  const slug = c.req.query('slug') ?? '';
  const botId = c.req.query('bot');
  const seq = Number(c.req.query('seq') ?? 0);
  const ok = c.req.query('status') !== 'failed';
  const userExists = db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  if (userExists && ok) {
    const connected = await connectedToolkits(userId).catch(() => new Set<string>());
    if (connected.has(slug)) {
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
  return c.html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection failed.'}<script>try{window.opener&&window.opener.postMessage({type:'grokbot-connected',slug:${JSON.stringify(slug)},ok:${ok}},'*')}catch(e){};setTimeout(()=>window.close(),800)</script></body>`);
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
