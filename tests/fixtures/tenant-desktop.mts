// Real local WebSocket handler and HTTP readiness endpoint; all identities, SQLite and traffic are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const scenario = process.argv[2];
const standalone = scenario.startsWith('standalone-');
const provider = scenario.includes('cloudvm') ? 'cloudvm' : scenario === 'standalone-desktop' ? 'desktop' : 'local';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tenant-desktop-'));
const tenant = 'usr_fixturedesktop', generation = '7', token = 'fixture-host-boot-token';
for (const key of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'FLY_API_TOKEN', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'INKBOX_ADMIN_API_KEY', 'INKBOX_API_KEY', 'DIRECT_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'APPLE_PRIVATE_KEY', 'DEV_LOGIN']) delete process.env[key];
fs.writeFileSync(path.join(root, 'key'), randomBytes(32).toString('base64'), { mode: 0o600 });
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ tenantId: tenant, volumeId: 'vol-fixture' }));
fs.writeFileSync(path.join(root, 'desktop-token'), token, { mode: 0o600 });
Object.assign(process.env, {
  NODE_ENV: 'production', SWARM_ROLE: standalone ? 'standalone' : 'tenant', SWARM_TENANT_ID: tenant,
  SWARM_RUNTIME_GENERATION: generation, SWARM_VOLUME_ID: 'vol-fixture',
  TENANT_DATA_KEY_FILE: path.join(root, 'key'), TENANT_MANIFEST_FILE: path.join(root, 'manifest.json'),
  DB_PATH: path.join(root, 'fixture.db'), FILES_DIR: root, SESSION_SECRET: 'fixture-session-secret',
  COMPUTER_PROVIDER: provider, VM_DRIVER: 'fake', APP_URL: 'https://fixture.invalid', SERVER_URL: 'https://fixture.invalid',
});
if (scenario === 'tenant-cloudvm-refused') {
  try { await assert.rejects(import('../../server/src/db.js'), /Tenant desktops must use the local isolated companion/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`SCENARIO_PASS ${scenario}`);
  process.exit(0);
}
const { db } = await import('../../server/src/db.js');
const local = await import('../../server/src/computers/local.js');
const { sha256 } = await import('../../server/src/lib/ids.js');
const { setLocalAccess } = await import('../../server/src/computers/local-access.js');
const { tenantDesktopReadiness } = await import('../../server/src/computers/tenant-readiness.js');
const { confirmApplicationReady, reportApplicationRunning, desktopReady } = await import('../../server/src/runtime/application-readiness.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(tenant, 'fixture@example.invalid', 'Fixture', Date.now());
const addToken = (value: string, scope = 'default', owner = tenant) => db.prepare('INSERT INTO companion_tokens(token_hash,user_id,created_at,scope) VALUES (?,?,?,?)').run(sha256(value), owner, Date.now(), scope);
addToken(token);
const app = new Hono().get('/api/health', c => c.json({ ok: true }));
if (!standalone) app.route('/internal/desktop-ready', tenantDesktopReadiness(token));
else assert.throws(() => tenantDesktopReadiness(token), /identity missing/);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
local.attachCompanionSocket(server as any);
local.nativeLocal.attachCompanionSocket(server as any);
if (!server.listening) await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const sockets = new Set<WebSocket>();
let realCompanion: ChildProcess | undefined, realExit: Promise<unknown> | undefined;
const request: typeof fetch = (url, init) => fetch(new URL(new URL(String(url)).pathname, origin), init);
const transport = { request, pause: async () => {} };
let reports = 0, policyHook = async () => {}, desired: 'run' | 'hold' = 'run';
const application = { tenant, generation, desktopToken: token, database: process.env.DB_PATH!, activation: {
  async policy() { await policyHook(); return { tenant, generation, machine: 'fixture-machine', revision: '1', desired }; },
  async report(_policy: unknown, state: string) { assert.equal(state, 'running'); reports++; },
} };
const status = (value = token) => fetch(`${origin}/internal/desktop-ready`, { headers: { authorization: `Bearer ${value}` } });
async function waitReady(expected: boolean) {
  for (let i = 0; i < 100; i++) {
    const response = await status(); const body: any = await response.json();
    if (body.ready === expected) return;
    await delay(5);
  }
  throw Error(`Readiness did not become ${expected}`);
}
async function hello(value = token, mode = 'multi', device = false, extra = {}) {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/companion${device ? '/local' : ''}`);
  sockets.add(socket); await once(socket, 'open');
  const result = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Hello timed out')), 3000);
    socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
    socket.once('close', code => { clearTimeout(timer); resolve({ code }); });
  });
  socket.send(JSON.stringify({ type: 'hello', token: value, mode, desktop: device || mode === 'desktop', name: 'Fixture', platform: device ? 'darwin-arm64' : 'linux-x64', capabilities: { browser: true, shell: true }, ...extra }));
  return { socket, result: await result };
}
async function acknowledge(socket: WebSocket) {
  socket.send(JSON.stringify({ event: 'browsers', bots: [] }));
  await waitReady(true);
}
async function connected() {
  const c = await hello(); assert.equal(c.result.type, 'welcome'); assert.equal(c.result.mode, 'multi');
  await acknowledge(c.socket); return c.socket;
}
async function close(socket: WebSocket) {
  if (socket.readyState !== WebSocket.CLOSED) { const done = once(socket, 'close'); socket.terminate(); await done; }
}
try {
  switch (scenario) {
    case 'tenant-welcome': {
      assert.equal((await status('wrong')).status, 401);
      assert.equal((await status()).status, 503);
      const c = await hello(); assert.equal(c.result.type, 'welcome'); assert.equal(c.result.mode, 'multi');
      assert.equal((await status()).status, 503, 'hello/welcome queued is not the completed exchange');
      c.socket.send(JSON.stringify({ event: 'browsers', bots: [null] }));
      assert.equal((await status()).status, 503);
      await acknowledge(c.socket);
      const response = await status(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { ready: true, tenant, generation, mode: 'multi' }); break;
    }
    case 'tenant-invalid-token': {
      assert.equal((await hello('invalid')).result.code, 4401);
      addToken('native-only', 'native-local'); assert.equal((await hello('native-only')).result.code, 4401);
      assert.equal((await status()).status, 503); break;
    }
    case 'tenant-foreign-token': {
      // Even a corrupt/mis-imported token row cannot select a foreign owner.
      db.pragma('foreign_keys = OFF'); addToken('foreign-fixture-token', 'default', 'usr_foreignowner'); db.pragma('foreign_keys = ON');
      assert.equal((await hello('foreign-fixture-token')).result.code, 4401);
      assert.equal((await status()).status, 503); break;
    }
    case 'tenant-wrong-mode': {
      for (const mode of ['browser', 'desktop']) assert.equal((await hello(token, mode)).result.code, 4403);
      assert.equal((await status()).status, 503); break;
    }
    case 'tenant-disconnect': {
      await close(await connected()); await waitReady(false);
      const c = await hello(); assert.equal(c.result.mode, 'multi'); assert.equal((await status()).status, 503);
      await acknowledge(c.socket); break;
    }
    case 'tenant-replacement': {
      const previous = await connected(); const closed = once(previous, 'close');
      const next = await hello(); assert.equal(next.result.mode, 'multi'); assert.equal((await closed)[0], 4409);
      assert.equal((await status()).status, 503, 'replacement cannot inherit the old acknowledgement');
      await acknowledge(next.socket); break;
    }
    case 'tenant-revocation': {
      const c = await connected(); db.prepare('DELETE FROM companion_tokens WHERE token_hash=?').run(sha256(token));
      assert.equal((await status()).status, 503, 'deleted token cannot leave readiness true');
      await close(c); addToken(token); await connected(); local.revokePairings(tenant); assert.equal((await status()).status, 503); break;
    }
    case 'tenant-other-pairing': {
      addToken('another-pairing'); const c = await hello('another-pairing'); assert.equal(c.result.mode, 'multi');
      c.socket.send(JSON.stringify({ event: 'browsers', bots: [] }));
      assert.equal((await status('another-pairing')).status, 401); assert.equal((await status()).status, 503); break;
    }
    case 'tenant-native-mac': {
      addToken('mac-token', 'native-local'); assert.equal((await hello('mac-token', 'desktop', true)).result.code, 4401);
      setLocalAccess(tenant, true);
      assert.equal((await hello('mac-token', 'multi', true)).result.code, 4403);
      assert.equal((await hello('mac-token', 'desktop', true, { platform: 'linux' })).result.code, 4403);
      const c = await hello('mac-token', 'desktop', true); assert.equal(c.result.mode, 'desktop');
      c.socket.send(JSON.stringify({ event: 'browsers', bots: [] })); assert.equal((await status()).status, 503);
      await connected(); setLocalAccess(tenant, false); local.nativeLocal.dropCompanion(tenant, 'fixture consent revoked');
      assert.equal((await status()).status, 200, 'Mac revocation does not remove the isolated companion'); break;
    }
    case 'tenant-real-companion': {
      const script = fileURLToPath(new URL('../../companion/swarm-companion.mjs', import.meta.url));
      // No browser is opened in this protocol test; the unused executable avoids a CI Chrome dependency.
      realCompanion = spawn(process.execPath, [script, '--server', origin, '--token-file', path.join(root, 'desktop-token'), '--multi', '--chrome', '/bin/true', '--agent-home', root, '--data-dir', path.join(root, 'companion')], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      realExit = once(realCompanion, 'exit'); let output = '';
      realCompanion.stdout!.on('data', b => { output += b; }); realCompanion.stderr!.on('data', b => { output += b; });
      try { await waitReady(true); } catch (error) { throw Error(`${error}\n${output}`); }
      await confirmApplicationReady(application, transport); assert.equal(reports, 1);
      realCompanion.kill('SIGTERM'); await realExit; await waitReady(false); break;
    }
    case 'host-success': {
      await connected(); await confirmApplicationReady(application, transport); assert.equal(reports, 1);
      await reportApplicationRunning(application, transport); assert.equal(reports, 2); break;
    }
    case 'host-missing': {
      await assert.rejects(confirmApplicationReady(application, transport), /desktop companion readiness/); assert.equal(reports, 0); break;
    }
    case 'host-rejected': {
      assert.equal((await hello(token, 'browser')).result.code, 4403);
      await assert.rejects(confirmApplicationReady(application, transport), /desktop companion readiness/); assert.equal(reports, 0); break;
    }
    case 'host-disconnect-during-policy': {
      const socket = await connected(); policyHook = async () => { await close(socket); await waitReady(false); };
      await assert.rejects(confirmApplicationReady(application, transport), /desktop companion readiness/); assert.equal(reports, 0);
      policyHook = async () => {}; await connected(); await confirmApplicationReady(application, transport); assert.equal(reports, 1); break;
    }
    case 'host-policy-hold': {
      await connected(); desired = 'hold'; await assert.rejects(confirmApplicationReady(application, transport), /authorization changed/); assert.equal(reports, 0); break;
    }
    case 'host-database-owner': {
      await connected(); db.prepare('UPDATE tenant_identity SET tenant_id=?').run('usr_otherfixture');
      await assert.rejects(confirmApplicationReady(application, transport), /database owner mismatch/); assert.equal(reports, 0); break;
    }
    case 'host-backup-hold': {
      const socket = await connected(); let current = true;
      policyHook = async () => { current = false; await close(socket); };
      assert.equal(await reportApplicationRunning(application, transport, () => current), false); assert.equal(reports, 0);
      policyHook = async () => {}; await connected(); await confirmApplicationReady(application, transport); assert.equal(reports, 1); break;
    }
    case 'host-response-validation': {
      for (const body of [{ ready: true, tenant, generation: 'old', mode: 'multi' }, { ready: true, tenant: 'usr_foreignowner', generation, mode: 'multi' }, { ready: true, tenant, generation, mode: 'browser' }, { ready: false, tenant, generation, mode: 'multi' }]) {
        assert.equal(await desktopReady(application, { request: async () => Response.json(body) }), false);
      }
      for (const body of ['not json', 'x'.repeat(1025)]) assert.equal(await desktopReady(application, { request: async () => new Response(body) }), false);
      assert.equal(await desktopReady(application, { request: async () => { throw Error('request timeout'); } }), false); break;
    }
    case 'standalone-local': {
      assert.equal((await hello()).result.code, 4403); assert.equal((await hello(token, 'browser')).result.mode, 'browser'); break;
    }
    case 'standalone-desktop': {
      assert.equal((await hello()).result.code, 4403); assert.equal((await hello(token, 'browser')).result.code, 4403);
      assert.equal((await hello(token, 'desktop')).result.mode, 'desktop'); break;
    }
    case 'standalone-cloudvm': {
      assert.equal((await hello(token, 'browser')).result.code, 4403); assert.equal((await hello()).result.mode, 'multi'); break;
    }
    default: throw Error(`Unknown scenario ${scenario}`);
  }
  console.log(`SCENARIO_PASS ${scenario}`);
} finally {
  if (realCompanion && realCompanion.exitCode === null && realCompanion.signalCode === null) { realCompanion.kill('SIGTERM'); await realExit; }
  for (const socket of sockets) await close(socket);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}
