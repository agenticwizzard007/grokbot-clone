import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-google-composio-'));
// No Google OAuth client: sign-in uses a Composio-managed Gmail authorization.
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-google-composio', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test' });
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
mock.method(globalThis, 'fetch', async input => {
  const host = new URL(String(input)).hostname;
  if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (host === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Auth fixtures forbid external provider requests');
});
const { db, now } = await import('../server/src/db.js');
const { composio } = await import('../server/src/composio.js');
const client = composio() as any;

/** Simulated Composio + Google: connected account -> Composio user, status and the Google principal behind the token. */
interface Principal { sub: string; email: string; verified?: boolean }
const accounts = new Map<string, { userId: string; status: string; principal: Principal; reason?: string }>();
let nextPrincipal: Principal = { sub: '1000', email: 'person@example.test' };
let seq = 0;
let failAuthorize = false;
let authorizeHook: (() => Promise<void>) | undefined;
let listHook: ((input: any) => Promise<void>) | undefined;
let proxyHook: ((input: any) => Promise<void>) | undefined;
let deleteHook: ((id: string) => Promise<void>) | undefined;
mock.method(client, 'create', async (userId: string, options: any) => {
  assert.equal(options.manageConnections, false);
  return { authorize: async (toolkit: string, input: any) => {
    assert.equal(toolkit, 'gmail');
    assert.match(input.callbackUrl, /^https:\/\/swarm\.test\/api\/auth\/google\/callback\?state=/);
    const id = `ca_${++seq}`;
    await authorizeHook?.();
    accounts.set(id, { userId, status: 'ACTIVE', principal: { ...nextPrincipal } });
    if (failAuthorize) throw new Error('link creation response lost');
    return { id, redirectUrl: `https://connect.composio.dev/link/${id}` };
  } };
});
mock.method(client.connectedAccounts, 'get', async (id: string) => {
  const a = accounts.get(id);
  if (!a) throw new Error('not found');
  return { id, status: a.status, statusReason: a.reason ?? null, toolkit: { slug: 'gmail' } };
});
mock.method(client.connectedAccounts, 'list', async (input: any) => {
  const result = {
    items: [...accounts].filter(([, a]) => input.userIds.includes(a.userId)).map(([id, a]) => ({ id, status: a.status, toolkit: { slug: 'gmail' }, isDisabled: false })),
    nextCursor: null,
  };
  await listHook?.(input);
  return result;
});
mock.method(client.connectedAccounts, 'delete', async (id: string) => { await deleteHook?.(id); accounts.delete(id); });
mock.method(client.tools, 'proxyExecute', async (input: any) => {
  const a = accounts.get(input.connectedAccountId);
  assert.ok(a && a.userId === input.userId, 'identity is read only through the authorizing Composio user');
  assert.equal(input.endpoint, 'https://openidconnect.googleapis.com/v1/userinfo');
  await proxyHook?.(input);
  return { status: 200, data: { sub: a.principal.sub, email: a.principal.email, email_verified: a.principal.verified ?? true, name: 'Person' } };
});

const { api } = await import('../server/src/routes.js');
const { sweepGoogleLoginAuthorizations } = await import('../server/src/auth/google.js');
const app = new Hono().route('/api', api);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const sessionCookie = (r: Response) => r.headers.getSetCookie().find(v => v.startsWith('swarm_session='))?.split(';')[0];
async function begin(principal: Principal, extraCookie = '', query = '') {
  nextPrincipal = principal;
  const r = await app.request(`/api/auth/google/start${query}`, { headers: { cookie: extraCookie } });
  const location = new URL(r.headers.get('location')!);
  assert.equal(location.hostname, 'connect.composio.dev', `started: ${location}`);
  const account = location.pathname.split('/').pop()!;
  const attempt = r.headers.getSetCookie().find(v => v.startsWith('swarm_google_attempt='))!.split(';')[0];
  const state = attempt.split('=')[1];
  return { account, state, provisional: accounts.get(account)!.userId, cookie: extraCookie ? `${extraCookie}; ${attempt}` : attempt, path: `/api/auth/google/callback?state=${state}&status=success&connected_account_id=${account}` };
}
const finish = (a: { path: string; cookie: string }, path = a.path) => app.request(path, { headers: { cookie: a.cookie } });
const me = async (cookie?: string) => await (await app.request('/api/auth/me', { headers: { cookie: cookie ?? '' } })).json() as any;
const boundTo = (sub: string) => (db.prepare('SELECT user_id FROM google_identities WHERE subject=?').get(sub) as { user_id: string } | undefined)?.user_id;
const authorizationsOf = (userId: string) => [...accounts.values()].filter(a => a.userId === userId).length;
const cleanupRows = () => (db.prepare("SELECT count(*) n FROM google_oidc_attempts WHERE nonce IN ('composio-cleanup','composio-cleaning')").get() as { n: number }).n;
function addUser(id: string, email: string, phone?: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at,phone) VALUES (?,?,?,?,?)').run(id, email, id, now(), phone ?? null);
}
function addSession(raw: string, userId: string, authenticatedAgo = 0) {
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (session_hash(?),?,?,?,?,?)').run(raw, userId, now(), now() + 3600_000, now(), now() - authenticatedAgo);
}

test('Google sign-in is offered through Composio when no Google OAuth client exists', async () => {
  const anonymous = await me();
  assert.equal(anonymous.googleLogin, true);
  assert.equal(anonymous.googleLinked, false);
});

test('a new Google subject creates one account, keeps its authorization, and is single use; a repeat sign-in removes its own', async () => {
  const a = await begin({ sub: '1000', email: 'person@example.test' });
  const r = await finish(a);
  assert.equal(r.headers.get('location'), 'https://swarm.test/');
  const profile = await me(sessionCookie(r)!);
  assert.equal(profile.user.email, 'person@example.test');
  assert.equal(profile.googleLinked, true);
  assert.equal(boundTo('1000'), profile.user.id);
  assert.equal(profile.user.id, a.provisional, 'the sign-in authorization becomes the new account\'s own Gmail connection');
  assert.equal(authorizationsOf(a.provisional), 1);
  assert.match((await finish(a)).headers.get('location')!, /google_session/, 'an attempt is single use');
  const again = await begin({ sub: '1000', email: 'person@example.test' });
  assert.equal((await me(sessionCookie(await finish(again))!)).user.id, profile.user.id);
  assert.equal(authorizationsOf(again.provisional), 0, 'a repeat sign-in removes its throwaway authorization');
  assert.equal(cleanupRows(), 0);
});

test('a reassigned address never opens the original account; the original subject keeps its account after an address change', async () => {
  const original = await finish(await begin({ sub: '2001', email: 'reusable@workspace.example' }));
  const ownerId = (await me(sessionCookie(original)!)).user.id;
  // Google Workspace renames principal 2001 and gives the old address to principal 2002.
  const replacement = await begin({ sub: '2002', email: 'reusable@workspace.example' });
  const refused = await finish(replacement);
  assert.match(refused.headers.get('location')!, /google_link_required/);
  assert.equal(sessionCookie(refused), undefined);
  assert.equal(boundTo('2002'), undefined);
  assert.equal(authorizationsOf(replacement.provisional), 0);
  const renamed = await finish(await begin({ sub: '2001', email: 'renamed@workspace.example' }));
  assert.equal((await me(sessionCookie(renamed)!)).user.id, ownerId);
});

test('a planted, unverified account email never captures the mailbox owner\'s Google sign-in', async () => {
  addUser('usr_mallory', 'victim@example.test', '15550001111');
  const a = await begin({ sub: '3001', email: 'victim@example.test' });
  const r = await finish(a);
  assert.match(r.headers.get('location')!, /google_link_required/);
  assert.equal(sessionCookie(r), undefined);
  assert.equal(boundTo('3001'), undefined);
  assert.equal(authorizationsOf(a.provisional), 0);
});

test('an earlier Google account is adopted only with its own active authorization for the same Google subject', async () => {
  addUser('usr_legacy', 'legacy@example.test');
  accounts.set('ca_legacy_old', { userId: 'usr_legacy', status: 'ACTIVE', principal: { sub: '4001', email: 'legacy@example.test' } });
  const adopt = await begin({ sub: '4001', email: 'legacy@example.test' });
  assert.equal((await me(sessionCookie(await finish(adopt))!)).user.id, 'usr_legacy');
  assert.equal(boundTo('4001'), 'usr_legacy');
  assert.equal(authorizationsOf(adopt.provisional), 0);
  assert.equal(authorizationsOf('usr_legacy'), 1, 'the adopted account keeps its own Gmail connection');

  // Same address, different Google principal: the account's own authorization proves a different subject.
  addUser('usr_reassigned', 'shared@example.test');
  accounts.set('ca_reassigned_old', { userId: 'usr_reassigned', status: 'ACTIVE', principal: { sub: '4002', email: 'shared@example.test' } });
  const refused = await finish(await begin({ sub: '4003', email: 'shared@example.test' }));
  assert.match(refused.headers.get('location')!, /google_link_required/);
  assert.equal(boundTo('4003'), undefined);
});

test('a recently signed-in user can connect Google, then sign in with it; linking follows the same subject rule', async () => {
  addUser('usr_phone', 'tel+15550002222@phone.invalid', '15550002222');
  addSession('phone-session', 'usr_phone');
  const link = await begin({ sub: '5001', email: 'phone.owner@example.test' }, 'swarm_session=phone-session', '?intent=link');
  assert.equal((await finish(link)).headers.get('location'), 'https://swarm.test/');
  assert.equal(boundTo('5001'), 'usr_phone');
  assert.equal(authorizationsOf(link.provisional), 0, 'a linking authorization is removed');
  const later = await finish(await begin({ sub: '5001', email: 'phone.owner@example.test' }));
  assert.equal((await me(sessionCookie(later)!)).user.id, 'usr_phone');

  addUser('usr_phone2', 'tel+15550003333@phone.invalid', '15550003333');
  addSession('phone2-session', 'usr_phone2');
  const taken = await begin({ sub: '5001', email: 'phone.owner@example.test' }, 'swarm_session=phone2-session', '?intent=link');
  assert.match((await finish(taken)).headers.get('location')!, /google_already_linked/, 'a subject bound elsewhere cannot be linked again');
  assert.equal(authorizationsOf(taken.provisional), 0);

  addSession('stale-session', 'usr_phone2', 60 * 60_000);
  const stale = await app.request('/api/auth/google/start?intent=link', { headers: { cookie: 'swarm_session=stale-session' } });
  assert.match(stale.headers.get('location')!, /google_link_required/, 'linking requires a recent sign-in');
});

test('every terminal failure removes the exact throwaway authorization; foreign state cannot delete it', async () => {
  const denied = await begin({ sub: '6001', email: 'denied@example.test' });
  assert.match((await finish(denied, denied.path.replace('status=success', 'status=failed'))).headers.get('location')!, /google_denied/);
  assert.equal(authorizationsOf(denied.provisional), 0);

  const pending = await begin({ sub: '6002', email: 'pending@example.test' });
  accounts.get(pending.account)!.status = 'INITIATED';
  assert.match((await finish(pending)).headers.get('location')!, /google_pending/);
  assert.equal(authorizationsOf(pending.provisional), 0);

  const unverified = await begin({ sub: '6003', email: 'unverified@example.test', verified: false });
  assert.match((await finish(unverified)).headers.get('location')!, /google_permissions/);
  assert.equal(authorizationsOf(unverified.provisional), 0);

  addUser('usr_victim', 'victim2@example.test');
  accounts.set('ca_victim', { userId: 'usr_victim', status: 'ACTIVE', principal: { sub: '6999', email: 'victim2@example.test' } });
  const swapped = await begin({ sub: '6004', email: 'swapped@example.test' });
  assert.match((await finish(swapped, swapped.path.replace(`connected_account_id=${swapped.account}`, 'connected_account_id=ca_victim'))).headers.get('location')!, /google_session/);
  assert.equal(authorizationsOf(swapped.provisional), 0, 'the sealed authorization is removed');
  assert.ok(accounts.has('ca_victim'), 'a substituted callback id is never deleted');

  const foreign = await begin({ sub: '6005', email: 'foreign@example.test' });
  assert.match((await app.request(foreign.path)).headers.get('location')!, /google_session/, 'the attempt cookie binds the browser');
  assert.equal(authorizationsOf(foreign.provisional), 1, 'a foreign browser cannot consume or delete the attempt');
  assert.equal((await finish(foreign)).headers.get('location'), 'https://swarm.test/', 'the owner can still finish it');
});

test('expired, session-revoked and failed-start attempts are swept from the durable cleanup record', async () => {
  const expired = await begin({ sub: '7001', email: 'expired@example.test' });
  db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now() - 1, expired.state);
  assert.match((await finish(expired)).headers.get('location')!, /google_session/);
  addUser('usr_revoked', 'revoked@example.test');
  addSession('revoked-session', 'usr_revoked');
  const revoked = await begin({ sub: '7002', email: 'revoked@example.test' }, 'swarm_session=revoked-session', '?intent=link');
  db.prepare('DELETE FROM auth_sessions WHERE token=session_hash(?)').run('revoked-session');
  assert.match((await finish(revoked)).headers.get('location')!, /google_session|google_link_required/);
  const abandoned = await begin({ sub: '7003', email: 'abandoned@example.test' });
  failAuthorize = true;
  const before = seq;
  const failed = await app.request('/api/auth/google/start');
  failAuthorize = false;
  assert.match(failed.headers.get('location')!, /google_unavailable/);
  assert.equal(seq, before + 1, 'the provider created an authorization before the start failed');
  assert.equal(accounts.has(`ca_${before + 1}`), false, 'an authorization created before a failed start is removed at once');
  for (const a of [expired, revoked, abandoned]) assert.equal(authorizationsOf(a.provisional), 1, 'not yet swept');
  db.prepare("UPDATE google_oidc_attempts SET expires_at=? WHERE nonce IN ('composio-cleanup','composio-gmail')").run(now() - 1);
  await sweepGoogleLoginAuthorizations();
  for (const a of [expired, revoked, abandoned]) assert.equal(authorizationsOf(a.provisional), 0, 'swept');
  assert.equal(cleanupRows(), 0);
  assert.ok(authorizationsOf('usr_legacy') === 1 && accounts.has('ca_victim'), 'real accounts\' authorizations are never swept');
});

function deferred() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}
const cleanupRow = (state: string) => db.prepare('SELECT nonce,expires_at FROM google_oidc_attempts WHERE id=?').get(`cleanup:${state}`) as { nonce: string; expires_at: number } | undefined;
const expireCleanup = (state: string) => db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now() - 1, `cleanup:${state}`);

/** Actual cold startup, same disposable SQLite, entirely synthetic Composio SDK. No inherited module/timer state. */
function cleanupInColdProcess(a: { account: string; provisional: string; state: string }, failDelete = false) {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { setImmediate } from 'node:timers/promises';
    mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests'); });
    const fixture = JSON.parse(process.env.GOOGLE_CLEANUP_FIXTURE);
    const { db } = await import('./server/src/db.ts');
    const { composio } = await import('./server/src/composio.ts');
    const client = composio();
    let present = true, attempts = 0;
    mock.method(client.connectedAccounts, 'list', async input => ({ items: present && input.userIds.includes(fixture.provisional) ? [{ id: fixture.account }] : [], nextCursor: null }));
    mock.method(client.connectedAccounts, 'delete', async id => {
      assert.equal(id, fixture.account); attempts++;
      if (fixture.failDelete) throw new Error('Temporary provider failure');
      present = false;
    });
    mock.method(client, 'create', async () => { throw new Error('OIDC must not create a Gmail authorization'); });
    const { googleAuth } = await import('./server/src/auth/google.ts');
    // Startup itself must schedule/drain the old cleanup while OIDC is active.
    let row;
    for (let i = 0; i < 100; i++) {
      await setImmediate();
      row = db.prepare('SELECT nonce FROM google_oidc_attempts WHERE id=?').get('cleanup:' + fixture.state);
      if (attempts && (fixture.failDelete ? row?.nonce === 'composio-cleaning' : !row)) break;
    }
    assert.ok(attempts > 0);
    if (fixture.failDelete) assert.equal(row?.nonce, 'composio-cleaning');
    else { assert.equal(row, undefined); assert.equal(present, false); }
    const response = await googleAuth.request('https://swarm.test/start');
    assert.equal(new URL(response.headers.get('location')).hostname, 'accounts.google.com');
    await setImmediate();
    console.log(JSON.stringify({ attempts, deleted: !present, oidc: true }));
    db.close();
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GOOGLE_CLIENT_ID: 'synthetic-oidc', GOOGLE_CLIENT_SECRET: 'synthetic-secret', GOOGLE_CLEANUP_FIXTURE: JSON.stringify({ ...a, failDelete }) },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  if (result.deleted) accounts.delete(a.account);
  return result;
}

test('OIDC startup and runtime configuration changes keep draining earlier fallback authorizations', async () => {
  const runtime = await begin({ sub: '8001', email: 'runtime-oidc@example.test' });
  expireCleanup(runtime.state);
  process.env.GOOGLE_CLIENT_ID = 'synthetic-oidc'; process.env.GOOGLE_CLIENT_SECRET = 'synthetic-secret';
  try {
    await sweepGoogleLoginAuthorizations();
    assert.equal(authorizationsOf(runtime.provisional), 0);
    assert.equal(cleanupRow(runtime.state), undefined);
    const oidc = await app.request('/api/auth/google/start');
    assert.equal(new URL(oidc.headers.get('location')!).hostname, 'accounts.google.com');
  } finally { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; }
  const cold = await begin({ sub: '8002', email: 'cold-oidc@example.test' });
  expireCleanup(cold.state);
  assert.equal(cleanupInColdProcess(cold).deleted, true);
  assert.equal(authorizationsOf(cold.provisional), 0);
  assert.equal(cleanupRow(cold.state), undefined);
});

test('cleanup claims before provider waits and prevents an in-flight callback from promoting the provisional id', async () => {
  const a = await begin({ sub: '8101', email: 'cleanup-wins@example.test' });
  const identityStarted = deferred(), identity = deferred(), listingStarted = deferred(), listing = deferred();
  proxyHook = async input => { if (input.connectedAccountId === a.account) { identityStarted.open(); await identity.wait; } };
  const callback = finish(a);
  await identityStarted.wait;
  expireCleanup(a.state);
  let heldList = false;
  listHook = async input => { if (!heldList && input.userIds.includes(a.provisional)) { heldList = true; listingStarted.open(); await listing.wait; } };
  const sweep = sweepGoogleLoginAuthorizations();
  try {
    await listingStarted.wait;
    assert.equal(cleanupRow(a.state)?.nonce, 'composio-cleaning');
    identity.open();
    const response = await callback;
    assert.match(response.headers.get('location')!, /google_session/);
    assert.equal(sessionCookie(response), undefined);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(a.provisional), undefined);
    assert.equal(boundTo('8101'), undefined);
  } finally { identity.open(); listing.open(); proxyHook = undefined; listHook = undefined; await sweep; }
  assert.equal(authorizationsOf(a.provisional), 0);
  assert.equal(cleanupRow(a.state), undefined);
});

test('promotion wins against a stale sweep snapshot and preserves its real user authorization', async () => {
  const blocker = await begin({ sub: '8201', email: 'sweep-blocker@example.test' });
  const a = await begin({ sub: '8202', email: 'promotion-wins@example.test' });
  const listingStarted = deferred(), listing = deferred();
  const queried: string[] = [];
  expireCleanup(blocker.state); expireCleanup(a.state);
  listHook = async input => {
    queried.push(...input.userIds);
    if (input.userIds.includes(blocker.provisional)) { listingStarted.open(); await listing.wait; }
  };
  const sweep = sweepGoogleLoginAuthorizations();
  try {
    await listingStarted.wait;
    // The sweep already selected both cleanup rows, but has not claimed the second.
    const response = await finish(a);
    assert.equal(response.headers.get('location'), 'https://swarm.test/');
    assert.equal((await me(sessionCookie(response)!)).user.id, a.provisional);
    assert.equal(boundTo('8202'), a.provisional);
    assert.equal(cleanupRow(a.state), undefined);
  } finally { listing.open(); await sweep; listHook = undefined; }
  assert.equal(authorizationsOf(blocker.provisional), 0);
  assert.equal(authorizationsOf(a.provisional), 1);
  assert.equal(queried.includes(a.provisional), false, 'a stale snapshot must recheck the durable record before any provider list/delete');
});

test('a failed cleanup claim survives another process/restart and cannot reopen callback promotion', async () => {
  const a = await begin({ sub: '8301', email: 'restart-fence@example.test' });
  const identityStarted = deferred(), identity = deferred();
  proxyHook = async input => { if (input.connectedAccountId === a.account) { identityStarted.open(); await identity.wait; } };
  const callback = finish(a);
  await identityStarted.wait;
  expireCleanup(a.state);
  assert.equal(cleanupInColdProcess(a, true).deleted, false);
  assert.equal(cleanupRow(a.state)?.nonce, 'composio-cleaning');
  deleteHook = async () => { throw new Error('Provider still unavailable'); };
  try {
    identity.open();
    const response = await callback;
    assert.match(response.headers.get('location')!, /google_session/);
    assert.equal(sessionCookie(response), undefined);
    assert.equal(boundTo('8301'), undefined);
    assert.equal(cleanupRow(a.state)?.nonce, 'composio-cleaning');
  } finally { identity.open(); proxyHook = undefined; deleteHook = undefined; }
  expireCleanup(a.state);
  assert.equal(cleanupInColdProcess(a).deleted, true);
  assert.equal(cleanupRow(a.state), undefined);
  assert.equal(authorizationsOf(a.provisional), 0);
});

test('a late authorize response cannot reopen a cleanup claim or lose its eventual authorization', async () => {
  const authorizeStarted = deferred(), authorize = deferred();
  const before = seq;
  authorizeHook = async () => { authorizeStarted.open(); await authorize.wait; };
  const start = app.request('/api/auth/google/start');
  await authorizeStarted.wait;
  const row = db.prepare("SELECT id FROM google_oidc_attempts WHERE nonce='composio-cleanup' ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  const state = row.id.slice('cleanup:'.length);
  expireCleanup(state);
  await sweepGoogleLoginAuthorizations();
  assert.equal(cleanupRow(state)?.nonce, 'composio-cleaning', 'an empty provider list cannot discard a pending authorize reference');
  try {
    authorize.open();
    const response = await start;
    assert.match(response.headers.get('location')!, /google_unavailable/);
    assert.equal(accounts.has(`ca_${before + 1}`), false, 'the late-created authorization is removed after settlement');
    assert.equal(cleanupRow(state), undefined);
    assert.equal(db.prepare('SELECT 1 FROM google_oidc_attempts WHERE id=?').get(state), undefined);
  } finally { authorize.open(); authorizeHook = undefined; }
});

test('a rolled-back cleanup claim makes no provider calls and leaves promotion eligible', async () => {
  const a = await begin({ sub: '8401', email: 'claim-rollback@example.test' });
  assert.match(a.state, /^[A-Za-z0-9_-]+$/);
  expireCleanup(a.state);
  let listed = false;
  listHook = async input => { if (input.userIds.includes(a.provisional)) listed = true; };
  db.exec(`CREATE TEMP TRIGGER refuse_cleanup_claim BEFORE UPDATE OF nonce ON google_oidc_attempts
    WHEN OLD.id='cleanup:${a.state}' AND NEW.nonce='composio-cleaning'
    BEGIN SELECT RAISE(ABORT,'forced_cleanup_claim_failure'); END`);
  try {
    await assert.rejects(sweepGoogleLoginAuthorizations(), /forced_cleanup_claim_failure/);
    assert.equal(listed, false, 'provider cleanup starts only after the durable claim commits');
    assert.equal(cleanupRow(a.state)?.nonce, 'composio-cleanup');
  } finally { db.exec('DROP TRIGGER refuse_cleanup_claim'); listHook = undefined; }
  const response = await finish(a);
  assert.equal((await me(sessionCookie(response)!)).user.id, a.provisional);
  assert.equal(authorizationsOf(a.provisional), 1);
});

test('a failed promotion transaction rolls back user and binding before cleanup can run', async () => {
  const a = await begin({ sub: '8402', email: 'promotion-rollback@example.test' });
  assert.match(a.state, /^[A-Za-z0-9_-]+$/);
  db.exec(`CREATE TEMP TRIGGER refuse_promotion_commit BEFORE DELETE ON google_oidc_attempts
    WHEN OLD.id='cleanup:${a.state}' AND OLD.nonce='composio-cleanup'
    BEGIN SELECT RAISE(ABORT,'forced_promotion_commit_failure'); END`);
  try {
    const response = await finish(a);
    assert.match(response.headers.get('location')!, /google_invalid/);
    assert.equal(sessionCookie(response), undefined);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(a.provisional), undefined);
    assert.equal(boundTo('8402'), undefined);
    assert.equal(authorizationsOf(a.provisional), 0);
    assert.equal(cleanupRow(a.state), undefined);
  } finally { db.exec('DROP TRIGGER refuse_promotion_commit'); }
});
