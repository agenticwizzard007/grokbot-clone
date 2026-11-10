import { selectedCli } from './cli/store.js';
import { verifyVoiceKey } from './settings.js';
import { Hono } from 'hono';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow, listRoutines, listTasks } from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { computers, ComputerError } from './computers/index.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createPairing, localFilePath, pairingInfo, revokePairings } from './computers/local.js';
import { startThisComputer, stopThisComputer, thisComputerAvailable, thisComputerUser } from './computers/this-computer.js';
import { canManageServer, clearSetting, saveSetting, SETTINGS, settingsStatus, verifyComposioKey, verifyOpenRouterKey, verifyDirectKey, type SettingName } from './settings.js';
import { defaultModel, llmProvider, openrouterModels } from './lib/llm.js';
import { hub } from './lib/hub.js';
import { refreshTriggerSubscription } from './triggers.js';
import { runInBotQueue } from './agent/loop.js';
import { consolidateBot, historySize, maybeCompact, memoryConfig } from './agent/memory.js';
import { idleConfig, viewerCount } from './idle.js';
import { loadHistory } from './store.js';
import type { Memory, Skill } from './types.js';
import { getSetup, setupFiles } from './bot-setup.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*', '/settings/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const toMemory = (m: any): Memory => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at, source: m.source === 'learned' ? 'learned' : 'chat' });
const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const memories = (db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[]).map(toMemory);
  const job = db.prepare('SELECT last_consolidated_at, last_result FROM memory_jobs WHERE bot_id=?').get(b.id) as any;
  const lastCompaction = db.prepare('SELECT method, items_before, items_after, chars_before, chars_after, created_at FROM compactions WHERE bot_id=? ORDER BY id DESC LIMIT 1').get(b.id) as any;
  return c.json({
    memories,
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    memory: {
      lastConsolidatedAt: job?.last_consolidated_at ?? null,
      historyChars: historySize(b.id, loadHistory(b.id)),
      compactAtChars: memoryConfig.compactChars,
      lastCompaction: lastCompaction ?? null,
    },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- memory maintenance ----------

/** Run consolidation now instead of waiting for the idle window. */
configApi.post('/bots/:id/memories/consolidate', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await consolidateBot(b.id));
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502);
  }
});

/** Compact the stored history now (inside the bot's queue). `force` compacts even under the threshold. */
configApi.post('/bots/:id/compact', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const force = c.req.query('force') === '1';
  const before = loadHistory(b.id).length;
  const after = await runInBotQueue(b.id, async () => (await maybeCompact(b.id, loadHistory(b.id), { force })).length);
  return c.json({ itemsBefore: before, itemsAfter: after, compacted: after !== before });
});

// ---------- library: files the Bot saved (on its computer, or on this server for local computers) ----------

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const errStatus = (e: any) => (e instanceof ComputerError ? e.status : 502) as 400 | 404 | 409 | 502 | 503 | 504;

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  const setup = getSetup(b.id);
  const files = setup ? setupFiles(b.id) : {};
  if (setup && rel === 'Setup') return c.json({ status: 'ok', path: rel, files: Object.entries(files).map(([name, text]) => ({ name, size: Buffer.byteLength(text), modifiedAt: Math.max(setup.updatedAt, b.updated_at), isDir: false })) });
  const setupFolder = { name: 'Setup', size: 0, modifiedAt: Math.max(setup?.updatedAt ?? 0, b.updated_at), isDir: true };
  try {
    const listing = await computers.files.list(user.id, b.id, rel, c.req.query('wake') === '1');
    if (setup && !rel) {
      // The setup remains accessible even when the remote computer is unavailable.
      return c.json({ ...listing, status: 'ok', error: listing.error ?? (listing.status === 'asleep' ? 'Computer is asleep; showing saved setup only.' : undefined), files: [setupFolder, ...listing.files.filter((f) => f.name !== 'Setup' && !Object.hasOwn(files, f.name))] });
    }
    return c.json(listing);
  } catch (e: any) {
    if (setup && !rel) return c.json({ status: 'ok', path: rel, files: [setupFolder], error: String(e?.message ?? e).slice(0, 300) });
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path: p } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(p);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  if (rel.startsWith('Setup/') && Object.hasOwn(setupFiles(b.id), rel.slice(6))) {
    return c.json({ url: `/api/bots/${b.id}/setup/${encodeURIComponent(rel.slice(6))}` });
  }
  try {
    return c.json({ url: await computers.files.download(user.id, b.id, rel) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, errStatus(e));
  }
});

/** Local computers keep Library files on this server; always served as a download, never rendered. */
configApi.get('/bots/:id/files/raw', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel || (computers.kind !== 'local' && computers.kind !== 'cloudvm')) return c.json({ error: 'bad path' }, 400);
  let file: string;
  try { file = localFilePath(b.id, rel); } catch { return c.json({ error: 'bad path' }, 400); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return c.json({ error: 'not found' }, 404);
  const name = path.basename(file).replace(/["\\\r\n]/g, '_');
  return c.body(fs.readFileSync(file), 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
});

// ---------- computer: screens, reset, hibernation, pairing a PC ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  return c.json({
    computer: computers.state(userId),
    screens: computers.screens(userId),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
    pairing: computers.kind === 'local' ? pairingInfo(userId) : null,
    thisComputer: computers.kind === 'local' ? { available: thisComputerAvailable() && fromThisMachine(c) && canManageServer(c.get('user')), active: thisComputerUser() === userId } : null,
  });
});

/** True when the request comes from the machine the server runs on (so "this computer" means the user's own). */
function fromThisMachine(c: any): boolean {
  try {
    const addr = getConnInfo(c).remote.address ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  } catch { return false; }
}

/** Local computers: use the computer the server runs on (the server starts the companion itself). */
configApi.post('/computer/this-computer', (c) => {
  if (computers.kind !== 'local') return c.json({ error: 'This server uses cloud computers.' }, 400);
  if (!thisComputerAvailable() || !fromThisMachine(c)) return c.json({ error: 'Only available when you open Swarm on the computer it runs on.' }, 403);
  const user = c.get('user');
  // Behind a reverse proxy on the same host every request looks local, so also require the server's owner.
  if (!canManageServer(user)) return c.json({ error: 'Only the owner of this server can use the computer it runs on.' }, 403);
  if (thisComputerUser() && thisComputerUser() !== user.id) return c.json({ error: 'Another account is already using this computer.' }, 409);
  startThisComputer(user.id);
  return c.json({ ok: true });
});

configApi.delete('/computer/this-computer', (c) => {
  if (thisComputerUser() !== c.get('user').id) return c.json({ error: 'Not in use by your account.' }, 409);
  stopThisComputer();
  return c.json({ ok: true });
});

/** Give a bot a clean screen: close its windows (or its browser) so it starts clean next time. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await computers.resetScreen(user.id, b.id));
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, errStatus(e));
  }
});

/** Local computers: make a pairing token and the command that connects a PC with it. */
configApi.post('/computer/pair', (c) => {
  if (computers.kind !== 'local') return c.json({ error: 'This server uses cloud computers (COMPUTER_PROVIDER=orgo).' }, 400);
  const token = createPairing(c.get('user').id);
  const server = env.serverUrl.replace(/\/+$/, '');
  return c.json({
    token,
    server,
    command: `curl -fsSL ${server}/api/companion/script -o swarm-companion.mjs && node swarm-companion.mjs --server ${server} --token ${token}${env.localDesktop ? ' --desktop' : ''}`,
  });
});

/** Local computers: forget every paired PC and disconnect the current one. */
configApi.delete('/computer/pair', (c) => {
  if (computers.kind !== 'local') return c.json({ error: 'not available' }, 400);
  if (thisComputerUser() === c.get('user').id) stopThisComputer();
  return c.json({ ok: true, revoked: revokePairings(c.get('user').id) });
});

// ---------- API keys (Settings → API keys): owner only, verified with the provider before saving ----------

configApi.get('/settings/keys', (c) => c.json({ canEdit: canManageServer(c.get('user')), ...settingsStatus() }));

configApi.put('/settings/keys/:name', async (c) => {
  const user = c.get('user');
  if (!canManageServer(user)) return c.json({ error: 'Only the owner of this server can change its keys.' }, 403);
  const name = c.req.param('name') as SettingName;
  if (!(name in SETTINGS)) return c.json({ error: 'unknown setting' }, 404);
  if (name.startsWith('inkbox_') || name.startsWith('messaging_')) return c.json({ error: 'Set these in Settings → Messaging.' }, 400);
  const { value } = await c.req.json<{ value?: string }>().catch(() => ({ value: '' }));
  const v = String(value ?? '').trim();
  if (!v) return c.json({ error: 'Enter a value first.' }, 400);
  if (v.length > 400 || /\s/.test(v)) return c.json({ error: "That doesn't look like a key." }, 400);
  if (name === 'voice') {
    const r = await verifyVoiceKey(v);
    if (!r.ok) return c.json({ error: r.error }, 400);
    saveSetting('voice', v, user.id);
    return c.json({ ok: true, canEdit: true, ...settingsStatus() });
  }
  if (name === 'direct') {
    const r = await verifyDirectKey(v, env.directModel);
    if (!r.ok) return c.json({ error: r.error }, 400);
    saveSetting('direct', v, user.id);
    return c.json({ ok: true, canEdit: true, models: r.models, modelOk: r.modelOk, ...settingsStatus() });
  }
  if (name === 'composio') {
    const r = await verifyComposioKey(v);
    if (!r.ok) return c.json({ error: r.error }, 400);
    saveSetting('composio', v, user.id);
    void refreshTriggerSubscription().catch((e) => console.warn('[triggers] could not apply Composio key change', e.message));
    hub.broadcast({ type: 'connections' });
    return c.json({ ok: true, canEdit: true, ...settingsStatus() });
  }
  if (name === 'openrouter') {
    const r = await verifyOpenRouterKey(v);
    if (!r.ok) return c.json({ error: r.error }, 400);
    saveSetting('openrouter', v, user.id);
    return c.json({ ok: true, canEdit: true, ...settingsStatus() });
  }
  if (name === 'provider') {
    if (v !== 'direct' && v !== 'openrouter') return c.json({ error: 'Choose openrouter or direct.' }, 400);
    // Allowed before the key exists (bring your own key next); until then the other provider keeps running.
    saveSetting('provider', v, user.id);
    return c.json({ ok: true, canEdit: true, ...settingsStatus() });
  }
  if (name === 'openrouter_model') {
    const list = await openrouterModels().catch(() => null);
    const m = list?.find((x) => x.id === v);
    if (list && !m) return c.json({ error: `${v} isn't an OpenRouter model that can use tools.` }, 400);
    saveSetting('openrouter_model', v, user.id);
    return c.json({ ok: true, canEdit: true, ...settingsStatus() });
  }
  // model: check it against the models the current key can use
  if (env.directKey) {
    const r = await verifyDirectKey(env.directKey, v);
    if (r.ok && !r.modelOk) return c.json({ error: `${v} isn't available on your direct provider key. Available: ${r.models.slice(0, 12).join(', ')}` }, 400);
  }
  saveSetting('model', v, user.id);
  return c.json({ ok: true, canEdit: true, ...settingsStatus() });
});

configApi.delete('/settings/keys/:name', (c) => {
  if (!canManageServer(c.get('user'))) return c.json({ error: 'Only the owner of this server can change its keys.' }, 403);
  const name = c.req.param('name') as SettingName;
  if (!(name in SETTINGS)) return c.json({ error: 'unknown setting' }, 404);
  clearSetting(name);
  if (name === 'composio') {
    void refreshTriggerSubscription().catch((e) => console.warn('[triggers] could not apply Composio key change', e.message));
    hub.broadcast({ type: 'connections' });
  }
  return c.json({ ok: true, canEdit: true, ...settingsStatus() });
});

/** Models for the model pickers: OpenRouter's tool-capable catalog, or the models the direct provider key can use. */
configApi.get('/settings/models', async (c) => {
  const cli = selectedCli(c.get('user').id);
  if (cli && !c.req.query('provider')) return c.json({ provider: `${cli}-cli`, models: [{ id: `${cli}/default`, name: cli === 'codex' ? 'ChatGPT · Codex default' : 'Claude · CLI default', vision: true, reasoning: true, context: 0, price: null }] });
  const provider = c.req.query('provider') === 'direct' || c.req.query('provider') === 'openrouter' ? c.req.query('provider') : llmProvider();
  if (provider === 'openrouter') {
    try { return c.json({ provider, defaultModel: defaultModel(), models: await openrouterModels() }); }
    catch (e: any) { return c.json({ provider, models: [], error: String(e?.message ?? e) }); }
  }
  if (!env.directKey) return c.json({ provider, models: [] });
  const r = await verifyDirectKey(env.directKey, env.directModel);
  return c.json(r.ok ? { provider, models: r.models.map((id) => ({ id, name: id, vision: true, reasoning: true, context: 0, price: null })) } : { provider, models: [], error: r.error });
});
