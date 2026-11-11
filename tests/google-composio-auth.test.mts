import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-google-composio-'));
// No Google OAuth client: sign-in uses a Composio-managed Gmail authorization.
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-google-composio', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test' });
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
const { db, now } = await import('../server/src/db.js');
const { composio } = await import('../server/src/composio.js');
const client = composio() as any;

/** Simulated Composio: connected account id -> owner, status and the Gmail mailbox Google reports. */
const accounts = new Map<string, { userId: string; status: string; mailbox: string; reason?: string }>();
let nextMailbox = 'person@example.test';
let seq = 0;
const deleted: string[] = [];
mock.method(client, 'create', async (userId: string, options: any) => {
  assert.equal(options.manageConnections, false);
  return { authorize: async (toolkit: string, input: any) => {
    assert.equal(toolkit, 'gmail');
    assert.match(input.callbackUrl, /^https:\/\/swarm\.test\/api\/auth\/google\/callback\?state=/);
    const id = `ca_${++seq}`;
    accounts.set(id, { userId, status: 'ACTIVE', mailbox: nextMailbox });
    return { id, redirectUrl: `https://connect.composio.dev/link/${id}` };
  } };
});
mock.method(client.connectedAccounts, 'get', async (id: string) => {
  const a = accounts.get(id);
  if (!a) throw new Error('not found');
  return { id, status: a.status, statusReason: a.reason ?? null, toolkit: { slug: 'gmail' } };
});
mock.method(client.connectedAccounts, 'list', async (input: any) => ({
  items: [...accounts].filter(([, a]) => input.userIds.includes(a.userId) && a.status === 'ACTIVE').map(([id, a]) => ({ id, status: a.status, toolkit: { slug: 'gmail' }, isDisabled: false })),
  nextCursor: null,
}));
mock.method(client.connectedAccounts, 'delete', async (id: string) => { deleted.push(id); accounts.delete(id); });
mock.method(client.tools, 'proxyExecute', async (input: any) => {
  const a = accounts.get(input.connectedAccountId);
  assert.ok(a && a.userId === input.userId, 'profile is read only through the authorizing user');
  return { status: 200, data: { emailAddress: a.mailbox } };
});

const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const sessionCookie = (r: Response) => r.headers.getSetCookie().find(v => v.startsWith('swarm_session='))?.split(';')[0];
async function begin(mailbox: string, extraCookie = '', query = '') {
  nextMailbox = mailbox;
  const r = await app.request(`/api/auth/google/start${query}`, { headers: { cookie: extraCookie } });
  const location = new URL(r.headers.get('location')!);
  assert.equal(location.hostname, 'connect.composio.dev', `started: ${location}`);
  const account = location.pathname.split('/').pop()!;
  const attempt = r.headers.getSetCookie().find(v => v.startsWith('swarm_google_attempt='))!.split(';')[0];
  const state = attempt.split('=')[1];
  return { account, state, cookie: extraCookie ? `${extraCookie}; ${attempt}` : attempt, path: `/api/auth/google/callback?state=${state}&status=success&connected_account_id=${account}` };
}
const finish = (a: { path: string; cookie: string }, path = a.path) => app.request(path, { headers: { cookie: a.cookie } });
const me = async (cookie?: string) => await (await app.request('/api/auth/me', { headers: { cookie: cookie ?? '' } })).json() as any;
const bindings = () => db.prepare('SELECT subject,user_id FROM google_identities ORDER BY subject').all() as { subject: string; user_id: string }[];
function addUser(id: string, email: string, phone?: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at,phone) VALUES (?,?,?,?,?)').run(id, email, id, now(), phone ?? null);
}

test('Google sign-in is offered through Composio when no Google OAuth client exists', async () => {
  const anonymous = await me();
  assert.equal(anonymous.googleLogin, true);
  assert.equal(anonymous.googleLinked, false);
});

test('a new mailbox creates one account bound to the verified mailbox; replay and repeat sign-in are safe', async () => {
  const a = await begin('person@example.test');
  const r = await finish(a);
  assert.equal(r.headers.get('location'), 'https://swarm.test/');
  const cookie = sessionCookie(r)!;
  const profile = await me(cookie);
  assert.equal(profile.user.email, 'person@example.test');
  assert.equal(profile.googleLinked, true);
  assert.deepEqual(bindings().map(b => b.subject), ['gmail-mailbox:person@example.test']);
  assert.equal(profile.user.id, accounts.get(a.account)?.userId, 'the sign-in Gmail authorization becomes the new account\'s own connection');
  assert.match((await finish(a)).headers.get('location')!, /google_session/, 'an attempt is single use');
  const again = await begin('person@example.test');
  const second = await finish(again);
  assert.equal((await me(sessionCookie(second)!)).user.id, profile.user.id);
  assert.ok(deleted.includes(again.account), 'a repeat sign-in removes its throwaway authorization');
  assert.equal(bindings().length, 1);
});

test('a planted, unverified account email never captures the mailbox owner\'s Google sign-in', async () => {
  addUser('usr_mallory', 'victim@example.test', '15550001111');
  const a = await begin('victim@example.test');
  const r = await finish(a);
  assert.match(r.headers.get('location')!, /google_link_required/);
  assert.equal(sessionCookie(r), undefined);
  assert.equal(bindings().some(b => b.user_id === 'usr_mallory'), false);
  assert.ok(deleted.includes(a.account));
});

test('an earlier Google account is adopted only with its own active authorization for the same mailbox', async () => {
  addUser('usr_legacy', 'legacy@example.test');
  accounts.set('ca_legacy_old', { userId: 'usr_legacy', status: 'ACTIVE', mailbox: 'legacy@example.test' });
  const r = await finish(await begin('legacy@example.test'));
  assert.equal((await me(sessionCookie(r)!)).user.id, 'usr_legacy');
  assert.ok(bindings().some(b => b.subject === 'gmail-mailbox:legacy@example.test' && b.user_id === 'usr_legacy'));

  addUser('usr_other_mailbox', 'claimed@example.test');
  accounts.set('ca_other_mailbox', { userId: 'usr_other_mailbox', status: 'ACTIVE', mailbox: 'different@example.test' });
  const refused = await finish(await begin('claimed@example.test'));
  assert.match(refused.headers.get('location')!, /google_link_required/);
  assert.equal(bindings().some(b => b.user_id === 'usr_other_mailbox'), false);
});

test('a recently signed-in user can connect Google to the same account, then sign in with it', async () => {
  addUser('usr_phone', 'tel+15550002222@phone.invalid', '15550002222');
  const raw = 'phone-session-token';
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (session_hash(?),?,?,?,?,?)').run(raw, 'usr_phone', now(), now() + 3600_000, now(), now());
  const link = await begin('phone.owner@example.test', `swarm_session=${raw}`, '?intent=link');
  const r = await finish(link);
  assert.equal(r.headers.get('location'), 'https://swarm.test/');
  assert.ok(bindings().some(b => b.subject === 'gmail-mailbox:phone.owner@example.test' && b.user_id === 'usr_phone'));
  const later = await finish(await begin('phone.owner@example.test'));
  assert.equal((await me(sessionCookie(later)!)).user.id, 'usr_phone');

  const stale = 'stale-session-token';
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (session_hash(?),?,?,?,?,?)').run(stale, 'usr_phone', now(), now() + 3600_000, now(), now() - 60 * 60_000);
  const refused = await app.request('/api/auth/google/start?intent=link', { headers: { cookie: `swarm_session=${stale}` } });
  assert.match(refused.headers.get('location')!, /google_link_required/, 'linking requires a recent sign-in');
});

test('denied, unfinished, substituted and foreign-browser callbacks fail closed', async () => {
  const before = bindings().length;
  const denied = await begin('denied@example.test');
  assert.match((await finish(denied, denied.path.replace('status=success', 'status=failed'))).headers.get('location')!, /google_denied/);
  const pending = await begin('pending@example.test');
  accounts.get(pending.account)!.status = 'INITIATED';
  assert.match((await finish(pending)).headers.get('location')!, /google_pending/);
  const swapped = await begin('swapped@example.test');
  assert.match((await finish(swapped, swapped.path.replace(`connected_account_id=${swapped.account}`, 'connected_account_id=ca_someone_else'))).headers.get('location')!, /google_session/);
  const foreign = await begin('foreign@example.test');
  assert.match((await app.request(foreign.path)).headers.get('location')!, /google_session/, 'the attempt cookie binds the browser');
  const expired = await begin('expired@example.test');
  db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now() - 1, expired.state);
  assert.match((await finish(expired)).headers.get('location')!, /google_session/);
  assert.equal(bindings().length, before);
});
