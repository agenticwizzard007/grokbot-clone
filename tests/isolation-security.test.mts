import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { generateKeyPair, SignJWT } from 'jose';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-security-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-isolation-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: 'unclaimed-admin@example.test', ADMIN_USER_IDS: '', GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-only' });
const { db, now } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js'); initSubagents();
const { initRooms } = await import('../server/src/agent/rooms.js'); initRooms();
const { createAccount, setEmail, deleteAccount, AccountAuthorizationChanged } = await import('../server/src/accounts.js');
const { createBot } = await import('../server/src/bots.js');
const { canManageServer } = await import('../server/src/settings.js');
const { createSession, userFromCookieHeader, userFromToken, sessionHash, requireUser, revokeSession } = await import('../server/src/lib/auth.js');
const { resolveGoogleAccount } = await import('../server/src/auth/google.js');
const { verifyGoogleIdentity } = await import('../server/src/auth/google-provider.js');
const { sealPrivate, openPrivate } = await import('../server/src/security/secrets.js');
const { publicAddress, publicHttpsUrl } = await import('../server/src/security/network.js');
const { saveMcpServer, getMcpServer, mcpForBot, mcpToolName } = await import('../server/src/mcp/store.js');
const { mcpApi } = await import('../server/src/mcp/routes.js');
const { runMcpTool, testMcpServer } = await import('../server/src/mcp/client.js');
for (const id of ['alice','bob']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, now());
const botA = createBot('alice', { name: 'A', isPrimary: true });
const botB = createBot('bob', { name: 'B', isPrimary: true });
const app = new Hono<any>();
app.get('/session/:id', c => { createSession(c, c.req.param('id')); return c.json({ ok: true }); });
app.route('/mcp', mcpApi);
app.use('/private/*', requireUser);
app.post('/private/write', c => c.json({ ok: true }));
const cookie = async (id: string) => (await app.request(`/session/${id}`)).headers.getSetCookie().find(v => v.startsWith('swarm_session=') && !v.includes('Max-Age=0'))!.split(';')[0];
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('unverified email cannot claim a login identity or grant admin', () => {
  assert.deepEqual(setEmail('alice', 'unclaimed-admin@example.test'), { ok: true });
  const row = db.prepare('SELECT * FROM users WHERE id=?').get('alice') as any;
  assert.equal(row.email, 'alice@example.test');
  assert.equal(row.pending_email, 'unclaimed-admin@example.test');
  assert.equal(canManageServer(row), false);
  const id = resolveGoogleAccount({ subject: 'verified-google-person', email: 'unclaimed-admin@example.test' });
  assert.notEqual(id, 'alice');
  assert.equal(canManageServer({ id, email: 'unclaimed-admin@example.test' }), false);
  assert.throws(() => createAccount({ email: 'alice@example.test' }), /link_required/);
  db.prepare("INSERT INTO account_roles VALUES(?,'admin')").run('bob');
  assert.equal(canManageServer({ id: 'bob', email: 'anything@example.test' }), true);
  assert.equal(canManageServer({ id: 'alice', email: 'bob@example.test' }), false);
});

test('Google identity checks signature, issuer, audience, nonce and verified email', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const sign = (claims: any) => new SignJWT({ sub: 'subject', email: 'person@example.test', email_verified: true, nonce: 'n', ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://accounts.google.com').setAudience('test-google-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal((await verifyGoogleIdentity(await sign({}), 'n', async () => publicKey)).subject, 'subject');
  for (const claims of [{ nonce: 'wrong' }, { email_verified: false }, { sub: '' }]) await assert.rejects(verifyGoogleIdentity(await sign(claims), 'n', async () => publicKey));
  const { publicKey: wrong } = await generateKeyPair('RS256');
  await assert.rejects(verifyGoogleIdentity(await sign({}), 'n', async () => wrong));
});

test('sessions store only hashes and enforce idle expiry, revocation and CSRF', async () => {
  const auth = await cookie('alice');
  const raw = auth.split('=')[1];
  assert.equal(userFromCookieHeader(auth)?.id, 'alice');
  assert.equal(db.prepare('SELECT 1 FROM auth_sessions WHERE token=?').get(raw), undefined);
  assert.ok(db.prepare('SELECT 1 FROM auth_sessions WHERE token=?').get(sessionHash(raw)));
  assert.equal((await app.request('/private/write', { method: 'POST', headers: { cookie: auth, origin: 'https://attacker.test' } })).status, 403);
  db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token=?').run(now() - 25 * 3600_000, sessionHash(raw));
  assert.equal(userFromToken(raw), null);
  db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run('alice');
  assert.equal(userFromCookieHeader(auth), null);
});

test('encrypted credentials cannot be transplanted between owners or connections', () => {
  const sealed = sealPrivate('alice', 'mcp:a', { token: 'do-not-share' });
  assert.ok(!sealed.includes('do-not-share'));
  assert.deepEqual(openPrivate('alice','mcp:a',sealed), { token: 'do-not-share' });
  assert.throws(() => openPrivate('bob','mcp:a',sealed));
  assert.throws(() => openPrivate('alice','mcp:b',sealed));
  assert.throws(() => openPrivate('alice','mcp:a',sealed.slice(0,-5)+'AAAAA'));
});

test('network policy blocks private, mapped, metadata and non-HTTPS endpoints', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','0.0.0.0','::1','fd00::1','::ffff:127.0.0.1','224.0.0.1']) assert.equal(publicAddress(ip), false, ip);
  for (const url of ['http://public.example','https://127.0.0.1','https://[::ffff:127.0.0.1]','https://x.internal','https://user:pass@example.com']) assert.throws(() => publicHttpsUrl(url), url);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicHttpsUrl('https://mcp.example.com').protocol, 'https:');
});

test('MCP ownership covers listing, testing, editing, execution and deletion with known IDs', async () => {
  const server = saveMcpServer('alice', { name: 'Private', transport: 'http', url: 'https://mcp.example.test', bearerToken: 'alice-only' });
  assert.deepEqual(server.config.botIds, []);
  assert.deepEqual(mcpForBot('alice', botA.id), []);
  assert.ok(!(db.prepare('SELECT config FROM mcp_servers WHERE id=?').get(server.id) as any).config.includes('alice-only'));
  const auth = await cookie('bob');
  const headers = { cookie: auth, 'content-type': 'application/json' };
  for (const [method, route] of [['POST',`/${server.id}/test`],['PATCH',`/${server.id}`],['DELETE',`/${server.id}`]]) {
    assert.equal((await app.request(`/mcp${route}`, { method, headers, body: '{}' })).status, 404);
  }
  assert.deepEqual((await (await app.request('/mcp', { headers })).json() as any).servers, []);
  assert.equal(getMcpServer('bob', server.id), undefined);
  await assert.rejects(runMcpTool('bob', botB.id, mcpToolName(server,'tool'), {}));
  assert.throws(() => saveMcpServer('alice', { botIds: [botB.id] }, server), /own team/);
  const updated = saveMcpServer('alice', { botIds: [botA.id] }, server);
  assert.ok(updated.revision > server.revision);
});

test('local MCP never falls back to executing a command on the shared server', async () => {
  const marker = path.join(root, 'should-not-exist');
  const server = saveMcpServer('alice', { name: 'Untrusted', transport: 'stdio', command: '/bin/touch', args: [marker], botIds: [botA.id] });
  assert.match((await testMcpServer(server))!.error!, /isolated|Isolated/);
  assert.equal(fs.existsSync(marker), false);
});

test('account deletion rechecks the live authorization after waiting for the CLI mutation lock',async()=>{
  const {withCliMutation}=await import('../server/src/cli/lock.js');
  const auth=await cookie('alice'),raw=auth.split('=')[1];
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});
  const held=withCliMutation('alice',async()=>{entered();await new Promise<void>(r=>{release=r;});});
  await ready;
  const pending=deleteAccount('alice',()=>{if(userFromToken(raw)?.id!=='alice')throw new AccountAuthorizationChanged();});
  revokeSession(sessionHash(raw));release();await held;
  await assert.rejects(pending,AccountAuthorizationChanged);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get('alice'));
  assert.ok(db.prepare('SELECT 1 FROM bots WHERE id=?').get(botA.id));
});
