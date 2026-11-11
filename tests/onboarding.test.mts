// One text to join: Swarm greets people as soon as they text "connect @<handle>" (Inkbox sends no event for that,
// so the server watches Inkbox's connection list). Real agent turns against the mock model and a fake Inkbox.
//   node --import tsx --test --test-concurrency=1 tests/onboarding.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-onboarding-'));
const free = () => new Promise<number>((r) => { const s = http.createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const mockPort = await free();
const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-provider.mjs'), String(mockPort)], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`http://localhost:${mockPort}/_requests`).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

// Fake Inkbox: connections ("assignments") with their connect time, and sends.
const ib = { connected: new Map<string, number>(), reactions: [] as any[], refuseFirst: new Set<string>(), sent: [] as any[] };
const inkbox = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const json = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const p = (req.url ?? '').replace(/^\/api\/v1/, '');
    const body = raw ? JSON.parse(raw) : {};
    if (p === '/imessage/messages' && req.method === 'POST') {
      if (body.to && ib.refuseFirst.has(String(body.to).replace(/\D/g, ''))) return json(409, { detail: { error: 'imessage_awaiting_inbound' } });
      ib.sent.push(body);
      return json(200, { message: { id: `im_out_${ib.sent.length}`, conversation_id: body.conversation_id ?? null, service: 'imessage' } });
    }
    if (p === '/imessage/reactions' && req.method === 'POST') {
      ib.reactions.push(body);
      return json(200, { id: `rxn_${ib.reactions.length}`, ...body });
    }
    if (p === '/imessage/typing' || p === '/imessage/mark-read') return json(200, {});
    if (p.startsWith('/imessage/assignments')) {
      return json(200, [...ib.connected].map(([n, at]) => ({ id: `as_${n}`, remote_number: `+${n}`, status: 'active', created_at: new Date(at).toISOString() })));
    }
    if (p === '/imessage/triage-number') return json(200, { number: '+14155550199' });
    json(404, { detail: 'not mocked' });
  });
});
const ibPort = await free();
await new Promise<void>((r) => inkbox.listen(ibPort, r));

Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://localhost:${mockPort}/api/v1`, XAI_API_KEY: '', LLM_PROVIDER: 'openrouter',
  INKBOX_BASE_URL: `http://localhost:${ibPort}`, INKBOX_ADMIN_API_KEY: 'admin', INKBOX_API_KEY: 'idkey', INKBOX_SIGNING_KEY: 'whsec_test', INKBOX_IDENTITY_ID: 'idn_1', INKBOX_HANDLE: 'swarm-team',
  SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createAccount } = await import('../server/src/accounts.js');
const { registerAdapter, startBridge } = await import('../server/src/messaging/bridge.js');
const { inkboxAdapter, inkboxWebhook, lineInfo } = await import('../server/src/messaging/inkbox/adapter.js');
const inbox = await import('../server/src/messaging/inbox.js');
const signup = await import('../server/src/messaging/signup.js');
const { checkConnections, greetConnection } = await import('../server/src/messaging/connections.js');
const { saveSetting } = await import('../server/src/settings.js');
registerAdapter(inkboxAdapter);
startBridge();

after(async () => { await inbox.settle(); await (await import('../server/src/agent/loop.js')).settleAgentJobs(); for (const u of db.prepare('SELECT id FROM users').all() as any[]) await (await import('../server/src/messaging/bridge.js')).drain(u.id); mock.kill(); inkbox.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
async function textIn(phone: string, text: string) {
  const ev = { id: `evt_${++n}`, event_type: 'imessage.received', timestamp: new Date().toISOString(), data: { message: { id: `im_in_${n}`, conversation_id: `conv_${phone}`, remote_number: `+${phone}`, content: text, is_group: false } } };
  const raw = JSON.stringify(ev);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${crypto.createHmac('sha256', 'test').update(`r${n}.${ts}.${raw}`).digest('hex')}`;
  const r = await inkboxWebhook.request('/', { method: 'POST', body: raw, headers: { 'x-inkbox-request-id': `r${n}`, 'x-inkbox-timestamp': ts, 'x-inkbox-signature': sig } });
  assert.equal(r.status, 204);
  await inbox.settle();
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); }
}
const sentTo = (phone: string) => ib.sent.filter((m) => m.to === `+${phone}` || m.conversation_id === `conv_${phone}`);
const userFor = (phone: string) => db.prepare('SELECT * FROM users WHERE phone=?').get(phone) as any;
const connect = (phone: string, agoMs = 0) => ib.connected.set(phone, Date.now() - agoMs);

const owner = createAccount({ email: 'owner@example.com', name: 'Owner' }).id;

test('the public connect command is connect @swarm', async () => {
  const line = await lineInfo();
  assert.equal(line?.connectCommand, 'connect @swarm');
  assert.match(line?.smsLink ?? '', /body=connect%20%40swarm$/);
});

test('a claimed invite: "connect" alone creates the account, welcomes them and starts onboarding', async () => {
  const inv = signup.createInvite(owner, { maxUses: 1 });
  assert.equal(signup.claimInvite(inv.code, '+1 555 100 0001', '1.1.1.1').ok, true);
  connect('15551000001');
  await checkConnections();
  const u = await waitFor(() => userFor('15551000001'));
  assert.equal(u.invited_by, owner);
  const welcome = sentTo('15551000001')[0];
  assert.equal(welcome.to, '+15551000001', 'first text goes to the number (no conversation yet)');
  assert.match(welcome.text, /^Hi! 👋 I'm Quinn, your Swarm/);
  // Quinn's onboarding turn follows, and there's exactly one welcome.
  await waitFor(() => sentTo('15551000001').some((m) => /onboarding\] A new user just joined/.test(m.text)));
  assert.equal(sentTo('15551000001').filter((m) => /I'm Quinn, your Swarm/.test(m.text)).length, 1);
  assert.equal(signup.listInvites().find((i) => i.code === inv.code)!.uses, 1);
  // A second pass doesn't greet again.
  await checkConnections();
  assert.equal(sentTo('15551000001').filter((m) => /I'm Quinn, your Swarm/.test(m.text)).length, 1);
  // Their reply lands in the same account (and fills in the conversation id).
  await textIn('15551000001', 'hello again');
  await waitFor(() => sentTo('15551000001').some((m) => m.conversation_id === 'conv_15551000001'));
});

test('invite-only, no invite: they are told how to get in; JOIN <code> then works', async () => {
  connect('15551000002');
  await checkConnections();
  await waitFor(() => sentTo('15551000002').some((m) => /invite-only for now\. Reply with your invite code/.test(m.text)));
  assert.equal(userFor('15551000002'), undefined);
  const inv = signup.createInvite(owner, { maxUses: 1 });
  await textIn('15551000002', `JOIN ${inv.code}`);
  await waitFor(() => userFor('15551000002'));
});

test('open sign-up: any new connection becomes an account right away', async () => {
  saveSetting('messaging_signup_mode', 'open', owner);
  try {
    connect('15551000003');
    await checkConnections();
    await waitFor(() => userFor('15551000003'));
  } finally { saveSetting('messaging_signup_mode', 'invite', owner); }
});

test('if Inkbox will not let the line text first, nothing is created until they write', async () => {
  saveSetting('messaging_signup_mode', 'open', owner);
  try {
    ib.refuseFirst.add('15551000004');
    connect('15551000004');
    await checkConnections();
    assert.equal(userFor('15551000004'), undefined);
    assert.equal(sentTo('15551000004').length, 0);
    await textIn('15551000004', 'hi');
    await waitFor(() => userFor('15551000004'));
    await waitFor(() => sentTo('15551000004').some((m) => /I'm Quinn, your Swarm/.test(m.text)));
  } finally { saveSetting('messaging_signup_mode', 'invite', owner); }
});

test('old connections (before a restart or deploy) and existing members are not greeted', async () => {
  connect('15551000005', 2 * 3600_000);
  await checkConnections();
  assert.equal(sentTo('15551000005').length, 0);
  assert.equal(await greetConnection('15551000001'), 'already');
});
