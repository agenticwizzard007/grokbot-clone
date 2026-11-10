import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import QRCode from 'qrcode';
import { createSession, requireUser, type AuthVars } from '../lib/auth.js';
import { canManageServer, clearSetting, saveSetting, SETTINGS, type SettingName } from '../settings.js';
import { env } from '../env.js';
import { getBotRow, getBot } from '../store.js';
import { accountByPhone, consumeLoginToken, createLoginLink, getAccount, isPlaceholderEmail, setEmail } from '../accounts.js';
import { deliver, hasTextLink } from './bridge.js';
import { inboxStats } from './inbox.js';
import { startPhoneLogin, verifyPhoneLogin } from './phone-auth.js';
import * as ib from './inkbox/client.js';
import { speechStatus, TTS_VOICES } from '../lib/speech.js';
import { forgetLineInfo, inkboxConfigured, lineInfo, setupLine, tunnelStatus, verifyAdminKey, webhookUrl } from './inkbox/adapter.js';
import {
  approveWaitlist, claimInvite, createInvite, declineWaitlist, inviteInfo, listInvites, listWaitlist, memberInvite, revokeInvite, signupConfig,
} from './signup.js';
import { CHANNEL_NAMES, deleteLink, digits, getPrefs, isChannel, listUserLinks, newLinkCode, setPrefs, VOICE_REPLIES, type VoiceReplies } from './store.js';

const clientIp = (c: any) => {
  try { return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || getConnInfo(c).remote.address || ''; } catch { return ''; }
};

// ---------- public: join page and sign-in by text ----------

export const messagingPublic = new Hono();

messagingPublic.get('/join/:code', async (c) => {
  const info = inviteInfo(c.req.param('code'));
  const line = info.valid ? await lineInfo().catch(() => null) : null;
  return c.json({
    valid: info.valid && !!line,
    inviter: info.inviter,
    line: line && { number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink, qr: await QRCode.toDataURL(line.smsLink, { margin: 1, width: 220 }) },
    reason: !info.valid ? 'This invite has expired or has been used up.' : !line ? "Texting isn't set up on this server yet." : null,
  });
});

messagingPublic.post('/join/:code/claim', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
  const r = claimInvite(c.req.param('code'), String(phone ?? ''), clientIp(c));
  if (!r.ok) return c.json({ error: r.error }, r.status as 400);
  return c.json({ ok: true });
});

const signinHits = new Map<string, number[]>();
/** Text a one-time sign-in link to a number. The same answer whether or not the number has an account. */
messagingPublic.post('/auth/text/request', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
  const p = digits(phone);
  if (p.length < 8 || p.length > 15) return c.json({ error: 'Enter your full number with country code.' }, 400);
  const key = `${clientIp(c)}|${p}`;
  const hits = (signinHits.get(key) ?? []).filter((t) => Date.now() - t < 10 * 60_000);
  if (hits.length >= 3) return c.json({ error: 'Too many tries. Wait a few minutes.' }, 429);
  signinHits.set(key, [...hits, Date.now()]);
  const acct = accountByPhone(p);
  if (acct && hasTextLink(acct.id)) {
    await deliver(acct.id, { text: `🔑 Sign in to Grokbot (works once, for 10 minutes):\n${createLoginLink(acct.id)}\n\nDidn't ask for this? Ignore it.` }, { kind: 'system' });
  }
  return c.json({ ok: true });
});

/**
 * Continue with your phone number: start → a code reaches the phone (texted, or in reply to their first text);
 * verify → signed in, account created if new, number connected.
 */
messagingPublic.post('/auth/phone/start', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
  const r = await startPhoneLogin(String(phone ?? ''), { ip: clientIp(c) });
  if (!r.ok) return c.json({ error: r.error }, r.status as 400);
  const line = await lineInfo().catch(() => null);
  return c.json({ id: r.id, line: line && { number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink } });
});

messagingPublic.post('/auth/phone/verify', async (c) => {
  const b = await c.req.json<{ id?: string; code?: string; inviteCode?: string }>().catch(() => ({} as any));
  const r = await verifyPhoneLogin(String(b.id ?? ''), String(b.code ?? ''), { inviteCode: b.inviteCode ? String(b.inviteCode) : undefined });
  if (!r.ok) return c.json({ error: r.error, needInvite: r.needInvite ?? false }, r.status as 400);
  createSession(c, r.userId);
  return c.json({ ok: true, created: r.created });
});

messagingPublic.get('/auth/text', (c) => {
  const userId = consumeLoginToken(c.req.query('t') ?? '');
  if (!userId) return c.redirect(`${env.appUrl}/?login=expired`);
  createSession(c, userId);
  return c.redirect(`${env.appUrl}/`);
});

// ---------- signed-in: Settings → Messaging ----------

export const messagingApi = new Hono<AuthVars>();
messagingApi.use('/*', requireUser);

async function status(userId: string, owner: boolean) {
  const prefs = getPrefs(userId);
  const active = prefs.activeBotId ? getBot(prefs.activeBotId) : null;
  const acct = getAccount(userId);
  const line = await lineInfo().catch(() => null);
  const cfg = signupConfig();
  return {
    account: { phone: acct?.phone ?? null, email: acct && !isPlaceholderEmail(acct.email) ? acct.email : null, signupSource: acct?.signupSource ?? 'web' },
    links: listUserLinks(userId).map((l) => ({ channel: l.channel, channelName: CHANNEL_NAMES[l.channel], status: l.status, phone: l.phone, lastInboundAt: l.lastInboundAt, error: l.error })),
    prefs: { forward: prefs.forward, activeBot: active ? { id: active.id, name: active.name } : null, voiceReplies: prefs.voiceReplies, ttsVoice: prefs.ttsVoice },
    speech: { ...speechStatus(), voices: TTS_VOICES },
    line: line ? { number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink } : null,
    invites: { allowance: cfg.memberInvites },
    ...(owner ? {
      owner: {
        inkbox: {
          adminKeySet: !!env.inkboxAdminKey, configured: inkboxConfigured(), handle: env.inkboxHandle, identityId: env.inkboxIdentityId || null,
          sms: !!env.inkboxPhoneNumberId, webhookUrl: webhookUrl(), tunnel: tunnelStatus(), inbox: inboxStats(),
        },
        signup: cfg,
      },
    } : {}),
  };
}

messagingApi.get('/', async (c) => c.json(await status(c.get('user').id, canManageServer(c.get('user')))));

messagingApi.patch('/prefs', async (c) => {
  const userId = c.get('user').id;
  const p = await c.req.json<{ forward?: string; activeBotId?: string | null; voiceReplies?: string; ttsVoice?: string | null }>();
  if (p.forward !== undefined && p.forward !== 'all' && p.forward !== 'engaged') return c.json({ error: 'bad forward mode' }, 400);
  if (p.voiceReplies !== undefined && !VOICE_REPLIES.includes(p.voiceReplies as VoiceReplies)) return c.json({ error: 'voiceReplies is voice-in, always or off' }, 400);
  if (p.ttsVoice !== undefined && p.ttsVoice !== null && p.ttsVoice !== '' && !TTS_VOICES.includes(p.ttsVoice)) return c.json({ error: `voice is one of ${TTS_VOICES.join(', ')}` }, 400);
  if (p.activeBotId) {
    const b = getBotRow(p.activeBotId);
    if (!b || b.user_id !== userId || b.hidden) return c.json({ error: 'not found' }, 404);
  }
  setPrefs(userId, {
    ...(p.forward ? { forward: p.forward as 'all' | 'engaged' } : {}),
    ...(p.activeBotId !== undefined ? { activeBotId: p.activeBotId } : {}),
    ...(p.voiceReplies ? { voiceReplies: p.voiceReplies as VoiceReplies } : {}),
    ...(p.ttsVoice !== undefined ? { ttsVoice: p.ttsVoice || null } : {}),
  });
  return c.json(await status(userId, canManageServer(c.get('user'))));
});

/** A one-time code to connect this account from a phone: text the connect command, then "LINK <code>". */
messagingApi.post('/code', async (c) => {
  const line = await lineInfo().catch(() => null);
  if (!line) return c.json({ error: "Texting isn't set up on this server yet." }, 400);
  const { code, expiresAt } = newLinkCode(c.get('user').id);
  return c.json({ code, expiresAt, number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink, qr: await QRCode.toDataURL(line.smsLink, { margin: 1, width: 200 }) });
});

/** Connect your phone (signed in): the same code flow, attaching the number to this account. */
messagingApi.post('/phone/start', async (c) => {
  const { phone } = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
  const r = await startPhoneLogin(String(phone ?? ''), { ip: clientIp(c), attachTo: c.get('user').id });
  if (!r.ok) return c.json({ error: r.error }, r.status as 400);
  const line = await lineInfo().catch(() => null);
  return c.json({ id: r.id, line: line && { number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink } });
});

messagingApi.post('/phone/verify', async (c) => {
  const b = await c.req.json<{ id?: string; code?: string }>().catch(() => ({} as any));
  const r = await verifyPhoneLogin(String(b.id ?? ''), String(b.code ?? ''), { attachTo: c.get('user').id });
  if (!r.ok) return c.json({ error: r.error }, r.status as 400);
  return c.json(await status(c.get('user').id, canManageServer(c.get('user'))));
});

messagingApi.delete('/links/:channel', async (c) => {
  const ch = c.req.param('channel');
  if (!isChannel(ch)) return c.json({ error: 'unknown channel' }, 404);
  deleteLink(c.get('user').id, ch);
  return c.json(await status(c.get('user').id, canManageServer(c.get('user'))));
});

messagingApi.post('/test', async (c) => {
  const userId = c.get('user').id;
  if (!hasTextLink(userId)) return c.json({ error: 'No phone is connected yet.' }, 400);
  await deliver(userId, { text: '👋 Test from Grokbot: texting works. Send /help to see what you can do here.' }, { kind: 'system' });
  return c.json({ ok: true });
});

messagingApi.put('/email', async (c) => {
  const { email } = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
  const r = setEmail(c.get('user').id, String(email ?? ''));
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json(await status(c.get('user').id, canManageServer(c.get('user'))));
});

/** Your own invite link (members). */
messagingApi.post('/my-invite', (c) => {
  const r = memberInvite(c.get('user').id);
  return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
});

// ---------- owner: the line, sign-up, invites, waitlist ----------

const ownerOnly = (c: any) => (canManageServer(c.get('user')) ? null : c.json({ error: 'Only the owner of this server can change this.' }, 403));

messagingApi.put('/inkbox', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const { adminKey } = await c.req.json<{ adminKey?: string }>().catch(() => ({} as any));
  const key = String(adminKey ?? '').trim();
  if (!key || key.length > 400 || /\s/.test(key)) return c.json({ error: "That doesn't look like an Inkbox key." }, 400);
  const r = await verifyAdminKey(key);
  if (!r.ok) return c.json({ error: r.error }, 400);
  saveSetting('inkbox_admin_key', key, c.get('user').id);
  forgetLineInfo();
  return c.json(await status(c.get('user').id, true));
});

messagingApi.post('/inkbox/setup', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const b = await c.req.json<{ handle?: string; withPhone?: boolean; rotateSigningKey?: boolean }>().catch(() => ({} as any));
  const setup = await setupLine(c.get('user').id, b);
  forgetLineInfo();
  return c.json({ setup, ...(await status(c.get('user').id, true)) }, setup.step === 'done' ? 200 : 400);
});

messagingApi.delete('/inkbox', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  for (const k of Object.keys(SETTINGS).filter((k) => k.startsWith('inkbox_')) as SettingName[]) clearSetting(k);
  forgetLineInfo();
  return c.json(await status(c.get('user').id, true));
});

// ---------- owner: the line's contact card (name, description, photo) ----------

messagingApi.get('/inkbox/profile', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  if (!inkboxConfigured()) return c.json({ error: 'Set up the line first.' }, 400);
  try { return c.json(await ib.getProfile(env.inkboxAdminKey, env.inkboxHandle)); }
  catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
});

messagingApi.put('/inkbox/profile', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  if (!inkboxConfigured()) return c.json({ error: 'Set up the line first.' }, 400);
  const b = await c.req.json<{ displayName?: string; description?: string }>().catch(() => ({} as any));
  const name = b.displayName === undefined ? undefined : String(b.displayName).trim().slice(0, 60);
  if (name !== undefined && !name) return c.json({ error: 'Enter a name.' }, 400);
  const description = b.description === undefined ? undefined : String(b.description).trim().slice(0, 300) || null;
  try {
    await ib.updateProfile(env.inkboxAdminKey, env.inkboxHandle, { displayName: name, description });
    return c.json(await ib.getProfile(env.inkboxAdminKey, env.inkboxHandle));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
});

/** The photo, for the settings page preview (proxied: the admin key never reaches the browser). */
messagingApi.get('/inkbox/avatar', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const img = inkboxConfigured() ? await ib.getAvatar(env.inkboxAdminKey, env.inkboxHandle).catch(() => null) : null;
  return img ? c.body(img, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }) : c.body(null, 404);
});

messagingApi.put('/inkbox/avatar', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  if (!inkboxConfigured()) return c.json({ error: 'Set up the line first.' }, 400);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'Choose an image.' }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'The image is larger than 10 MB.' }, 413);
  try {
    await ib.uploadAvatar(env.inkboxAdminKey, env.inkboxHandle, { data: Buffer.from(await file.arrayBuffer()), filename: file.name || 'avatar.png', contentType: file.type || 'application/octet-stream' });
    return c.json(await ib.getProfile(env.inkboxAdminKey, env.inkboxHandle));
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, e?.status === 415 || e?.status === 413 ? e.status : 502); }
});

messagingApi.delete('/inkbox/avatar', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  if (!inkboxConfigured()) return c.json({ error: 'Set up the line first.' }, 400);
  try { await ib.deleteAvatar(env.inkboxAdminKey, env.inkboxHandle); return c.json(await ib.getProfile(env.inkboxAdminKey, env.inkboxHandle)); }
  catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
});

messagingApi.put('/signup', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const b = await c.req.json<{ mode?: string; signupsPerDay?: number; dailyTurns?: number; memberInvites?: number }>().catch(() => ({} as any));
  const user = c.get('user').id;
  if (b.mode !== undefined) {
    if (!['invite', 'open', 'closed'].includes(b.mode)) return c.json({ error: 'Mode is invite, open or closed.' }, 400);
    saveSetting('messaging_signup_mode', b.mode, user);
  }
  const num = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
  if (b.signupsPerDay !== undefined) { if (!num(b.signupsPerDay, 100_000)) return c.json({ error: 'bad signupsPerDay' }, 400); saveSetting('messaging_signups_per_day', String(b.signupsPerDay), user); }
  if (b.dailyTurns !== undefined) { if (!num(b.dailyTurns, 100_000)) return c.json({ error: 'bad dailyTurns' }, 400); saveSetting('messaging_daily_messages', String(b.dailyTurns), user); }
  if (b.memberInvites !== undefined) { if (!num(b.memberInvites, 1000)) return c.json({ error: 'bad memberInvites' }, 400); saveSetting('messaging_member_invites', String(b.memberInvites), user); }
  return c.json(await status(user, true));
});

messagingApi.get('/invites', (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  return c.json({ invites: listInvites().map((i) => ({ ...i, createdByName: i.createdBy ? getAccount(i.createdBy)?.name ?? null : null })) });
});

messagingApi.post('/invites', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const b = await c.req.json<{ maxUses?: number; expiresInDays?: number | null; note?: string }>().catch(() => ({} as any));
  const inv = createInvite(c.get('user').id, { maxUses: b.maxUses, expiresInDays: b.expiresInDays, note: b.note });
  return c.json({ invite: { ...inv, qr: await QRCode.toDataURL(inv.url, { margin: 1, width: 200 }) } });
});

messagingApi.delete('/invites/:code', (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  return revokeInvite(c.req.param('code')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

messagingApi.get('/waitlist', (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  return c.json({ waitlist: listWaitlist() });
});

messagingApi.post('/waitlist/:phone/approve', async (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  const r = await approveWaitlist(c.req.param('phone'), c.get('user').id);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 404);
});

messagingApi.post('/waitlist/:phone/decline', (c) => {
  const deny = ownerOnly(c); if (deny) return deny;
  return declineWaitlist(c.req.param('phone')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});
