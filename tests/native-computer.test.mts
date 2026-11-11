import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-computer-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: root, SESSION_SECRET: 'native-computer-test', COMPUTER_PROVIDER: 'cloudvm', VM_DRIVER: 'fake', SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test' });
const { db } = await import('../server/src/db.js');
const { createSession } = await import('../server/src/lib/auth.js');
const { sha256 } = await import('../server/src/lib/ids.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { localAccess, setLocalAccess } = await import('../server/src/computers/local-access.js');
const { attachComputerSockets, computers } = await import('../server/src/computers/index.js');
const { createPairing, companionConnected, localProvider, nativeLocal } = await import('../server/src/computers/local.js');
const { localComputerApi } = await import('../server/src/computers/local-routes.js');
const { setLive } = await import('../server/src/store.js');
const { functionSchemas } = await import('../server/src/agent/tools.js');

for (const id of ['a', 'b']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(`bot-${id}`, id, id, Date.now(), Date.now());
}
const app = new Hono();
app.get('/session/:id', c => { createSession(c, c.req.param('id')); return c.json({ ok: true }); });
app.route('/api/computer/local', localComputerApi);
const sessionResponse = await app.request('/session/a');
const cookie = sessionResponse.headers.getSetCookie().find(value => /swarm_session=[^;]/.test(value))!.split(';')[0];
const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`/api/computer/local${url}`, {
  method, headers: { cookie, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const pair = async () => {
  const r = await request('/pair', 'POST', { desktop: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  return (await r.json()).token as string;
};
const server = http.createServer();
attachComputerSockets(server);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const origin = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
const sockets = new Set<WebSocket>();
async function handshake(token: string, device = true, extra = {}) {
  const ws = new WebSocket(`${origin}/api/companion${device ? '/local' : ''}`);
  sockets.add(ws);
  await once(ws, 'open');
  const result = new Promise<any>(resolve => {
    ws.once('message', data => resolve(JSON.parse(String(data))));
    ws.once('close', code => resolve({ code }));
  });
  ws.send(JSON.stringify({ type: 'hello', token, name: device ? 'My Mac' : 'VM', platform: device ? 'darwin-arm64' : 'linux', desktop: device, mode: device ? 'desktop' : 'multi', capabilities: { browser: true, shell: true }, ...extra }));
  return { ws, result: await result };
}
async function connect(token: string, device = true) {
  const c = await handshake(token, device);
  assert.equal(c.result.type, 'welcome');
  const requests: any[] = [];
  let answer = true;
  c.ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    requests.push(msg);
    if (msg.id && answer) c.ws.send(JSON.stringify({ id: msg.id, result: msg.method === 'shell' ? { exit_code: 0, output: device ? 'mac' : 'vm' } : msg.method === 'browser' ? { content: [{ type: 'text', text: device ? 'mac-browser' : 'vm-browser' }], isError: false } : { data: '/9j/2Q==', width: 10, height: 10 } }));
  });
  return { ...c, requests, pause: () => { answer = false; } };
}
after(async () => {
  await Promise.all([...sockets].filter(ws => ws.readyState !== WebSocket.CLOSED).map(async ws => { const closed = once(ws, 'close'); ws.terminate(); await closed; }));
  await new Promise(r => setTimeout(r, 30));
  await new Promise<void>(r => server.close(() => r()));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('native pairing authenticates the user, requires explicit consent and rejects cross-site requests', async () => {
  assert.equal((await app.request('/api/computer/local')).status, 401);
  for (const body of [undefined, null, {}, { desktop: false }, { desktop: 'true' }]) assert.equal((await request('/pair', 'POST', body)).status, 400);
  assert.equal((await request('/pair', 'POST', { desktop: true }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('', 'DELETE', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(localAccess('a').enabled, false);
  setLive('bot-a', { isRunning: true });
  assert.equal((await request('/pair', 'POST', { desktop: true })).status, 409);
  setLive('bot-a', { isRunning: false });
});

test('local selection and tool metadata follow the bot owner, independent of concurrent users', async () => {
  await pair();
  assert.equal(computers.state('a').provider, 'local');
  assert.equal(computers.state('b').provider, 'cloudvm');
  await assert.rejects(computers.ensure('a'), /Mac is offline/);
  const values = await Promise.all([
    withUsage({ userId: 'b', botId: 'bot-a' }, async () => {
      await new Promise(r => setTimeout(r, 10));
      assert.equal(computers.kind, 'local');
      assert.match(computers.promptLine, /real computer/);
      const schemas = functionSchemas('bot-a');
      assert.ok(schemas.some((s: any) => s.name === 'shell'));
      assert.ok(schemas.some((s: any) => s.name === 'browser_navigate'));
      return computers.kind;
    }),
    withUsage({ userId: 'a', botId: 'bot-b' }, async () => { await Promise.resolve(); return computers.kind; }),
  ]);
  assert.deepEqual(values, ['local', 'cloudvm']);
});

test('Mac and VM connections coexist; terminal, browser and screenshot RPC go to the selected Mac', async () => {
  const vm = await connect(createPairing('a', 'vm-a'), false);
  const mac = await connect(await pair());
  assert.equal(companionConnected('a'), true);
  assert.equal(nativeLocal.companionConnected('a'), true);
  const screen = await computers.screen('a', 'bot-a');
  assert.equal((await screen.shell!('pwd', 5)).output, 'mac');
  assert.match(JSON.stringify(await screen.browser!('browser_tabs', { action: 'list' })), /mac-browser/);
  await screen.screenshot();
  assert.deepEqual(mac.requests.map(m => m.method), ['shell', 'browser', 'screenshot']);
  assert.equal(vm.requests.length, 0);
  assert.equal((await (await localProvider.screen('a', 'bot-a')).shell!('pwd', 5)).output, 'vm');
  const status = await (await request('')).json();
  assert.deepEqual(status, { enabled: true, paired: true, connected: true, device: { name: 'My Mac', platform: 'darwin-arm64' }, desktop: true, browser: true });
});

test('token scopes, desktop mode and initial expiration are enforced', async () => {
  const native = await pair();
  assert.equal((await handshake(native, false)).result.code, 4401);
  assert.equal((await handshake(createPairing('a'), true)).result.code, 4401);
  assert.equal((await handshake(native, true, { mode: 'multi' })).result.code, 4403);
  assert.equal((await handshake(native, true, { desktop: false })).result.code, 4403);
  db.prepare('UPDATE companion_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, sha256(native));
  assert.equal((await handshake(native)).result.code, 4401);
  const accepted = await pair();
  await connect(accepted);
  assert.equal((db.prepare('SELECT expires_at FROM companion_tokens WHERE token_hash=?').get(sha256(accepted)) as any).expires_at, null);
});

test('rotation and revocation fail closed immediately without revoking cloud credentials', async () => {
  const old = await pair();
  const mac = await connect(old);
  const screen = await computers.screen('a', 'bot-a');
  const cloudCount = (db.prepare("SELECT COUNT(*) n FROM companion_tokens WHERE user_id='a' AND scope='default'").get() as any).n;
  const replacement = await pair();
  await assert.rejects(async () => screen.shell!('should not run', 5), /changed|offline/);
  assert.equal((await handshake(old)).result.code, 4401);
  const next = await connect(replacement);
  const stale = await computers.screen('a', 'bot-a');
  next.pause();
  const pending = stale.shell!('pending', 5);
  const rejected = assert.rejects(pending, /disconnected|revoked/);
  const r = await request('', 'DELETE');
  assert.equal(r.status, 200);
  await rejected;
  assert.equal(nativeLocal.companionConnected('a'), false);
  assert.equal(computers.state('a').provider, 'cloudvm');
  await assert.rejects(async () => stale.shell!('should not run', 5), /changed/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM companion_tokens WHERE user_id='a' AND scope='default'").get() as any).n, cloudCount);
  assert.equal(companionConnected('a'), true);
  assert.equal(mac.requests.length, 0);
});

test('disconnect stays selected and an old running turn cannot switch to cloud after revoke', async () => {
  const mac = await connect(await pair());
  const closed = once(mac.ws, 'close'); mac.ws.close(); await closed;
  assert.equal(localAccess('a').enabled, true);
  assert.equal(computers.state('a').status, 'absent');
  await assert.rejects(computers.screen('a', 'bot-a'), /Mac is offline/);
  await withUsage({ botId: 'bot-a' }, async () => {
    setLocalAccess('a', false);
    await assert.rejects(computers.screen('a', 'bot-a'), /selected computer changed/);
    assert.throws(() => computers.capabilities, /selected computer changed/);
    setLocalAccess('a', true);
    await assert.rejects(computers.screen('a', 'bot-a'), /selected computer changed/);
  });
});

test('viewer access still checks the signed-in bot owner', async () => {
  const ws = new WebSocket(`${origin}/api/bots/bot-b/screen`, { headers: { cookie } });
  const status = await new Promise<number>(resolve => { ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.destroy(); }); ws.on('error', () => {}); });
  assert.equal(status, 401);
  ws.terminate();
});

test('resuming a paused approval never replays old actions on a newly selected computer', async () => {
  const { resolveApproval, runInBotQueue } = await import('../server/src/agent/loop.js');
  const { appendRow, listRows } = await import('../server/src/store.js');
  const vm = await connect(createPairing('a'), false);
  for (const fromMac of [true, false]) {
    setLocalAccess('a', fromMac);
    const revision = localAccess('a').revision;
    const approvalId = `approval-${revision}`;
    const row = appendRow('bot-a', 'tool-call', { type: 'tool-call', callId: approvalId, name: 'shell', label: 'Shell', status: 'running', args: { command: 'must never execute' } });
    const card = appendRow('bot-a', 'card', { type: 'card', card: 'approval', approvalId, status: 'pending', title: 'Approval', tool: 'shell' } as any);
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, 'bot-a', card.seq, approvalId, 'shell', 'pending', Date.now());
    db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES (?,?)').run('bot-a', JSON.stringify({ computerRevision: revision, calls: [{ call_id: approvalId, name: 'shell', arguments: JSON.stringify({ command: 'must never execute' }), rowSeq: row.seq }], outputs: [], approvalId, depth: 0 }));
    setLocalAccess('a', !fromMac);
    resolveApproval('a', approvalId, 'allow');
    await runInBotQueue('bot-a', async () => {});
    assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get('bot-a'), undefined);
    assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId) as any).status, 'expired');
    assert.equal(vm.requests.length, 0);
    assert.ok(listRows('bot-a').some(r => r.body.type === 'notice' && /selected computer changed/.test(r.body.text)));
  }
});

test('the full authenticated config router exposes native status without legacy pairing commands', async () => {
  const { configApi } = await import('../server/src/routes-config.js');
  const mounted = new Hono().route('/api', configApi);
  const headers = { cookie };
  const native = await mounted.request('/api/computer/local', { headers });
  assert.equal(native.status, 200);
  assert.equal((await native.json()).enabled, true);
  const details = await (await mounted.request('/api/computer/details', { headers })).json();
  assert.equal(details.computer.provider, 'local');
  assert.equal(details.localComputer.enabled, true);
  assert.equal(details.pairing, null);
  assert.equal(details.thisComputer, null);
  assert.equal((await mounted.request('/api/computer/pair', { method: 'POST', headers })).status, 409);
});
