import crypto from 'node:crypto';
import { env } from '../../env.js';

/**
 * Inkbox REST client (inkbox.ai): plain fetch with `X-API-Key`. Paths follow @inkbox/sdk 0.7 and open-instinct's
 * packages/inkbox (MIT). Two kinds of key: the org admin key (create identities, keys, signing keys, webhooks) and
 * an identity-scoped key (send and receive on that one identity). The server sends with the scoped key.
 */

export class InkboxError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly body?: unknown) {
    super(message);
  }
}

const api = (path: string) => `${env.inkboxBaseUrl}/api/v1${path}`;

async function request<T = any>(key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  if (!key) throw new InkboxError(0, 'no_key', 'Inkbox is not set up on this server.');
  const r = await fetch(api(path), {
    method,
    headers: { 'X-API-Key': key, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) {
    const detail = json?.detail ?? json?.error ?? json;
    const code = typeof detail === 'object' ? detail?.error ?? detail?.code : typeof json?.error === 'string' ? json.error : undefined;
    const msg = typeof detail === 'string' ? detail : detail?.message ?? json?.message ?? `Inkbox answered ${r.status}`;
    throw new InkboxError(r.status, code, String(msg).slice(0, 300), json);
  }
  return json as T;
}

/** Send with retries on 429/5xx, reusing one Idempotency-Key so a retry never sends twice. */
async function send<T = any>(key: string, path: string, body: unknown, params = ''): Promise<T> {
  const idem = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(key, 'POST', `${path}${params}`, body, { 'Idempotency-Key': idem, Prefer: 'idempotency-replay' });
    } catch (e) {
      const retry = e instanceof InkboxError ? [429, 502, 503, 504].includes(e.status) || e.code === 'idempotency_in_progress' : true;
      if (!retry || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

// ---------- admin (org key) ----------

export interface RouterInfo { number: string; connectCommand: string; smsLink: string; qr: string }

/** The shared iMessage router: the number people text and the exact connect command for an identity. */
export async function routerInfo(adminKey: string): Promise<RouterInfo> {
  const r = await request(adminKey, 'GET', '/imessage/triage-number');
  return { number: String(r?.number ?? ''), connectCommand: String(r?.connect_command ?? ''), smsLink: String(r?.sms_link ?? ''), qr: String(r?.connect_qr_png_data_url ?? r?.qr_png_data_url ?? '') };
}

export interface Identity { id: string; handle: string; email: string; phoneNumberId: string | null; phone: string | null; imessage: boolean }
const toIdentity = (r: any): Identity => ({
  id: String(r?.id ?? ''), handle: String(r?.agent_handle ?? ''), email: String(r?.email_address ?? r?.mailbox?.email_address ?? ''),
  phoneNumberId: r?.phone_number?.id ?? null, phone: r?.phone_number?.number ?? null, imessage: r?.imessage_enabled === true,
});

/** The name, description and photo people see on the line's contact card (sent when they connect). */
export interface Profile { displayName: string | null; description: string | null; hasAvatar: boolean }

export async function getProfile(adminKey: string, handle: string): Promise<Profile> {
  const r = await request(adminKey, 'GET', `/identities/${encodeURIComponent(handle)}`);
  return { displayName: r?.display_name ?? null, description: r?.description ?? null, hasAvatar: r?.has_avatar === true };
}

export async function updateProfile(adminKey: string, handle: string, p: { displayName?: string | null; description?: string | null }): Promise<void> {
  const body: Record<string, unknown> = {};
  if (p.displayName !== undefined) body.display_name = p.displayName;
  if (p.description !== undefined) body.description = p.description;
  // Dedicated lines share the name and photo only when contact sharing is on; harmless on the shared router.
  body.contact_sharing_enabled = true;
  await request(adminKey, 'PATCH', `/identities/${encodeURIComponent(handle)}`, body);
}

/** Upload (or replace) the contact-card photo. Inkbox trims borders and normalizes it to a 600×600 JPEG. */
export async function uploadAvatar(adminKey: string, handle: string, f: { data: Buffer; filename: string; contentType: string }): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.filename);
  const r = await fetch(api(`/identities/${encodeURIComponent(handle)}/avatar`), { method: 'PUT', headers: { 'X-API-Key': adminKey }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) {
    const j: any = await r.json().catch(() => null);
    throw new InkboxError(r.status, undefined, r.status === 415 ? "That file isn't an image Inkbox can read." : r.status === 413 ? 'The image is larger than 10 MB.' : `Photo upload failed (${r.status}): ${JSON.stringify(j?.detail ?? j).slice(0, 160)}`);
  }
}

export async function getAvatar(adminKey: string, handle: string): Promise<Buffer | null> {
  const r = await fetch(api(`/identities/${encodeURIComponent(handle)}/avatar`), { headers: { 'X-API-Key': adminKey }, signal: AbortSignal.timeout(20_000) });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

export async function deleteAvatar(adminKey: string, handle: string): Promise<void> {
  const r = await fetch(api(`/identities/${encodeURIComponent(handle)}/avatar`), { method: 'DELETE', headers: { 'X-API-Key': adminKey }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok && r.status !== 204) throw new InkboxError(r.status, undefined, `Couldn't remove the photo (${r.status}).`);
}

export async function getIdentity(adminKey: string, handle: string): Promise<Identity | null> {
  try { return toIdentity(await request(adminKey, 'GET', `/identities/${encodeURIComponent(handle)}`)); }
  catch (e) { if (e instanceof InkboxError && e.status === 404) return null; throw e; }
}

/** Create an iMessage-enabled identity; a taken handle gets -2, -3 … Optionally with a local number for SMS. */
export async function createIdentity(adminKey: string, handle: string, displayName: string, withPhone = false): Promise<Identity> {
  for (let i = 1; i <= 5; i++) {
    const h = i === 1 ? handle : `${handle}-${i}`;
    try {
      return toIdentity(await request(adminKey, 'POST', '/identities/', {
        agent_handle: h, display_name: displayName, imessage_enabled: true,
        ...(withPhone ? { phone_number: { type: 'local', incoming_call_action: 'auto_reject' } } : {}),
      }));
    } catch (e) {
      if (e instanceof InkboxError && e.status === 409) continue;
      if (e instanceof InkboxError && e.status === 402) throw new InkboxError(402, 'plan_limit', 'Your Inkbox plan has no room for another identity. Upgrade in the Inkbox console.');
      throw e;
    }
  }
  throw new Error(`Couldn't find a free Inkbox handle for "${handle}".`);
}

/** An API key scoped to one identity (shown once). */
export async function mintIdentityKey(adminKey: string, identityId: string, label: string): Promise<string> {
  const r = await request(adminKey, 'POST', '/api-keys', { label, scoped_identity_id: identityId });
  const key = r?.api_key ?? r?.key;
  if (!key) throw new Error('Inkbox did not return an API key.');
  return String(key);
}

export async function signingKeyConfigured(adminKey: string, handle: string): Promise<boolean> {
  const r = await request(adminKey, 'GET', `/identities/${encodeURIComponent(handle)}/signing-key`).catch(() => null);
  return r?.configured === true;
}

/** Create (or rotate) the identity's webhook signing key. Shown once. */
export async function createSigningKey(adminKey: string, handle: string): Promise<string> {
  const r = await request(adminKey, 'POST', `/identities/${encodeURIComponent(handle)}/signing-key`, {});
  const key = r?.signing_key ?? r?.signingKey;
  if (!key) throw new Error('Inkbox did not return a signing key.');
  return String(key);
}

export const WEBHOOK_EVENTS = ['imessage.received', 'imessage.reaction_received', 'text.received'];

export async function subscribeWebhook(adminKey: string, identityId: string, url: string): Promise<string> {
  // The list's identity filter doesn't return identity-owned subscriptions, so list all and match here.
  const list = await request(adminKey, 'GET', '/webhooks/subscriptions').catch(() => null);
  const items: any[] = Array.isArray(list) ? list : list?.items ?? list?.subscriptions ?? [];
  const mine = items.filter((s) => s?.agent_identity_id === identityId || s?.owner_identity_id === identityId);
  // A moved server (sandbox tunnel → public URL): drop this line's subscriptions to other URLs so texts arrive once.
  for (const old of mine.filter((s) => s?.url !== url && s?.id)) {
    // Subscriptions covering several event families need scope=identity to change or delete.
    await request(adminKey, 'DELETE', `/webhooks/subscriptions/${old.id}?scope=identity`).catch((e) => console.warn('[inkbox] could not remove old webhook', old.url, e?.message));
  }
  const same = mine.find((s) => s?.url === url);
  if (same) {
    const have: string[] = same.event_types ?? [];
    const missing = WEBHOOK_EVENTS.filter((e) => !have.includes(e));
    if (missing.length) await request(adminKey, 'PATCH', `/webhooks/subscriptions/${same.id}?scope=identity`, { event_types: [...have, ...missing] });
    return String(same.id);
  }
  const r = await request(adminKey, 'POST', '/webhooks/subscriptions', { url, event_types: WEBHOOK_EVENTS, agent_identity_id: identityId });
  return String(r?.id ?? r?.subscription?.id ?? '');
}

// ---------- sending (identity key) ----------

/** Send an iMessage into a conversation (or to a number). Inkbox falls back to SMS when the recipient has no iMessage. */
export async function sendIMessage(key: string, p: { conversationId?: string; to?: string; text?: string; replyToMessageId?: string; mediaUrls?: string[] }): Promise<{ id: string | null }> {
  const body: Record<string, unknown> = {};
  if (p.text) body.text = p.text;
  if (p.mediaUrls?.length) body.media_urls = p.mediaUrls.slice(0, 1);
  if (p.conversationId) body.conversation_id = p.conversationId;
  else if (p.to) body.to = p.to;
  if (p.replyToMessageId && p.conversationId) { body.reply_to_message_id = p.replyToMessageId; body.plain_reply_fallback = true; }
  const r = await send(key, '/imessage/messages', body);
  return { id: r?.message?.id ?? r?.id ?? null };
}

export async function sendSms(key: string, phoneNumberId: string, p: { conversationId?: string; to?: string; text: string }): Promise<{ id: string | null }> {
  const body: Record<string, unknown> = { text: p.text };
  if (p.conversationId) body.conversation_id = p.conversationId;
  else if (p.to) body.to = p.to;
  const r = await send(key, `/phone/numbers/${encodeURIComponent(phoneNumberId)}/texts`, body);
  return { id: r?.id ?? r?.text_message?.id ?? null };
}

/** Upload a file (max 10 MiB) and get a URL usable in `media_urls`. */
export async function uploadMedia(key: string, f: { data: Buffer; filename: string; contentType: string }): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.filename);
  const r = await fetch(api('/imessage/media'), { method: 'POST', headers: { 'X-API-Key': key, Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.media_url) throw new InkboxError(r.status, j?.detail?.error, `media upload failed (${r.status}): ${JSON.stringify(j?.detail ?? j).slice(0, 200)}`, j);
  return String(j.media_url);
}

/** Numbers currently connected to an identity on the shared router (admin key). */
export async function listAssignments(adminKey: string, identityId: string): Promise<{ remoteNumber: string; status: string }[]> {
  const r = await request(adminKey, 'GET', `/imessage/assignments?agent_identity_id=${encodeURIComponent(identityId)}`);
  const items: any[] = Array.isArray(r) ? r : r?.items ?? r?.assignments ?? [];
  return items.map((a) => ({ remoteNumber: String(a?.remote_number ?? ''), status: String(a?.status ?? '') }));
}

export const typing = (key: string, conversationId: string) => request(key, 'POST', '/imessage/typing', { conversation_id: conversationId });
export const markRead = (key: string, conversationId: string) => request(key, 'POST', '/imessage/mark-read', { conversation_id: conversationId });

/** Download inbound media. Signed URLs need no credentials, so the API key is never sent to them. */
export async function download(url: string, maxBytes = 10 * 1024 * 1024): Promise<{ data: Buffer; mime: string }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('attachment too large');
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > maxBytes) throw new Error('attachment too large');
  return { data, mime: r.headers.get('content-type') ?? 'application/octet-stream' };
}

// ---------- webhook signatures ----------

/** HMAC-SHA256 over `{request_id}.{timestamp}.{raw body}`; key with or without `whsec_`; 5-minute window. */
export function verifySignature(raw: string, headers: { requestId?: string; timestamp?: string; signature?: string }, signingKey: string, nowMs = Date.now()): boolean {
  if (!signingKey || !headers.signature?.startsWith('sha256=')) return false;
  const ts = headers.timestamp ?? '';
  const n = /^\d+(\.\d+)?$/.test(ts) ? Number(ts) : Date.parse(ts) / 1000;
  if (!Number.isFinite(n)) return false;
  const tsMs = n > 1e11 ? n : n * 1000;
  if (Math.abs(nowMs - tsMs) > 300_000) return false;
  const key = signingKey.startsWith('whsec_') ? signingKey.slice(6) : signingKey;
  const want = Buffer.from(`sha256=${crypto.createHmac('sha256', key).update(`${headers.requestId ?? ''}.${ts}.`).update(raw).digest('hex')}`);
  const got = Buffer.from(headers.signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
