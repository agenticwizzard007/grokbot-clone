// Messaging tests: sign-up by text and running Bots over iMessage/SMS (Inkbox), with real agent turns against the mock
// model and an in-process fake Inkbox API. No phone, keys or network needed.
//   node --import tsx --test --test-concurrency=1 tests/messaging.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-messaging-'));
const free = () => new Promise<number>((r) => { const s = http.createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const mockPort = await free();
const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-xai.mjs'), String(mockPort)], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`http://localhost:${mockPort}/_requests`).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

// A real iMessage-style voice note (Opus in a CAF container), made with the bundled ffmpeg.
const { createRequire } = await import('node:module');
const ffmpegBin = createRequire(import.meta.url)('ffmpeg-static') as string;
const cafPath = path.join(root, 'voice.caf');
const { execFileSync } = await import('node:child_process');
execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'caf', cafPath, '-y']);
const cafAudio = fs.readFileSync(cafPath);

// ---------- fake Inkbox ----------
const ib = { assignments: [] as string[], sent: [] as any[], uploads: [] as { type: string; bytes: number }[], identities: 0, keys: 0, signing: 0, subs: [] as any[], failKeyOnce: false, signingConfigured: false };
const inkbox = http.createServer((req, res) => {
  let raw = '';
  const chunks: Buffer[] = [];
  req.on('data', (d) => { raw += d; chunks.push(d); });
  req.on('end', () => {
    const json = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const url = req.url ?? '';
    if (url.startsWith('/media/voice')) { res.writeHead(200, { 'content-type': 'audio/x-caf' }); return res.end(cafAudio); }
    if (url === '/api/v1/imessage/media' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== 'idkey') return json(401, { detail: 'bad key' });
      const type = /Content-Type: (\S+)/i.exec(raw)?.[1] ?? '';
      ib.uploads.push({ type, bytes: Buffer.concat(chunks).length });
      return json(201, { media_url: `https://media.inkbox.test/${ib.uploads.length}.mp3`, content_type: type });
    }
    if (url.startsWith('/media/photo')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); }
    const key = req.headers['x-api-key'];
    const body = raw ? JSON.parse(raw) : {};
    const p = url.replace(/^\/api\/v1/, '');
    if (p === '/imessage/messages' && req.method === 'POST') {
      if (key !== 'idkey') return json(401, { detail: 'bad key' });
      ib.sent.push(body);
      return json(200, { message: { id: `im_out_${ib.sent.length}`, conversation_id: body.conversation_id } });
    }
    if ((p === '/imessage/typing' || p === '/imessage/mark-read') && req.method === 'POST') return json(200, { ok: true });
    if (key !== 'admin') return json(401, { detail: 'bad admin key' });
    if (p.startsWith('/imessage/assignments')) return json(200, ib.assignments.map((n) => ({ id: `as_${n}`, remote_number: `+${n}`, status: 'active' })));
    if (p === '/imessage/triage-number') return json(200, { number: '+14155550199', connect_command: 'connect @handle', sms_link: 'sms:+14155550199', connect_qr_png_data_url: '' });
    if (p === '/identities/' && req.method === 'POST') { ib.identities++; return json(201, { id: 'idn_new', agent_handle: body.agent_handle, email_address: `${body.agent_handle}@inkboxmail.com`, imessage_enabled: true }); }
    if (p === '/api-keys' && req.method === 'POST') { if (ib.failKeyOnce) { ib.failKeyOnce = false; return json(500, { detail: 'boom' }); } ib.keys++; return json(201, { api_key: 'idkey' }); }
    if (/^\/identities\/[^/]+\/signing-key$/.test(p)) return req.method === 'GET' ? json(200, { configured: ib.signingConfigured }) : (ib.signing++, json(201, { signing_key: 'whsec_test' }));
    if (p.startsWith('/webhooks/subscriptions')) {
      if (req.method === 'GET') return json(200, ib.subs);
      ib.subs.push({ id: `sub_${ib.subs.length + 1}`, ...body });
      return json(201, { id: `sub_${ib.subs.length}` });
    }
    json(404, { detail: 'not mocked' });
  });
});
const ibPort = await free();
await new Promise<void>((r) => inkbox.listen(ibPort, r));

Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://localhost:${mockPort}/api/v1`, XAI_API_KEY: 'test', XAI_BASE_URL: `http://localhost:${mockPort}/v1`, LLM_PROVIDER: 'openrouter',
  INKBOX_BASE_URL: `http://localhost:${ibPort}`, INKBOX_ADMIN_API_KEY: 'admin', INKBOX_API_KEY: 'idkey', INKBOX_SIGNING_KEY: 'whsec_test', INKBOX_IDENTITY_ID: 'idn_1', INKBOX_HANDLE: 'grokbot',
  SERVER_URL: 'https://grokbot.test', APP_URL: 'https://grokbot.test', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { initProactive } = await import('../server/src/proactive.js');
const { enqueue } = await import('../server/src/agent/loop.js');
initProactive(enqueue);
const { listRows, appendRow, getRow } = await import('../server/src/store.js');
const { createAccount, getAccount } = await import('../server/src/accounts.js');
const { systemPrompt } = await import('../server/src/agent/prompt.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { initMessaging, inkboxWebhook, messagingApi, messagingPublic } = await import('../server/src/messaging/index.js');
const bridge = await import('../server/src/messaging/bridge.js');
const inbox = await import('../server/src/messaging/inbox.js');
const store = await import('../server/src/messaging/store.js');
const signup = await import('../server/src/messaging/signup.js');
const { setupLine } = await import('../server/src/messaging/inkbox/adapter.js');
const { matchApprovalReply, parseVerdict } = await import('../server/src/messaging/approvals.js');
const { speakable } = await import('../server/src/messaging/bridge.js');
const { toPlainText } = await import('../server/src/messaging/format.js');
const { saveSetting, clearSetting } = await import('../server/src/settings.js');
const { Hono } = await import('hono');
initMessaging({ process: true });
const app = new Hono().route('/api/messaging/inkbox/webhook', inkboxWebhook).route('/api', messagingPublic).route('/api/messaging', messagingApi);

after(() => { mock.kill(); inkbox.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

// ---------- helpers ----------
let evN = 0;
const sign = (raw: string, reqId: string, ts: string, key = 'test') => `sha256=${crypto.createHmac('sha256', key).update(`${reqId}.${ts}.${raw}`).digest('hex')}`;
async function hook(body: unknown, opts: { key?: string; ts?: string; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const reqId = `req_${++evN}`;
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return app.request('/api/messaging/inkbox/webhook', { method: 'POST', body: opts.tamper ? raw.replace('"', ' "') : raw, headers: { 'content-type': 'application/json', 'x-inkbox-request-id': reqId, 'x-inkbox-timestamp': ts, 'x-inkbox-signature': sign(raw, reqId, ts, opts.key) } });
}
const conv = (phone: string) => `conv_${phone}`;
function imessage(phone: string, text: string, extra: Record<string, unknown> = {}) {
  const id = `im_in_${++evN}`;
  return { id: `evt_${id}`, event_type: 'imessage.received', timestamp: new Date().toISOString(), data: { message: { id, conversation_id: conv(phone), remote_number: `+${phone}`, content: text, is_group: false, ...extra } } };
}
const text = async (phone: string, t: string, extra: Record<string, unknown> = {}) => { const ev = imessage(phone, t, extra); const r = await hook(ev); assert.equal(r.status, 204); await inbox.settle(); return ev; };
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); }
}
const sentTo = (phone: string, re: RegExp) => waitFor(() => ib.sent.find((m) => m.conversation_id === conv(phone) && re.test(m.text)));
const usersCount = () => (db.prepare('SELECT count(*) n FROM users').get() as any).n;
const OWNER = '15550000001';
const cookieFor = (userId: string) => { const t = `sess_${userId}`; db.prepare('INSERT OR IGNORE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, Date.now(), Date.now() + 600_000); return `grokbot_session=${t}`; };

// ---------- tests ----------

test('webhook signatures: valid, wrong key, tampered body, stale timestamp; receipts ignored', async () => {
  const ev = imessage('15559990000', 'hi');
  assert.equal((await hook(ev, { key: 'nope' })).status, 401);
  assert.equal((await hook(ev, { tamper: true })).status, 401);
  assert.equal((await hook(ev, { ts: String(Math.floor(Date.now() / 1000) - 900) })).status, 401);
  assert.equal((await hook({ id: 'evt_receipt', event_type: 'imessage.delivered', data: { message: {} } })).status, 204);
  assert.equal((db.prepare("SELECT count(*) n FROM messaging_inbox WHERE id='inkbox:evt_receipt'").get() as any).n, 0);
});

test('no sign-up before the server has an owner', async () => {
  assert.equal(usersCount(), 0);
  await text('15559990000', 'hello');
  await sentTo('15559990000', /isn't set up yet/);
  assert.equal(usersCount(), 0);
});

let owner: string;
test('unknown numbers join the waitlist once (invite mode)', async () => {
  owner = createAccount({ email: 'owner@example.com', name: 'Owner', source: 'web' }).id;
  ib.sent.length = 0;
  await text('15550001111', 'hey is this grokbot?');
  await sentTo('15550001111', /waitlist/);
  await text('15550001111', 'hello?');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ib.sent.filter((m) => m.conversation_id === conv('15550001111')).length, 1, 'no second reply the same day');
  const w = signup.listWaitlist().find((x) => x.phone === '15550001111')!;
  assert.equal(w.status, 'pending');
  assert.equal(w.firstMessage, 'hey is this grokbot?');
});

let alice: string;
test('join page claim → first text creates the account, welcomes, and onboarding starts', async () => {
  const inv = signup.createInvite(owner, { maxUses: 2 });
  const info = await (await app.request(`/api/join/${inv.code}`)).json() as any;
  assert.equal(info.valid, true);
  assert.equal(info.inviter, 'Owner');
  assert.match(info.line.smsLink, /^sms:\+14155550199\?&body=connect%20%40grokbot$/);
  const claim = await app.request(`/api/join/${inv.code}/claim`, { method: 'POST', body: JSON.stringify({ phone: '+1 (555) 000-2222' }), headers: { 'content-type': 'application/json' } });
  assert.equal(claim.status, 200);

  await text('15550002222', 'connect @grokbot');
  const acct = await waitFor(() => db.prepare("SELECT * FROM users WHERE phone='15550002222'").get() as any);
  alice = acct.id;
  assert.equal(acct.signup_source, 'text');
  assert.equal(acct.invited_by, owner);
  assert.equal(acct.email, 'tel+15550002222@phone.invalid');
  assert.equal(store.getLink(alice, 'imessage')!.chatRef, conv('15550002222'));
  await sentTo('15550002222', /^Hi! 👋 I'm Quinn, your Grokbot/);
  // The [onboarding] turn ran and its reply came back by text.
  const onboarding = await sentTo('15550002222', /onboarding\] A new user just joined/);
  assert.ok(!/\*\*/.test(onboarding.text), 'plain text, no Markdown');
  assert.equal(signup.listInvites().find((i) => i.code === inv.code)!.uses, 1);
  const prompt = await systemPrompt(alice, (db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(alice) as any).id);
  assert.match(prompt, /## Onboarding/);
  assert.match(prompt, /\(phone \+15550002222\)/);
  assert.doesNotMatch(prompt, /phone\.invalid/);
});

test('JOIN <code> typed in the chat; used-up and unknown codes are refused', async () => {
  const inv = signup.createInvite(owner, { maxUses: 1 });
  await text('15550003333', `join ${inv.code.toLowerCase()}`);
  await waitFor(() => db.prepare("SELECT 1 FROM users WHERE phone='15550003333'").get());
  await text('15550004444', `JOIN ${inv.code}`);
  await sentTo('15550004444', /isn't valid anymore/);
  await text('15550004445', 'PASSWORD');
  await sentTo('15550004445', /waitlist/);
  assert.equal(db.prepare("SELECT 1 FROM users WHERE phone IN ('15550004444','15550004445')").get(), undefined);
});

test('owner approves a waitlisted number: account created and welcomed where they wrote', async () => {
  const r = await signup.approveWaitlist('15550001111', owner);
  assert.ok(r.ok);
  await sentTo('15550001111', /I'm Quinn, your Grokbot/);
  assert.equal(signup.listWaitlist().find((x) => x.phone === '15550001111')!.status, 'approved');
});

test('open and closed modes', async () => {
  saveSetting('messaging_signup_mode', 'open', owner);
  await text('15550005555', 'hi');
  await waitFor(() => db.prepare("SELECT 1 FROM users WHERE phone='15550005555'").get());
  saveSetting('messaging_signup_mode', 'closed', owner);
  await text('15550006666', 'hi');
  await sentTo('15550006666', /isn't taking new members/);
  assert.equal(db.prepare("SELECT 1 FROM users WHERE phone='15550006666'").get(), undefined);
  saveSetting('messaging_signup_mode', 'invite', owner);
});

test('texting the Bots: plain-text replies on the same conversation, @Name routing, long replies split', async () => {
  const phone = '15550002222';
  await waitFor(() => !bridge.pickLink(alice) ? null : true);
  ib.sent.length = 0;
  await text(phone, 'hello team');
  const r = await sentTo(phone, /Got it: "\[via iMessage\] hello team"/);
  assert.ok(!/^\*\*|Quinn:/.test(r.text), 'the active Bot is not named');
  const user = listRows((db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(alice) as any).id).find((x) => x.body.type === 'message' && (x.body as any).text === 'hello team');
  assert.deepEqual((user!.body as any).from, { kind: 'imessage', id: 'imessage', name: 'iMessage' });

  db.prepare("UPDATE bot_setups SET onboarding_status='active'").run();
  const { createBot } = await import('../server/src/bots.js');
  createBot(alice, { name: 'Ava', label: 'Research' });
  db.prepare("UPDATE bot_setups SET onboarding_status='active'").run();
  await text(phone, '@ava find sources');
  const avaReply = await sentTo(phone, /find sources/);
  assert.match(avaReply.text, /^Ava: /, 'other Bots are named (plain text)');

  ib.sent.length = 0;
  await text(phone, `mock: say ${'word '.repeat(700)}`);
  await waitFor(() => ib.sent.filter((m) => m.conversation_id === conv(phone)).length >= 3);
  assert.ok(ib.sent.every((m) => m.text.length <= 1500));
});

test('a reply repeated after a tool call is texted once', async () => {
  const phone = '15550002222';
  const bot = (db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(alice) as any).id;
  await new Promise((r) => setTimeout(r, 300));
  ib.sent.length = 0;
  // What a real model does: the reply, a tool call to save the answer, then the same reply again.
  appendRow(bot, 'message', { type: 'message', role: 'assistant', text: 'Same question?' });
  appendRow(bot, 'tool-call', { type: 'tool-call', callId: 'c1', name: 'remember', label: 'Remembering', status: 'done' });
  appendRow(bot, 'message', { type: 'message', role: 'assistant', text: 'Same  question?' });
  await sentTo(phone, /Same\s+question\?/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ib.sent.filter((m) => m.conversation_id === conv(phone) && /Same\s+question\?/.test(m.text)).length, 1);
});

const mockReqs = async () => (await (await fetch(`http://localhost:${mockPort}/_requests`)).json()) as any[];
const voiceNote = (phone: string) => text(phone, '', { media: [{ url: `http://localhost:${ibPort}/media/voice.caf`, content_type: 'audio/x-caf' }] });
const mediaSent = (phone: string) => ib.sent.filter((m) => m.conversation_id === conv(phone) && m.media_urls?.length);

test('voice notes: CAF converted and transcribed by OpenRouter; the reply comes back as text and a voice note', async () => {
  const phone = '15550002222';
  ib.sent.length = 0; ib.uploads.length = 0;
  await voiceNote(phone);
  await sentTo(phone, /Heard your voice note/);
  const stt = (await mockReqs()).filter((r) => r.audio === 'stt').at(-1);
  assert.equal(stt.model, 'openai/gpt-4o-mini-transcribe');
  assert.equal(stt.format, 'mp3', 'CAF converted to mp3 before transcription');
  assert.ok(stt.bytes > 1000);
  await waitFor(() => mediaSent(phone).length === 1);
  assert.match(mediaSent(phone)[0].media_urls[0], /^https:\/\/media\.inkbox\.test\//);
  assert.equal(ib.uploads[0].type, 'audio/mpeg');
  const tts = (await mockReqs()).filter((r) => r.audio === 'tts').at(-1);
  assert.equal(tts.voice, 'luna', "the Bot's own voice");
  assert.equal(tts.model, 'x-ai/grok-voice-tts-1.0');
  assert.match(tts.input, /Heard your voice note/);
  // The model saw it was a voice note.
  assert.ok((await mockReqs()).some((r) => JSON.stringify(r.body.input).includes('[via iMessage, voice note]')));

  // A typed message gets text only (default: voice replies only when you send a voice note).
  ib.sent.length = 0;
  await text(phone, 'typed, no voice');
  await sentTo(phone, /typed, no voice/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mediaSent(phone).length, 0);
});

test('/voice on|off|name and speech failures', async () => {
  const phone = '15550002222';
  ib.sent.length = 0;
  await text(phone, '/voice');
  await sentTo(phone, /Voice replies: when you send a voice note/);
  await text(phone, '/voice name eve');
  await sentTo(phone, /Voice set to eve/);
  await text(phone, '/voice on');
  await sentTo(phone, /every reply also comes as a voice note/);
  ib.sent.length = 0;
  await text(phone, 'typed but voice is on');
  await waitFor(() => mediaSent(phone).length === 1);
  assert.equal((await mockReqs()).filter((r) => r.audio === 'tts').at(-1).voice, 'eve');

  // Speech failing still delivers the text.
  ib.sent.length = 0;
  await text(phone, 'mock: say FAILTTS but the text arrives');
  await sentTo(phone, /FAILTTS but the text arrives/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mediaSent(phone).length, 0);

  await text(phone, '/voice off');
  await sentTo(phone, /replies are text only/);
  ib.sent.length = 0;
  await voiceNote(phone);
  await sentTo(phone, /Heard your voice note/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mediaSent(phone).length, 0, 'off: no voice even for a voice note');
  await text(phone, '/voice auto');
  await sentTo(phone, /when you send a voice note, the reply comes as a voice note too/);
});

test('speakable text: links not read out, long replies cut', () => {
  assert.equal(speakable('**Done.** See [the doc](https://x.dev/a).'), "Done. See the doc. I've sent the link in my text.");
  const long = speakable('This is a sentence. '.repeat(100));
  assert.ok(long.length < 960);
  assert.match(long, /The details are in my text\.$/);
});

test('photos reach the model', async () => {
  const phone = '15550002222';
  await text(phone, 'what is this?', { media: [{ url: `http://localhost:${ibPort}/media/photo.png`, content_type: 'image/png' }] });
  const seen = await (async () => {
    for (let i = 0; i < 100; i++) {
      const reqs = await (await fetch(`http://localhost:${mockPort}/_requests`)).json() as any[];
      const hit = reqs.find((q) => JSON.stringify(q.body.input).includes('what is this?'));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  assert.match(JSON.stringify(seen.body.input), /"type":"input_image","image_url":"data:image\/png;base64,/);
});

function approvalFor(userId: string, id: string) {
  const bot = (db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(userId) as any).id;
  const row = appendRow(bot, 'card', { type: 'card', card: 'approval', approvalId: id, title: 'Allow Quinn to send email?', detail: 'to: x@y.com', tool: 'GMAIL_SEND_EMAIL', args: {}, status: 'pending' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, bot, row.seq, `call_${id}`, 'GMAIL_SEND_EMAIL', 'pending', Date.now());
  return { bot, row };
}
const apStatus = (id: string) => (db.prepare('SELECT status FROM approvals WHERE id=?').get(id) as any).status;

test('approval verdict rules (unit)', () => {
  const card = { token: 'K7P2', ref: 'a' } as any;
  assert.equal(parseVerdict('yes please'), 'allow');
  assert.equal(parseVerdict('sure', { strict: true }), undefined);
  assert.equal(matchApprovalReply('yes', [card], { lastPrompted: 'K7P2' })?.verdict, 'allow');
  assert.equal(matchApprovalReply('yes', [card], { lastPrompted: null }), undefined, 'not the last thing sent');
  assert.equal(matchApprovalReply('approve', [card], { lastPrompted: null })?.verdict, 'allow', 'explicit verb');
  assert.equal(matchApprovalReply('sure', [card], { lastPrompted: 'K7P2' }), undefined, 'casual yes needs the token');
  assert.equal(matchApprovalReply('ok k7p2', [card], { lastPrompted: null })?.verdict, 'allow');
  assert.equal(matchApprovalReply('no K7P2', [card], { lastPrompted: null })?.verdict, 'deny');
  assert.equal(matchApprovalReply('yes', [card, { token: 'AB34', ref: 'b' } as any], { lastPrompted: 'K7P2' }), undefined, 'two open: needs the token');
});

test('approvals by text: token, bare yes only when unambiguous, tapbacks', async () => {
  const phone = '15550002222';
  ib.sent.length = 0;
  approvalFor(alice, 'apr_1');
  const card = await sentTo(phone, /needs your OK/);
  const token = card.text.match(/yes ([A-Z0-9]{4})/)![1];
  assert.ok(!/\*\*/.test(card.text));
  await text(phone, 'sure');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(apStatus('apr_1'), 'pending', '"sure" does not approve');
  ib.sent.length = 0;
  approvalFor(alice, 'apr_2');
  await sentTo(phone, /needs your OK/);
  await text(phone, 'yes');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.openApprovals(alice).length, 2);
  assert.equal(apStatus('apr_2'), 'pending', 'two open approvals: a bare yes is ambiguous');
  const card2 = ib.sent.find((m) => /needs your OK/.test(m.text))!;
  const token2 = card2.text.match(/yes ([A-Z0-9]{4})/)![1];
  await text(phone, `yes ${token2}`);
  await waitFor(() => apStatus('apr_2') === 'allowed');
  await sentTo(phone, /✅ Allowed\./);

  // Tapback 👍 on an approval message allows it; a tapback on anything else does nothing.
  ib.sent.length = 0;
  approvalFor(alice, 'apr_3');
  await sentTo(phone, /needs your OK/);
  const cardMsgId = (db.prepare("SELECT wa_id FROM messaging_messages WHERE ref='apr_3' AND kind='approval'").get() as any).wa_id;
  await hook({ id: `evt_rx_${++evN}`, event_type: 'imessage.reaction_received', data: { reaction: { id: `rx_${evN}`, conversation_id: conv(phone), remote_number: `+${phone}`, reaction: 'like', target_message_id: 'im_out_unrelated' } } });
  await inbox.settle();
  assert.equal(apStatus('apr_3'), 'pending');
  await hook({ id: `evt_rx_${++evN}`, event_type: 'imessage.reaction_received', data: { reaction: { id: `rx_${evN}`, conversation_id: conv(phone), remote_number: `+${phone}`, reaction: 'like', target_message_id: cardMsgId } } });
  await inbox.settle();
  await waitFor(() => apStatus('apr_3') === 'allowed');
  // apr_1's own token still works.
  await text(phone, `no ${token}`);
  await waitFor(() => apStatus('apr_1') === 'denied');
});

test('durable inbox: duplicates handled once; pending events replay after a restart', async () => {
  const phone = '15550002222';
  const ev = imessage(phone, 'only once please');
  await hook(ev); await hook(ev);
  await inbox.settle();
  const bot = (db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(alice) as any).id;
  await waitFor(() => listRows(bot).some((r) => (r.body as any).text === 'only once please'));
  assert.equal(listRows(bot).filter((r) => (r.body as any).text === 'only once please').length, 1);
  // A crash between saving and handling leaves it pending; boot replays it.
  const ev2 = imessage(phone, 'saved before a crash');
  db.prepare("INSERT INTO messaging_inbox(id,source,payload,status,next_at,created_at) VALUES (?,?,?,'pending',?,?)").run(`inkbox:${ev2.id}`, 'inkbox', JSON.stringify(ev2), Date.now(), Date.now());
  inbox.resumeInbox();
  await inbox.settle();
  await waitFor(() => listRows(bot).some((r) => (r.body as any).text === 'saved before a crash'));
});

test('/web sign-in link works once and expires; sign-in by text answers the same for unknown numbers', async () => {
  const phone = '15550002222';
  ib.sent.length = 0;
  await text(phone, '/web');
  const msg = await sentTo(phone, /Open your Grokbot in a browser/);
  const link = msg.text.match(/https:\/\/grokbot\.test(\/api\/auth\/text\?t=\S+)/)![1];
  const first = await app.request(link);
  assert.equal(first.status, 302);
  assert.match(first.headers.get('set-cookie') ?? '', /grokbot_session=/);
  const again = await app.request(link);
  assert.match(again.headers.get('location') ?? '', /login=expired/);

  const req = (p: string) => app.request('/api/auth/text/request', { method: 'POST', body: JSON.stringify({ phone: p }), headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' } });
  ib.sent.length = 0;
  const known = await (await req('+1 555 000 2222')).json();
  const unknown = await (await req('+1 555 000 9999')).json();
  assert.deepEqual(known, unknown);
  await sentTo(phone, /Sign in to Grokbot/);
  assert.equal(ib.sent.length, 1);
});

test('LINK <code> attaches a phone to an existing web account', async () => {
  const web = createAccount({ email: 'web@example.com', name: 'Webby' }).id;
  const r = await app.request('/api/messaging/code', { method: 'POST', headers: { cookie: cookieFor(web) } });
  const { code } = await r.json() as any;
  await text('15550007777', `LINK ${code}`);
  await sentTo('15550007777', /Connected/);
  assert.equal(store.getLink(web, 'imessage')!.phone, '15550007777');
  assert.equal(getAccount(web)!.phone, '15550007777');
});

test('update_profile closes onboarding; /invite; /me; daily cap', async () => {
  const bot = (db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').get(alice) as any).id;
  const ctx = { userId: alice, botId: bot, depth: 0, enqueueBotMessage: () => {} };
  assert.match((await toolMap.get('update_profile')!.impl({ timezone: 'Mars/Base' }, ctx)).output as string, /not a valid IANA/);
  await toolMap.get('update_profile')!.impl({ name: 'Alice', timezone: 'Europe/Lisbon', onboarding_complete: true }, ctx);
  const acct = getAccount(alice)!;
  assert.equal(acct.name, 'Alice');
  assert.equal(acct.timezone, 'Europe/Lisbon');
  assert.ok(acct.onboardedAt);
  assert.doesNotMatch(await systemPrompt(alice, bot), /## Onboarding/);

  const phone = '15550002222';
  ib.sent.length = 0;
  await text(phone, '/invite');
  const inv = await sentTo(phone, /Your invite link \(5 left\)/);
  assert.match(inv.text, /https:\/\/grokbot\.test\/join\/[A-Z0-9]{8}/);
  await text(phone, '/me');
  await sentTo(phone, /Alice\nPhone: \+15550002222/);

  saveSetting('messaging_daily_messages', '1', owner);
  await text(phone, 'one more thing');
  await sentTo(phone, /today's limit of 1 messages/);
  clearSetting('messaging_daily_messages');
});

test('/delete confirm removes the account and everything in it', async () => {
  const phone = '15550005555';
  const u = (db.prepare('SELECT id FROM users WHERE phone=?').get(phone) as any).id;
  await text(phone, '/delete confirm');
  await sentTo(phone, /Send \/delete first/);
  await text(phone, '/delete');
  await sentTo(phone, /This deletes your Grokbot account/);
  await text(phone, '/delete confirm');
  await waitFor(() => !db.prepare('SELECT 1 FROM users WHERE id=?').get(u));
  assert.equal((db.prepare('SELECT count(*) n FROM bots WHERE user_id=?').get(u) as any).n, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM messaging_links WHERE user_id=?').get(u) as any).n, 0);
});

test('plain-text formatting', () => {
  assert.equal(toPlainText('# Plan\n**Bold** and *it* and [site](https://x.dev)\n* item\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Plan\nBold and it and site (https://x.dev)\n- item\na · b\n- 1 · 2');
});

// ---------- continue with phone number ----------

const post = (path: string, body: unknown, cookie?: string) => app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++evN % 250}`, ...(cookie ? { cookie } : {}) } });
const codeIn = (t: string) => t.match(/is (\d{6})\./)![1];

test('phone sign-up: a new number gets its code by replying to the line, then the account is created and connected', async () => {
  const phone = '15550008888';
  const start = await (await post('/api/auth/phone/start', { phone: '+1 555 000 8888' })).json() as any;
  assert.ok(start.id);
  assert.equal(start.line.connectCommand, 'connect @grokbot');
  // Not connected yet: nothing is texted until they write.
  await text(phone, 'hi');
  const msg = await sentTo(phone, /Grokbot sign-in code is \d{6}/);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone), undefined, 'texting for a code creates nothing yet');
  assert.equal(signup.listWaitlist().find((w) => w.phone === phone), undefined, 'and does not join the waitlist');

  assert.equal((await post('/api/auth/phone/verify', { id: start.id, code: '000000' })).status, 400);
  const gated = await post('/api/auth/phone/verify', { id: start.id, code: codeIn(msg.text) });
  assert.equal(gated.status, 403);
  assert.equal(((await gated.json()) as any).needInvite, true, 'invite-only server');
  const inv = signup.createInvite(owner, { maxUses: 1 });
  const ok = await post('/api/auth/phone/verify', { id: start.id, code: codeIn(msg.text), inviteCode: inv.code });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).created, true);
  assert.match(ok.headers.get('set-cookie') ?? '', /grokbot_session=/);
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone) as any;
  assert.equal(u.signup_source, 'text');
  assert.equal(store.getLink(u.id, 'imessage')!.chatRef, conv(phone), 'the number is connected');
  await sentTo(phone, /I'm Quinn, your Grokbot/);
  assert.equal((await post('/api/auth/phone/verify', { id: start.id, code: codeIn(msg.text) })).status, 410, 'a code works once');
});

test('phone sign-in: a connected number gets its code texted right away', async () => {
  ib.sent.length = 0;
  const start = await (await post('/api/auth/phone/start', { phone: '+15550002222' })).json() as any;
  const msg = await sentTo('15550002222', /sign-in code is \d{6}/);
  for (let i = 0; i < 5; i++) await post('/api/auth/phone/verify', { id: start.id, code: '111111' });
  assert.equal((await post('/api/auth/phone/verify', { id: start.id, code: codeIn(msg.text) })).status, 429, 'five wrong codes lock it');
  const again = await (await post('/api/auth/phone/start', { phone: '+15550002222' })).json() as any;
  const msg2 = await sentTo('15550002222', new RegExp(`sign-in code is (?!${codeIn(msg.text)})\\d{6}`));
  const r = await post('/api/auth/phone/verify', { id: again.id, code: codeIn(msg2.text) });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).created, false);
});

test('connect a phone to a signed-in account; a number with its own account is refused', async () => {
  const web = createAccount({ email: 'attach@example.com', name: 'Attach' }).id;
  const cookie = cookieFor(web);
  const conflict = await (await post('/api/messaging/phone/start', { phone: '+15550002222' }, cookie)).json() as any;
  const m = await sentTo('15550002222', /code to connect this number is \d{6}/);
  const no = await post('/api/messaging/phone/verify', { id: conflict.id, code: codeIn(m.text) }, cookie);
  assert.equal(no.status, 409);

  const start = await (await post('/api/messaging/phone/start', { phone: '+15550009999' }, cookie)).json() as any;
  await text('15550009999', 'connect @grokbot');
  const msg = await sentTo('15550009999', /code to connect this number is \d{6}/);
  const ok = await post('/api/messaging/phone/verify', { id: start.id, code: codeIn(msg.text) }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(getAccount(web)!.phone, '15550009999');
  assert.equal(store.getLink(web, 'imessage')!.chatRef, conv('15550009999'));
  await sentTo('15550009999', /Connected/);
});

test('the code goes out as soon as Inkbox shows the number connected', async () => {
  const phone = '15550007070';
  ib.sent.length = 0;
  const start = await (await post('/api/auth/phone/start', { phone: `+${phone}` })).json() as any;
  assert.ok(start.id);
  ib.assignments.push(phone); // they texted "connect @grokbot"
  const msg = await waitFor(() => ib.sent.find((m) => m.to === `+${phone}` && /sign-in code is \d{6}/.test(m.text)), 12_000);
  assert.ok(msg);
});

test('line setup resumes after a failed step and never recreates the identity', async () => {
  for (const k of ['INKBOX_IDENTITY_ID', 'INKBOX_API_KEY', 'INKBOX_SIGNING_KEY']) delete process.env[k];
  ib.failKeyOnce = true;
  const first = await setupLine(owner, { handle: 'my-line' });
  assert.equal(first.step, 'key');
  assert.match(first.error!, /boom/);
  const second = await setupLine(owner);
  assert.equal(second.step, 'done', second.error);
  assert.equal(ib.identities, 1);
  assert.equal(ib.keys, 1);
  assert.equal(ib.signing, 1);
  assert.equal(ib.subs.length, 1);
  assert.equal(ib.subs[0].url, 'https://grokbot.test/api/messaging/inkbox/webhook');
  assert.deepEqual(ib.subs[0].event_types, ['imessage.received', 'imessage.reaction_received', 'text.received']);
  // A signing key exists on Inkbox that this server doesn't hold: never replace it silently.
  clearSetting('inkbox_signing_key');
  ib.signingConfigured = true;
  const third = await setupLine(owner);
  assert.equal(third.step, 'signing');
  assert.equal(ib.signing, 1);
});
