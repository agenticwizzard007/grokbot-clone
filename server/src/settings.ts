import crypto from 'node:crypto';
import { db, now } from './db.js';
import { env, envSource, setEnvOverride } from './env.js';

/**
 * Provider keys set from the app (Settings → API keys). Stored in SQLite encrypted with a key
 * derived from SESSION_SECRET, loaded into env overrides at startup, and applied live on save.
 */

export const SETTINGS = {
  xai: { env: 'XAI_API_KEY', secret: true },
  composio: { env: 'COMPOSIO_API_KEY', secret: true },
  model: { env: 'XAI_MODEL', secret: false },
  openrouter: { env: 'OPENROUTER_API_KEY', secret: true },
  openrouter_model: { env: 'OPENROUTER_MODEL', secret: false },
  provider: { env: 'LLM_PROVIDER', secret: false },
} as const;
export type SettingName = keyof typeof SETTINGS;

const cryptoKey = crypto.createHash('sha256').update(`grokbot-settings:${env.sessionSecret}`).digest();

export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cryptoKey, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function unsealSecret(stored: string): string | null {
  if (!stored.startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', cryptoKey, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Apply saved settings at startup. */
export function loadSettings() {
  for (const row of db.prepare('SELECT key, value FROM server_settings').all() as { key: string; value: string }[]) {
    const def = (SETTINGS as Record<string, { env: string; secret: boolean }>)[row.key];
    if (!def) continue;
    const v = def.secret ? unsealSecret(row.value) : row.value;
    if (v === null) { console.warn(`[settings] could not decrypt ${row.key} (SESSION_SECRET changed?); re-enter it in Settings → API keys`); continue; }
    setEnvOverride(def.env, v);
  }
}

export function saveSetting(name: SettingName, value: string, userId: string) {
  const def = SETTINGS[name];
  db.prepare('INSERT OR REPLACE INTO server_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?)').run(name, def.secret ? sealSecret(value) : value, userId, now());
  setEnvOverride(def.env, value);
}

export function clearSetting(name: SettingName) {
  db.prepare('DELETE FROM server_settings WHERE key=?').run(name);
  setEnvOverride(SETTINGS[name].env, null);
}

const hint = (v: string) => (v.length > 8 ? `…${v.slice(-4)}` : 'set');

export function settingsStatus() {
  return {
    xai: { set: !!env.xaiKey, source: envSource('XAI_API_KEY'), hint: env.xaiKey ? hint(env.xaiKey) : null },
    composio: { set: !!env.composioKey, source: envSource('COMPOSIO_API_KEY'), hint: env.composioKey ? hint(env.composioKey) : null },
    openrouter: { set: !!env.openrouterKey, source: envSource('OPENROUTER_API_KEY'), hint: env.openrouterKey ? hint(env.openrouterKey) : null },
    model: { value: env.xaiModel, source: envSource('XAI_MODEL') },
    openrouterModel: { value: env.openrouterModel, source: envSource('OPENROUTER_MODEL') },
    /** Which service runs the Bots' models, and whether it was chosen explicitly. */
    provider: { value: env.llmProvider, chosen: env.llmProviderChoice, source: envSource('LLM_PROVIDER') },
  };
}

/** Who may change server-wide keys: ADMIN_EMAILS if set, otherwise the first account on this server (its owner). */
export function canManageServer(user: { id: string; email: string }): boolean {
  const admins = (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (admins.length) return admins.includes(user.email.toLowerCase());
  const owner = db.prepare('SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get() as { id: string } | undefined;
  return owner?.id === user.id;
}

// ---------- validation: call the provider with the key before saving it ----------

export async function verifyXaiKey(key: string, model: string): Promise<{ ok: true; models: string[]; modelOk: boolean } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${env.xaiBaseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: r.status === 400 || r.status === 401 || r.status === 403 ? 'xAI rejected this key.' : `xAI answered ${r.status}: ${String(body?.error?.message ?? body?.error ?? '').slice(0, 200)}` };
    const models: string[] = (body?.data ?? body?.models ?? []).map((m: any) => String(m.id ?? m)).filter(Boolean).sort();
    return { ok: true, models, modelOk: !models.length || models.includes(model) };
  } catch (e: any) {
    return { ok: false, error: `Couldn't reach xAI: ${e?.message ?? e}` };
  }
}

export async function verifyComposioKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch('https://backend.composio.dev/api/v3.1/toolkits?limit=1', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) return { ok: true };
    return { ok: false, error: r.status === 401 || r.status === 403 ? 'Composio rejected this key.' : `Composio answered ${r.status}.` };
  } catch (e: any) {
    return { ok: false, error: `Couldn't reach Composio: ${e?.message ?? e}` };
  }
}

export async function verifyOpenRouterKey(key: string): Promise<{ ok: true; label?: string } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${env.openrouterBaseUrl}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const body: any = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, label: body?.data?.label };
    return { ok: false, error: r.status === 401 || r.status === 403 ? 'OpenRouter rejected this key.' : `OpenRouter answered ${r.status}.` };
  } catch (e: any) {
    return { ok: false, error: `Couldn't reach OpenRouter: ${e?.message ?? e}` };
  }
}
